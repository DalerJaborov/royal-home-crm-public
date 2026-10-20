import { prisma } from "../db.js";
import { sendPushToAgents } from "../push.js";
import { createNotifications, shouldAlert } from "./notifications.js";
import { isWithinAlarmHours } from "./workingHours.js";
import { loadWorkWindow, outagesBetween, workingOutageMs } from "./stationOutage.js";
import { checkClientExplainedPause } from "../ai/offCrmPauseCheck.js";

/**
 * АЛАРМ ДИРЕКТОРУ «ПРОДАВЕЦ БЕЗ ОБЪЕКТА ПОСЛЕ СЪЁМКИ» (требование 7, аудит 02.09.2026,
 * docs/audit-02-09-2026/03-alarms.md §6.1 пункт B).
 *
 * Проблема: существующий антифрод `sellerPropertyMissingAntifraud.ts` считает срок
 * от `propertyAcceptedAt` (исход звонка PROPERTY_ACCEPTED), а не от даты фактической
 * съёмки/встречи с продавцом. Владелец просил считать именно от встречи: «объект не
 * добавлен через 2-3 дня после договорённой съёмки». Также старый пуш уходит всем с
 * правом `clients.assign`, а не лично директору.
 *
 * Этот модуль — ДОПОЛНИТЕЛЬНЫЙ сигнал, не замена старого антифрода:
 *   - Точка отсчёта: последняя проведённая встреча продавца (Interaction.type=MEETING,
 *     outcome=SELLER_MEETING, declinedAt=null, completedAt IS NOT NULL). Если такой нет —
 *     fallback к propertyAcceptedAt (старая логика, чтобы не потерять продавцов, у которых
 *     встреча не была зафиксирована отдельно). Продавец БЕЗ propertyAcceptedAt, но с
 *     проведённой встречей — тоже кандидат (ревью 03.09: фильтр по propertyAcceptedAt
 *     в выборке делал всю «точку отсчёта от встречи» мёртвой).
 *   - Условие: прошло >= ALARM_DAYS дней, а Property с sellerClientId = client.id нет.
 *   - Фильтр: Royal Score (aiScore) >= Settings.hotScoreThreshold, статус ACTIVE/kind=SELLER.
 *   - Получатель: только DIRECTOR (по роли, не по праву).
 *   - Дедуп: tag `alarm-seller-no-prop-{clientId}` — createNotification схлопывает
 *     повторные события с тем же (agentId, tag) в одну строку ленты (count++), но это
 *     не ограничивает частоту саму по себе (count просто считает тики) — от повторной
 *     ЗАПИСИ на каждый час-тик защищает shouldAlert (notifications.ts, владелец
 *     15.09.2026): не чаще раза в сутки на один и тот же tag.
 *
 * НЕ ТРОГАЕМ: buyerNoCallAlarm.ts (требование 6, параллельный агент),
 * sellerPropertyMissingAntifraud.ts (старый антифрод остаётся для эскалации в СБ).
 */

/**
 * ТРИ ПРАВКИ 09.09.2026 (решения владельца, docs/put-prodavca.html §8).
 *
 * 1. ТОЧКА ОТСЧЁТА — ТА, ЧТО РЕАЛЬНО ПИШЕТ ИИ. Раньше искалась запись типа MEETING
 *    с проставленным completedAt. Такие записи создавало ТОЛЬКО всплывающее окно
 *    (routes/me.ts), а окна выключены — значит этот якорь больше не наполняется
 *    ничем, и тревога молча падала на более поздний propertyAcceptedAt. Продавец,
 *    с которым только договорились приехать снимать, не покрывался вовсе.
 *    Теперь читаем исход SELLER_MEETING с датой ТАМ, ГДЕ ЕГО СТАВИТ ИИ, —
 *    на записи звонка (lib/aiCallOutcome.ts пишет nextActionDate = услышанная дата).
 *
 * 2. ВСЕ ПРОДАВЦЫ, А НЕ ТОЛЬКО «ГОРЯЧИЕ». Фильтр `aiScore >= hotScoreThreshold`
 *    ставил контроль за агентом в зависимость от оценки, которую ИИ дал КЛИЕНТУ.
 *    Продавец с низкой оценкой — как раз тот, кого удобнее всего забросить.
 *
 * 3. ЛЕСЕНКА ПЕРЕД ТЕМ, КАК БУДИТЬ ВЛАДЕЛЬЦА (владелец 09.09.2026). Тревога уходит
 *    только тогда, когда агент перестал пытаться И объяснения нет. Сверху вниз:
 *      1) агент сдал фото и видео → объект ПРИНЯТ, тревоги нет;
 *      2) общение через CRM продолжается ПОСЛЕ назначенной даты — агент пишет или
 *         звонит, клиент отвечает — значит договариваются заново, ждём;
 *      3) клиент САМ объяснил паузу («приеду через неделю», «уехал», «заболел») —
 *         ИИ-проверка ai/offCrmPauseCheck.ts, та же, что у тревоги про обход CRM;
 *      4) ничего из этого — тревога.
 *    Дорогой вызов ИИ стоит последним и только по тем, кто прошёл все дешёвые
 *    проверки: таких единицы, бюджет не страдает.
 *
 * 4. «ОБЪЕКТ ЕСТЬ» = ОБЪЕКТ ДОШЁЛ ДО ОДОБРЕНИЯ, а не «в базе есть строка». Раньше
 *    тревога гасла от ЛЮБОЙ карточки объекта — ни статуса, ни фотографий не
 *    проверялось. Значит агент, не поехавший на съёмку, мог завести пустую
 *    карточку, и тревога замолкала навсегда: десять секунд работы закрывали весь
 *    контроль. Теперь объект считается принятым, когда материалы сданы — их либо
 *    есть, либо нет, пустым действием это не подделать.
 */
export const ALARM_DAYS = 2;
const ALARM_MS = ALARM_DAYS * 24 * 60 * 60 * 1000;
/** Насколько левее cutoff искать простои станции: больше недели простоя за один срок не бывает. */
const OUTAGE_LOOKBACK_MS = 7 * 24 * 60 * 60 * 1000;
/** Предохранитель по частоте (владелец 15.09.2026) — см. shouldAlert в notifications.ts. */
const ALERT_MIN_INTERVAL_MS = 24 * 60 * 60 * 1000;

/**
 * Статусы, в которых объект ЕЩЁ НЕ ПРИНЯТ: агент завёл карточку, но материалов не
 * сдал. `PENDING_REVIEW` сюда не входит — в него объект попадает ровно тогда, когда
 * фото и видео ушли владельцу на одобрение.
 */
const NOT_YET_ACCEPTED_STATUSES = ["AWAITING_PHOTOS", "AWAITING_VIDEO"] as const;

interface Candidate {
  id: string;
  shortId: number;
  fullName: string;
  aiScore: number | null;
  shootingDate: Date;
}

/**
 * Ступень 2 лесенки: разговор идёт дальше. Считаем по ДОКАЗАННЫМ следам — попытка
 * агента через CRM или сообщение самого клиента ПОСЛЕ назначенной даты приёмки.
 * Люди договариваются о новом времени, и будить владельца рано.
 */
function stillTalking(
  client: { lastAgentAttemptAt: Date | null; lastClientMessageAt: Date | null },
  shootingDate: Date
): boolean {
  const attempt = client.lastAgentAttemptAt;
  const message = client.lastClientMessageAt;
  return (attempt !== null && attempt > shootingDate) || (message !== null && message > shootingDate);
}

/**
 * КРОН-ТИК: продавцы ACTIVE + kind=SELLER + aiScore>=70 + прошло >=2 дней
 * после последней проведённой встречи (или propertyAcceptedAt как fallback),
 * а объект НЕ создан. Пуш директору с tag для дедупа.
 */
export async function runSellerNoPropertyAlarmTick(now: Date = new Date()): Promise<{ alerted: number }> {
  // Решение владельца 03.09.2026 («3б»), окно уточнено 07.09.2026 (Settings.alarmHours*,
  // отдельно от workHours*): пуш директору только в его часы алармов —
  // ночью тик молчит, утром первый же тик всё досчитает (дедуп по tag).
  if (!(await isWithinAlarmHours(now))) return { alerted: 0 };
  const cutoff = new Date(now.getTime() - ALARM_MS);

  const candidates = await prisma.client.findMany({
    where: {
      // dualIntent (владелец 06.09.2026, разбор слепых зон п.4): клиент мог сейчас
      // числиться покупателем (kind переключился на актуальную сторону), но всё
      // ещё продаёт свою квартиру — этот аларм обязан видеть его тоже, а не
      // только тех, у кого kind буквально SELLER прямо сейчас.
      OR: [{ kind: "SELLER" }, { dualIntent: true }],
      workStatus: "ACTIVE",
      deletedAt: null,
      status: { notIn: ["LOST", "ARCHIVED", "DEAL_CLOSED"] },
      assignedAgentId: { not: null },
    },
    select: {
      id: true,
      shortId: true,
      fullName: true,
      aiScore: true,
      propertyAcceptedAt: true,
      lastAgentAttemptAt: true,
      lastClientMessageAt: true,
    },
  });

  if (candidates.length === 0) return { alerted: 0 };

  const clientIds = candidates.map((c) => c.id);

  const [properties, meetings] = await Promise.all([
    /**
     * Объекты, которые УЖЕ ПРИНЯТЫ: карточка есть И материалы сданы. Пустая
     * карточка (`AWAITING_PHOTOS`/`AWAITING_VIDEO`) тревогу не гасит — иначе
     * агент закрывал бы весь контроль одним действием на десять секунд.
     */
    prisma.property.findMany({
      where: {
        sellerClientId: { in: clientIds },
        deletedAt: null,
        status: { notIn: [...NOT_YET_ACCEPTED_STATUSES] },
      },
      select: { sellerClientId: true },
    }),
    /**
     * Договорённость о приёмке — ЛЮБАЯ запись с исходом SELLER_MEETING и датой,
     * независимо от типа записи. ИИ ставит этот исход на запись ЗВОНКА и кладёт
     * услышанную дату в nextActionDate (lib/aiCallOutcome.ts); всплывающее окно
     * ставило его же на запись типа MEETING. Читаем оба, иначе якорь пустует.
     *
     * Отменённые (declinedAt) не в счёт: договорённость снята.
     */
    prisma.interaction.findMany({
      where: {
        clientId: { in: clientIds },
        outcome: "SELLER_MEETING",
        declinedAt: null,
        OR: [{ nextActionDate: { not: null } }, { completedAt: { not: null } }],
      },
      orderBy: { createdAt: "desc" },
      select: { clientId: true, completedAt: true, nextActionDate: true },
    }),
  ]);

  const hasProperty = new Set(properties.map((p) => p.sellerClientId));

  // Для каждого клиента берём самую свежую проведённую встречу.
  // meetings отсортированы по completedAt DESC, поэтому первая запись для clientId — самая свежая.
  const lastMeetingByClient = new Map<string, Date>();
  for (const m of meetings) {
    // Дата приёмки: услышанная ИИ (nextActionDate) либо отметка о проведённой
    // встрече. Берём САМУЮ ПОЗДНЮЮ по клиенту — перенос приёмки на более поздний
    // срок обязан отодвинуть и тревогу, иначе перенос сам её и вызовет.
    const at = m.nextActionDate ?? m.completedAt;
    if (!at) continue;
    const known = lastMeetingByClient.get(m.clientId);
    if (!known || at > known) lastMeetingByClient.set(m.clientId, at);
  }

  /**
   * ПРОСТОЙ СТАНЦИИ СДВИГАЕТ СРОК (дыра 4.2 карты решений). Ступень 2 ниже ищет
   * следы разговора, а главный след — звонок через АТС. Станция лежала день —
   * следов нет ни у кого, и тревога ушла бы разом по всем продавцам, с которыми
   * агенты работали как обычно. Список простоев берём ОДНИМ запросом на тик, а не
   * по клиенту: тот же приём, что с курсом в propertyMatchFilter.
   */
  // Простои грузим с запасом ДО cutoff: workingOutageMs считает от shootingDate, а
  // shootingDate пограничного клиента лежит левее cutoff ровно на сумму простоя
  // (CHANNEL-NEW-10) — окно [cutoff, now] терялось бы их.
  const [outages, workWindow] = await Promise.all([
    outagesBetween(new Date(cutoff.getTime() - OUTAGE_LOOKBACK_MS), now),
    loadWorkWindow(),
  ]);

  const toAlert: Candidate[] = [];
  for (const c of candidates) {
    if (hasProperty.has(c.id)) continue;

    // Точка отсчёта: последняя проведённая встреча, fallback — propertyAcceptedAt.
    // Ни того, ни другого — отсчитывать не от чего, продавец ещё не на этапе съёмки.
    const shootingDate = lastMeetingByClient.get(c.id) ?? c.propertyAcceptedAt;
    if (!shootingDate) continue;
    const downMs = workingOutageMs(shootingDate, now, outages, workWindow);
    // Простой ПРОДЛЕВАЕТ срок (cutoff уходит назад), а не сокращает: раньше стоял плюс,
    // и чем дольше станция лежала, тем раньше уходила критическая тревога (CHANNEL-NEW-10).
    if (shootingDate > new Date(cutoff.getTime() - downMs)) continue;

    // Ступень 2: общение через CRM продолжается после назначенной даты — ждём.
    if (stillTalking(c, shootingDate)) continue;

    toAlert.push({
      id: c.id,
      shortId: c.shortId,
      fullName: c.fullName,
      aiScore: c.aiScore,
      shootingDate,
    });
  }

  if (toAlert.length === 0) return { alerted: 0 };

  // Получатели: DIRECTOR и ADMIN по роли (не по праву clients.assign) — ADMIN
  // видит всё, что видит директор, для контроля, даже если это не его обязанность.
  const directorIds = (
    await prisma.agent.findMany({
      where: { role: { in: ["DIRECTOR", "ADMIN", "HEAD_OF_SALES"] }, isActive: true },
      select: { id: true },
    })
  ).map((d) => d.id);
  if (directorIds.length === 0) return { alerted: 0 };

  let alerted = 0;
  for (const c of toAlert) {
    const tag = `alarm-seller-no-prop-${c.id}`;
    // Предохранитель по частоте, ПЕРЕД дорогой ИИ-проверкой ниже: та же причина,
    // что в buyerNoCallAlarm.ts — без него часовой тик слал бы это же напоминание
    // директору каждый час, и ещё платил бы за ИИ-вызов на каждый такой тик.
    if (!(await shouldAlert(tag, ALERT_MIN_INTERVAL_MS, now))) continue;

    /**
     * СТУПЕНЬ 3 — ПОСЛЕДНЯЯ И САМАЯ ДОРОГАЯ. Клиент мог сам попросить подождать:
     * «приеду через неделю», «уехал», «заболел». Тогда тишина не вина агента, и
     * будить владельца не за что.
     *
     * Проверка стоит именно здесь, после всех дешёвых отсечек: до неё доходят
     * единицы карточек за тик, и вызов ИИ на каждую не бьёт по бюджету (та же
     * логика, что в lib/agentOffCrmAlarm.ts, откуда эта проверка и взята).
     */
    const pause = await checkClientExplainedPause(c.id);
    if (pause.explained) continue;

    const daysSince = Math.floor((now.getTime() - c.shootingDate.getTime()) / (24 * 60 * 60 * 1000));
    const payload = {
      title: `🏠 Продавец без объекта ${daysSince}+ дн: ${c.fullName}`,
      body: `Скоринг ${c.aiScore}, после съёмки прошло ${daysSince} дн — объект не добавлен`,
      url: `/clients/${c.shortId}`,
      tag,
      kind: "oversight" as const,
      // Срочное: встреча по приёмке прошла, объекта в CRM нет. Каждый день
      // молчания здесь — это день, за который квартиру мог принять кто-то другой.
      level: "CRITICAL" as const,
    };
    try {
      // Лента — await (по ней дедуп и её видят тесты); push — фоном, он эфемерен.
      // Тот же порядок, что в buyerNoCallAlarm.ts: sendPushToAgents пишет ленту
      // через void и к моменту возврата запись может ещё не существовать.
      await createNotifications(directorIds, payload);
      void sendPushToAgents(directorIds, payload).catch((err) => console.error("[alarm] seller-no-property push:", err));
      alerted++;
    } catch (err) {
      console.error("[alarm] seller-no-property notification:", err);
    }
  }
  return { alerted };
}

/**
 * АЛАРМ «ЗАЯВЛЕНО N, СДЕЛАНО M» (продавец и покупатель) переехал в
 * lib/clientPropertyCountAlarm.ts (владелец 07.09.2026: «пусть по одному
 * клиенту приходит один целый alarm, а не по отдельности») — там же теперь и
 * симметричная проверка для покупателя, объединённая в одно уведомление на
 * клиента вместо двух раздельных.
 */