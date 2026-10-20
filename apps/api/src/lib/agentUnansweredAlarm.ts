import { Prisma } from "../generated/prisma/client.js";
import { prisma } from "../db.js";
import { isWithinAlarmHours } from "./workingHours.js";
import { isAgentAbsent } from "./agentAvailability.js";
import { startOfWorkingDayAtOrAfter, workingDaysBetween, type DaysOffCalendar } from "./alarmCalendar.js";
import { calendarFor, loadCompanyDaysOff } from "./daysOffCalendar.js";
import { upsertAutoTask } from "./autoTasks.js";
import { reportCronRowError } from "./cronHeartbeat.js";

/**
 * «ПРОДАВЕЦ ПИШЕТ, А АГЕНТ НЕ ОТВЕЧАЕТ» (владелец 09.09.2026).
 *
 * ПОЧЕМУ ЭТОГО НЕ БЫЛО ВОВСЕ. Все контроли CRM считают от обязанности агента
 * ДЕЙСТВОВАТЬ и ни один — от его молчания в ответ. 15 минут на первый звонок,
 * просрочки конвейера, напоминания светофора — таймеры, которые запускает событие
 * ВНУТРИ CRM: принял лид, завёл объект, перевёл клиента в неактивные. Входящее
 * сообщение клиента такого таймера не запускало никогда: оно порождало пуш агенту,
 * и на этом всё. Защита от пачки сообщений живёт в памяти процесса и стирается при
 * перезапуске — то есть состояние по этому событию не хранилось намеренно, и
 * заметить, что на пуш никто не отреагировал, было некому.
 *
 * Ближайший похожий механизм (lib/agentOffCrmAlarm.ts) построен для другой цели: он
 * срабатывает, только если агент СНАЧАЛА спросил у клиента номер. Он ловит увод, а
 * не молчание. Светофор покрывает только неактивных — активный клиент, которому не
 * отвечают, проваливается между.
 *
 * ЧТО СРАВНИВАЕМ. Два признака, оба уже пишутся:
 *   `Client.lastClientMessageAt` — когда клиент писал САМ (любой канал);
 *   `Client.lastAgentAttemptAt`  — когда агент пытался связаться, и только
 *                                  доказанными действиями (звонок через АТС или
 *                                  собственное исходящее сообщение).
 * Ответ бота, автоматическое напоминание и ответ другого сотрудника от имени агента
 * попыткой не считаются — иначе тревога не сработала бы никогда.
 *
 * ПОРОГ ОДИН — ДВОЕ РАБОЧИХ СУТОК, И ДЛЯ ПРОДАВЦА, И ДЛЯ ПОКУПАТЕЛЯ (владелец
 * 16.09.2026, дословно): «Только в тех случаях, когда агент не отвечает продавцу
 * или покупателю двое суток, мне приходит уведомление, чтобы я его отчитал».
 *
 * Два изменения против прежней версии, и оба по прямому указанию:
 *
 *   ПОКУПАТЕЛЬ ТЕПЕРЬ ТОЖЕ. Раньше тревога смотрела только продавцов, и покупатель,
 *   которому не ответили, не замечался вообще никем — перекос, которого владелец не
 *   заказывал: он назвал обе стороны в одной фразе.
 *
 *   ОТСУТСТВИЕ БОЛЬШЕ НЕ УДЛИНЯЕТ СРОК. Было: на месте 1 день, в отпуске или на
 *   больничном 2. Стало двое суток всем. Отсутствие агента — не смягчающее
 *   обстоятельство для КЛИЕНТА: он про отпуск не знает и ждёт ответа ровно так же.
 *   Где сейчас агент, по-прежнему попадает в текст уведомления — владельцу это
 *   нужно, чтобы понять, ругать человека или искать замену.
 *
 * ПЕРЕДАЧИ ЗДЕСЬ НЕТ И НЕ БУДЕТ. Клиент остаётся у своего агента, владелец получает
 * уведомление со ссылкой, открывающей окно передачи. Автопередача «если владелец не
 * решил за сутки» существовала до 16.09.2026 и удалена целиком по его прямому
 * указанию: «Только я могу передавать продавца или покупателя. А не система».
 * Отнять карточку — решение о человеке, а не о записи в базе.
 */

/**
 * Двое рабочих суток — один порог на всех (владелец 16.09.2026). Выходные в счёт не
 * идут — общие (Настройки) и личные ЭТОГО агента (владелец 11.10.2026); пусто — считаем
 * каждый день. Календарь тревог, lib/alarmCalendar.ts.
 */
export const UNANSWERED_WORKING_DAYS = 2;

const DAY = 24 * 3600_000;

/** Где сейчас агент — попадает в текст уведомления, чтобы владелец понял срочность. */
type AgentWhere = "present" | "absent";

export interface UnansweredCandidate {
  clientId: string;
  shortId: number;
  fullName: string;
  status: string;
  workStatus: string;
  agentId: string;
  agentName: string;
  agentWhere: AgentWhere;
  /** Сколько рабочих дней прошло с сообщения клиента. */
  workingDaysSilent: number;
  /** Продавец или покупатель — от этого зависит текст уведомления. */
  clientKind: string;
  /** Есть ли у продавца объект в продаже — от этого зависит срочность. */
  objectOnSale: boolean;
  /**
   * Окно переписки WhatsApp/Instagram (24 ч с последнего входящего) закрыто —
   * агент физически не может написать в чат, только позвонить (Р-1, 17.09.2026,
   * `docs/audit/lead-ownership-17-09.md` §4). Признак — `lastClientMessageAt`
   * старше суток: то же поле, что уже используется для самого молчания, второй
   * запрос не нужен.
   */
  windowClosed: boolean;
}

/**
 * Чистое правило: пора ли будить владельца. Вынесено отдельно, чтобы пороги можно
 * было проверить тестом без базы.
 */
export function isUnanswered(input: {
  lastClientMessageAt: Date | null;
  lastAgentAttemptAt: Date | null;
  /**
   * Когда карточку получил НЫНЕШНИЙ агент. Отсчёт молчания начинается не раньше
   * этого момента.
   *
   * Без этого пола любая передача карточки мгновенно вешала бы на нового агента
   * молчание предшественника: он получает клиента и в ту же минуту становится
   * виноват в трёх днях тишины, к которым не имел отношения. А для второй
   * ступени, пока она существовала до 16.09.2026, это была ещё и вечная карусель — карточка
   * скакала бы от агента к агенту каждый час, и каждая передача выглядела бы
   * законной.
   */
  assignedAt?: Date | null;
  agentWhere: AgentWhere;
  now: Date;
  dayStartHHMM?: string;
  /** Выходные компании и агента карточки (11.10.2026). Не передан — выходных нет. */
  calendar?: DaysOffCalendar;
}): { unanswered: boolean; workingDaysSilent: number } {
  const msg = input.lastClientMessageAt;
  if (!msg) return { unanswered: false, workingDaysSilent: 0 };
  // Агент ответил ПОСЛЕ сообщения — вопрос закрыт, неважно в каком канале.
  if (input.lastAgentAttemptAt && input.lastAgentAttemptAt >= msg) {
    return { unanswered: false, workingDaysSilent: 0 };
  }
  // Позднее из двух: сообщение клиента и момент, когда карточка стала этого агента.
  const anchor = input.assignedAt && input.assignedAt > msg ? input.assignedAt : msg;
  const from = startOfWorkingDayAtOrAfter(anchor, input.dayStartHHMM, input.calendar);
  const days = workingDaysBetween(from, input.now, input.calendar);
  // Где агент — на срок больше не влияет (см. шапку): клиент про отпуск не знает.
  return { unanswered: days >= UNANSWERED_WORKING_DAYS, workingDaysSilent: days };
}

/** Объекты продавца, которые прямо сейчас продаются, — для срочности уведомления.
 *  У покупателя объектов нет, и множество для него просто пустое. */
async function sellersWithObjectOnSale(clientIds: string[]): Promise<Set<string>> {
  if (clientIds.length === 0) return new Set();
  const rows = await prisma.property.findMany({
    where: { sellerClientId: { in: clientIds }, deletedAt: null, status: { in: ["AVAILABLE", "RESERVED"] } },
    select: { sellerClientId: true },
    distinct: ["sellerClientId"],
  });
  return new Set(rows.map((r) => r.sellerClientId).filter((v): v is string => v !== null));
}

/**
 * Собрать список клиентов — продавцов и покупателей, — чьё сообщение осталось без
 * ответа. Отдельно от рассылки,
 * чтобы дашборд владельца мог показать тот же список, не дублируя правило.
 */
export async function findUnansweredClients(now: Date = new Date()): Promise<UnansweredCandidate[]> {
  const settings = await prisma.settings.findUnique({
    where: { id: "singleton" },
    select: { workHoursStart: true },
  });
  const dayStart = settings?.workHoursStart ?? "09:30";

  /**
   * «НЕТ ОТВЕТА ПОСЛЕ ПОСЛЕДНЕГО СООБЩЕНИЯ КЛИЕНТА» — В САМОМ ЗАПРОСЕ (ночная
   * проверка 24.09.2026, находка №2). Раньше выборка брала ВСЕХ писавших
   * клиентов с агентом (`take: 300`, без `orderBy` — Prisma сортирует по `id`,
   * а это uuid), а «ответил ли агент» решала уже в JS. При >300 карточек под
   * условием срез был случайным по составу, но одним и тем же на каждом тике:
   * одни и те же 300 карточек проверялись, остальные — никогда. Prisma не
   * умеет сравнить две колонки между собой, поэтому идентификаторы берём
   * сырым SQL: `lastAgentAttemptAt` пуст или раньше `lastClientMessageAt` —
   * ровно то, что дальше проверяет `isUnanswered`. Потолка нет намеренно: под
   * условие теперь попадают только действительно неотвеченные, их столько,
   * сколько тревог, и каждая обязана дойти до владельца. Отсечка «сообщение
   * старше суток» — грубый предфильтр: двое рабочих суток заведомо длиннее.
   *
   * ПРОДАВЕЦ И ПОКУПАТЕЛЬ ОДИНАКОВО (владелец 16.09.2026). В любом состоянии:
   * активный, неактивный, с закрытой сделкой — разница только в срочности
   * уведомления, а не в самом факте. Исключено «Прочее обращение»: оно агенту
   * не назначается, спрашивать не с кого.
   *
   * ТОЛЬКО ПРИНЯТЫЕ (№142 ночной проверки 24.09): до принятия переписка агенту
   * закрыта (ownChatClientWhere в lib/chatScope.ts — то же условие), ответить
   * он не может, а непринятым лидом занимаются лесенка назначения и эскалация.
   * Старые карточки не выпадают: миграция 20260710183343 проставила
   * `acceptedAt` всем, кто был до неё, и каждый путь принятия ставит его сам.
   */
  const staleSince = new Date(now.getTime() - DAY);
  const unansweredRows = await prisma.$queryRaw<{ id: string }[]>(Prisma.sql`
    SELECT "id" FROM "Client"
    WHERE "kind" <> 'OTHER'
      AND "deletedAt" IS NULL
      AND "assignedAgentId" IS NOT NULL
      AND "acceptedAt" IS NOT NULL
      AND "lastClientMessageAt" IS NOT NULL
      AND "lastClientMessageAt" < ${staleSince}
      AND ("lastAgentAttemptAt" IS NULL OR "lastAgentAttemptAt" < "lastClientMessageAt")
      AND "status" <> 'ARCHIVED'
    ORDER BY "lastClientMessageAt" ASC, "id" ASC
  `);
  if (unansweredRows.length === 0) return [];

  const select = {
    id: true,
    shortId: true,
    fullName: true,
    kind: true,
    status: true,
    workStatus: true,
    lastClientMessageAt: true,
    lastAgentAttemptAt: true,
    assignedAt: true,
    assignedAgentId: true,
    assignedAgent: { select: { id: true, fullName: true, weeklyDaysOff: true } },
  } as const;
  // Поля — пачками по 300 идентификаторов, чтобы один `IN` не разрастался без меры.
  const candidates: Prisma.ClientGetPayload<{ select: typeof select }>[] = [];
  for (let i = 0; i < unansweredRows.length; i += 300) {
    const ids = unansweredRows.slice(i, i + 300).map((r) => r.id);
    candidates.push(...(await prisma.client.findMany({ where: { id: { in: ids } }, select })));
  }
  // Порядок сырого запроса (старые сообщения первыми) — `IN` его не сохраняет.
  const order = new Map(unansweredRows.map((r, idx) => [r.id, idx]));
  candidates.sort((a, b) => (order.get(a.id) ?? 0) - (order.get(b.id) ?? 0));

  // Где агенты — одним запросом на всех, а не по одному в цикле (N+1 по списку из БД
  // прямо запрещён регламентом проекта).
  const agentIds = [...new Set(candidates.map((c) => c.assignedAgentId!))];
  const absent = new Set<string>();
  for (const id of agentIds) {
    if (await isAgentAbsent(id)) absent.add(id);
  }

  const onSale = await sellersWithObjectOnSale(candidates.map((c) => c.id));
  // Выходные — одним чтением на тик; личные — из уже выбранного агента (без N+1).
  const companyDaysOff = await loadCompanyDaysOff();

  const out: UnansweredCandidate[] = [];
  for (const c of candidates) {
    const agentWhere: AgentWhere = absent.has(c.assignedAgentId!) ? "absent" : "present";
    const verdict = isUnanswered({
      lastClientMessageAt: c.lastClientMessageAt,
      lastAgentAttemptAt: c.lastAgentAttemptAt,
      assignedAt: c.assignedAt,
      agentWhere,
      now,
      dayStartHHMM: dayStart,
      calendar: calendarFor(companyDaysOff, c.assignedAgent),
    });
    if (!verdict.unanswered) continue;
    out.push({
      clientId: c.id,
      shortId: c.shortId,
      fullName: c.fullName,
      status: c.status,
      workStatus: c.workStatus,
      clientKind: c.kind,
      agentId: c.assignedAgentId!,
      agentName: c.assignedAgent?.fullName ?? "агент",
      agentWhere,
      workingDaysSilent: verdict.workingDaysSilent,
      objectOnSale: onSale.has(c.id),
      windowClosed: Boolean(c.lastClientMessageAt) && now.getTime() - c.lastClientMessageAt!.getTime() > DAY,
    });
  }
  return out;
}

/**
 * ТИК КРОНА. Пуш и строка в ленте руководству («📵 … агент не отвечает») УБРАНЫ
 * по решению владельца 02.10.2026: за 14 дней ~13 000 срабатываний — спам. Тик
 * только обновляет задачу в делах держателя карточки (notifyHolderOfSilence);
 * сам список неотвеченных (findUnansweredClients) читает дашборд. `alerted` —
 * сколько карточек обработано.
 */
export async function runAgentUnansweredAlarmTick(now: Date = new Date()): Promise<{ alerted: number }> {
  if (!(await isWithinAlarmHours(now))) return { alerted: 0 };

  const items = await findUnansweredClients(now);
  if (items.length === 0) return { alerted: 0 };

  let alerted = 0;
  for (const item of items) {
    // Сбой одной записи не обрывает остальные (E8 глубокой проверки 02.10.2026, класс №173).
    try {
      await notifyHolderOfSilence(item);
      alerted++;
    } catch (err) {
      reportCronRowError("Клиент пишет, агент не отвечает", item.shortId, err);
    }
  }
  return { alerted };
}

/**
 * Р-1 (17.09.2026, `docs/audit/lead-ownership-17-09.md` §4): клиент остаётся у
 * агента, но сам агент тоже должен узнать, что клиент ждёт, а не только
 * руководитель. Пуш агенту + строка в его делах (Interaction SYSTEM с
 * nextAction) — раньше уходило только руководству. Если окно WhatsApp/Instagram
 * (24 ч) закрыто, текст задачи меняется: написать нельзя, только позвонить.
 *
 * Дедуп задачи — своя, отдельная от пуша руководству (`agent-unanswered-*`):
 * пока висит незакрытая задача с этим маркером на клиента, вторую не создаём —
 * иначе получасовой тик крона плодил бы дубли на каждый прогон.
 */
async function notifyHolderOfSilence(item: UnansweredCandidate): Promise<void> {
  const marker = "[agentUnansweredAlarm]";
  const taskText = item.windowClosed
    ? `Написать в чат нельзя, окно закрыто — позвоните: ${item.fullName} ждёт ${item.workingDaysSilent} раб. дн.`
    : `Клиент ждёт ответа ${item.workingDaysSilent} раб. дн.: ${item.fullName}`;

  // Пуш держателю («Окно чата закрыто — позвоните» / «Клиент ждёт ответа») УБРАН
  // (владелец 02.10.2026: «не нужные уведомления»). Задача в делах агента ниже остаётся;
  // пуш и лента руководству убраны тем же решением.

  try {
    /**
     * upsertAutoTask (21.09.2026, lib/autoTasks.ts) — раньше дедуп искал СВОЮ же
     * запись по `notes.startsWith(marker)` и, найдя открытую, просто выходил —
     * не обновляя ни текст, ни `nextActionDate`. Задача так и висела с числом
     * дней на момент первого срабатывания («ждёт 14 раб. дн.») сколько угодно
     * тиков подряд, пока молчание не кончится, — то самое «Наргис 14/Наргис 15»
     * из жалобы владельца 21.09.2026 (на самом деле НЕ дубли, а два разных клиента
     * с похожей стареющей задачей). Ключ дедупа теперь `autoTaskKind`
     * (одна задача клиента, текст зависит от `item.windowClosed` — «написать
     * нельзя, окно закрыто» либо «клиент ждёт ответа», см. `taskText` выше).
     */
    await upsertAutoTask({
      clientId: item.clientId,
      kind: "chat_window_closed",
      actor: { kind: "system", source: "agentUnansweredAlarm", subjectAgentId: item.agentId },
      type: "SYSTEM",
      notes: `${marker} ${taskText}`,
      nextAction: taskText,
      nextActionDate: new Date(),
    });
  } catch (err) {
    console.error("[тишина агента] строка в делах:", err instanceof Error ? err.message : err);
  }
}
