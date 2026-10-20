import type { ConversationMessage } from "@royal-home/shared";
import { channelLabel } from "@royal-home/shared";
import type { ChatMessage } from "../ai/client.js";
import { prisma } from "../db.js";
import { logSystemError } from "./systemError.js";
import { enqueueDirectorAlert } from "./directorAlertQueue.js";
import { extractAllPhones, extractVolunteeredPhone, unparsedPhoneAttempt, type LeadDraft } from "../ai/leadQualifier.js";
import { isWithinWorkingHours } from "./workingHours.js";
import { stripUntrusted } from "../ai/untrustedContent.js";
import { phoneTail } from "./clientPhones.js";
import { maskClientPhone } from "./clientPhone.js";
import { dushanbeDateTimeString } from "./dushanbeTime.js";
import { createNotifications, shouldAlert } from "./notifications.js";
import { sendPushToAgents } from "../push.js";

/**
 * СТОРОЖ: НОМЕР В ПЕРЕПИСКЕ ЕСТЬ — КАРТОЧКИ НЕТ (ступень 3, 03.09.2026).
 *
 * Две ступени выше чинят ИЗВЕСТНЫЕ причины потери лида: ступень 1 — разбор номера
 * (местный набор через ноль больше не пропадает, ai/leadQualifier.ts), ступень 2 —
 * приём заявки перестал зависеть от того, разговаривает ли бот (messengers/conversation.ts:
 * пауза оператора, выключенный рубильник, отсечка «не по теме», предел ИИ).
 *
 * Эта ступень не чинит НИЧЕГО и в этом её смысл: она смотрит на ФАКТ, а не на
 * причину. Человек прислал номер, а карточки в базе нет — значит лид потерян,
 * и неважно, из-за какой ветки кода это случилось на этот раз. Так ловятся и
 * будущие причины: новая отсечка, сбой Meta, упавший приём, форма номера, о
 * которой мы ещё не думали.
 *
 * СТОРОЖ ЗАВОДИТ КАРТОЧКУ САМ (ступень 4, 03.09.2026, владелец: «не хочу каждый
 * раз делать такое руками»). Раньше он только звал человека, и это было честно
 * ровно наполовину: находка «номер есть, карточки нет» превращалась в ручную
 * работу руководства, которой тем больше, чем хуже работает приём.
 *
 * НО ВТОРОГО ПУТИ ПРИЁМА ЗДЕСЬ НЕТ — и это главное. Приём заявки не одна запись:
 * отказ по аренде и по другой стране, тип обращения (покупатель / продавец /
 * «прочее»), назначение агента, атрибуция рекламы, автопилот карточки. Своя
 * упрощённая версия всего этого в фоновом задании была бы вторым местом, где то
 * же самое можно забыть. Поэтому сторож зовёт ТУ ЖЕ функцию, что и живое
 * сообщение (acceptLead, messengers/conversation.ts), в тихом режиме: без хода
 * модели и без реплики клиенту — он написал три дня назад, отвечать ему сейчас
 * поздно и странно. Все отсечки внутри приёма продолжают действовать: аренда,
 * чужая страна, чужой город уходят в отказ, а не в карточку.
 *
 * ЧЕЛОВЕКА ЗОВЁМ ТОЛЬКО ТАМ, ГДЕ РЕШЕНИЕ ДЕЙСТВИТЕЛЬНО ЗА ЧЕЛОВЕКОМ:
 *  · номер не разобрался («00 000 10 08» — на номер похоже, но чей он, знает
 *    только тот, кто прочтёт переписку);
 *  · диалог помечен как рассылка — карточку спамеру заводить нельзя;
 *  · приём отказал сам (аренда, другая страна) или сорвался с ошибкой.
 *
 * ДЕДУП В ЛЕНТЕ УВЕДОМЛЕНИЙ — по tag: один диалог = одна строка, повторный тик
 * только поднимает счётчик той же строки. НО ЭТО НЕ ОГРАНИЧИВАЕТ ЧАСТОТУ ПУША:
 * upsertByTag схлопывает записи в ЛЕНТЕ, а enqueueDirectorAlert на каждый тик
 * заводит новую строку очереди, и flushDirectorAlertQueue шлёт push по каждой —
 * комментарий здесь раньше утверждал обратное, и это позволило нерешённому
 * диалогу слать пуш директору на каждый часовой тик (тот самый инцидент 128
 * подряд уведомлений). От повторной ОТПРАВКИ на каждый тик защищает shouldAlert
 * (notifications.ts, владелец 15.09.2026): не чаще раза в сутки на один tag.
 */

/** Насколько назад смотрим. Больше суток — чтобы поймать и то, что потерялось ночью;
 *  меньше недели — чтобы старые «мёртвые» диалоги не всплывали вечно. */
export const PHONE_WATCH_WINDOW_HOURS = 72;

/** Сколько последних реплик клиента разбираем в каждом диалоге: номер всегда рядом
 *  с концом разговора, а читать всю историю ради этого — лишняя работа. */
const LOOK_BACK_MESSAGES = 30;

/** Предел выборки: любой запрос, возвращающий массив, обязан иметь потолок. */
const MAX_CONVERSATIONS = 500;

export interface PhoneWithoutLead {
  conversationId: string;
  channel: string;
  name: string | null;
  /** Разобранный номер, если он читается; иначе null и заполнен `raw`. */
  phone: string | null;
  /** Что именно прислал клиент, когда номер не разобрался («000001008»). */
  raw: string | null;
  spamFlagged: boolean;
  /** Реплика, в которой нашёлся номер: из неё приём берёт запасные номера и по ней
   *  же срабатывают отсечки «аренда»/«другая страна». */
  phoneText: string;
  /** Черновик заявки и переписка — их ждёт настоящий приём (см. tryAcceptQuietly). */
  draft: unknown;
  history: ConversationMessage[];
}

/** Слова КЛИЕНТА этого диалога — без врезок разобранных файлов: текст внутри
 *  присланного PDF не является номером, который человек оставил сам (тот же
 *  приём, что в acceptLead). */
function clientTexts(messages: ConversationMessage[]): string[] {
  return messages
    .filter((m) => m.role === "user" && typeof m.content === "string" && m.content)
    .slice(-LOOK_BACK_MESSAGES)
    .map((m) => stripUntrusted(m.content, ["document", "video", "voice"]));
}

/**
 * Диалоги, где клиент оставил номер, а карточки так и нет.
 *
 * Отбор в базе узкий (clientId пуст + свежий), разбор текста — в памяти: номер
 * лежит внутри JSON-переписки, и SQL по нему всё равно был бы полным перебором.
 */
export async function findPhonesWithoutLead(now: Date = new Date()): Promise<PhoneWithoutLead[]> {
  const since = new Date(now.getTime() - PHONE_WATCH_WINDOW_HOURS * 60 * 60 * 1000);
  const rows = await prisma.botConversation.findMany({
    // `watchdogAttemptedAt: null` — ОДНА попытка на диалог (авария 17.09.2026).
    // Раньше отбор был только «карточки нет + свежий», а карточка у разговора о
    // работе не появляется никогда: диалог оставался кандидатом вечно и приём
    // прогонялся заново каждые 15 минут. Причина отказа сама не исчезнет — если
    // приём не сработал с первого раза, дальше это работа человека, а не крона.
    where: { clientId: null, lastMessageAt: { gte: since }, watchdogAttemptedAt: null },
    select: {
      id: true,
      channel: true,
      name: true,
      messages: true,
      leadDraft: true,
      spamFlaggedAt: true,
      lastMessageAt: true,
    },
    orderBy: { lastMessageAt: "desc" },
    take: MAX_CONVERSATIONS,
  });

  const found: PhoneWithoutLead[] = [];
  for (const row of rows) {
    const history = (row.messages as unknown as ConversationMessage[]) ?? [];
    const texts = clientTexts(history);
    let phone: string | null = null;
    let raw: string | null = null;
    let phoneText = "";
    for (const text of texts) {
      phone = phone ?? extractVolunteeredPhone(text);
      if (phone) {
        phoneText = text;
        break;
      }
      raw = raw ?? unparsedPhoneAttempt(text);
    }
    if (!phone && !raw) continue;
    /**
     * РАЗГОВОР О РАБОТЕ — НЕ ПОТЕРЯННЫЙ ЛИД (авария 17.09.2026).
     *
     * С 17.09.2026 намерение «работа» даёт анкету кандидата и НИКОГДА не даёт
     * карточку клиента (messengers/conversation.ts, ветка `decision.reason ===
     * "работа"`). Для сторожа это значит, что такой диалог «без карточки» —
     * нормальное состояние, а не потеря: номер кандидата лежит в JobApplication,
     * его видно в разделе «Вакансии», и звать сюда ни приём, ни человека незачем.
     * Раньше сторож этого не знал и гонял приём по кругу.
     */
    const intent = (row.leadDraft as { intent?: string } | null)?.intent;
    if (intent === "job") continue;
    found.push({
      conversationId: row.id,
      channel: row.channel,
      name: row.name,
      phone,
      raw,
      spamFlagged: !!row.spamFlaggedAt,
      phoneText,
      draft: row.leadDraft,
      history,
    });
  }
  return withoutJobApplications(found);
}

/**
 * Анкета кандидата на этот диалог уже есть — значит номер не потерян, он лежит в
 * разделе «Вакансии» (авария 17.09.2026, второй рубеж к отсечке `intent === "job"`
 * выше). Намерение в черновике живёт только пока разговор идёт: перезапуск разбора,
 * ручная правка или смена темы могут его стереть, а анкета остаётся. ОДИН запрос на
 * всю пачку — отдельный на диалог дал бы N+1 ровно там, где кандидатов больше всего.
 */
async function withoutJobApplications(rows: PhoneWithoutLead[]): Promise<PhoneWithoutLead[]> {
  if (rows.length === 0) return rows;
  const ids = rows.map((r) => r.conversationId);
  const applications = await prisma.jobApplication.findMany({
    where: { conversationId: { in: ids } },
    select: { conversationId: true },
    take: MAX_CONVERSATIONS,
  });
  const candidates = new Set(applications.map((a) => a.conversationId));
  return rows.filter((r) => !candidates.has(r.conversationId));
}

/**
 * Номер уже есть в CRM под другой карточкой — тогда лид не потерян, а просто
 * пришёл вторым каналом (человек писал в Instagram, а звонил с того же номера).
 * Проверяем ОДНИМ запросом на всю пачку: отдельный запрос на диалог дал бы N+1
 * ровно там, где кандидатов больше всего — в первый прогон после выката.
 *
 * РАЗДЕЛ L, УРОВЕНЬ 2 (03.09.2026, план вечерней сессии §L). Раньше такие диалоги
 * просто ВЫЧИТАЛИСЬ из кандидатов на аларм «карточки нет» и на этом всё — сам
 * диалог оставался clientId=null НАВСЕГДА, пока кто-то не привяжет его руками.
 * Теперь: раз номер уже узнан, диалог сам привязывается к найденной карточке (см.
 * attachKnownClientConversations ниже) — агенту не нужно заводить дубль вручную,
 * он просто видит вторую переписку на уже знакомой карточке.
 */
async function withoutKnownClient(rows: PhoneWithoutLead[]): Promise<PhoneWithoutLead[]> {
  const known = await findKnownClientsByTail(rows);
  return rows.filter((r) => !r.phone || !known.has(phoneTail(r.phone)));
}

interface KnownClientMatch {
  id: string;
  shortId: number;
  assignedAgentId: string | null;
}

/** Карточки, чей номер (последние 9 цифр) совпадает хотя бы с одним диалогом
 *  из пачки — ключ карты: тот же хвост номера, что и у диалога. */
async function findKnownClientsByTail(rows: PhoneWithoutLead[]): Promise<Map<string, KnownClientMatch>> {
  const tails = [...new Set(rows.map((r) => (r.phone ? phoneTail(r.phone) : "")).filter(Boolean))];
  const result = new Map<string, KnownClientMatch>();
  if (tails.length === 0) return result;
  const known = await prisma.$queryRaw<Array<{ tail: string; id: string; shortId: number; assignedAgentId: string | null }>>`
    SELECT right(regexp_replace("phone", '[^0-9]', '', 'g'), 9) AS "tail", "id", "shortId", "assignedAgentId"
    FROM "Client"
    WHERE "deletedAt" IS NULL
      AND right(regexp_replace("phone", '[^0-9]', '', 'g'), 9) = ANY(${tails})
    LIMIT ${MAX_CONVERSATIONS}`;
  for (const k of known) result.set(k.tail, { id: k.id, shortId: k.shortId, assignedAgentId: k.assignedAgentId });
  return result;
}

/**
 * РАЗДЕЛ L, УРОВЕНЬ 2 — сам самолечащий шаг: диалог без карточки, чей номер узнан,
 * привязывается к найденной карточке автоматически, и её агент узнаёт о втором
 * канале (а не директор — это не потеря лида, обычная рабочая новость). Дедуп —
 * тот же приём, что и у аларма ниже: tag на пару (диалог, агент).
 */
async function attachKnownClientConversations(rows: PhoneWithoutLead[]): Promise<{ attached: number }> {
  const known = await findKnownClientsByTail(rows);
  if (known.size === 0) return { attached: 0 };

  let attached = 0;
  for (const row of rows) {
    if (!row.phone) continue;
    const match = known.get(phoneTail(row.phone));
    if (!match) continue;
    try {
      await prisma.botConversation.update({ where: { id: row.conversationId }, data: { clientId: match.id } });
    } catch (err) {
      // Гонка — диалог уже привязали (агент вручную, или другой тик) между
      // выборкой и этим update. Пропускаем, не считаем ошибкой.
      console.error("[alarm] phone-watchdog автопривязка диалога:", err instanceof Error ? err.message : err);
      continue;
    }
    attached++;
    if (!match.assignedAgentId) continue;
    // Русское название канала вместо сырого кода из базы (ночная проверка 24.09.2026, находка №11).
    const who = row.name?.trim() || `диалог ${channelLabel(row.channel)}`;
    const payload = {
      kind: "oversight" as const,
      title: `🔗 Ещё одна переписка: ${who}`,
      body: `Номер ${maskClientPhone(row.phone)} уже известен — новый диалог (${channelLabel(row.channel)}) привязан к вашей карточке автоматически`,
      url: `/clients/${match.shortId}`,
      tag: `duplicate-review-known-client-${row.conversationId}`,
    };
    try {
      await createNotifications([match.assignedAgentId], payload);
      void sendPushToAgents([match.assignedAgentId], payload).catch((err) =>
        console.error("[push] phone-watchdog автопривязка:", err)
      );
    } catch (err) {
      console.error("[alarm] phone-watchdog автопривязка уведомление:", err);
    }
  }
  return { attached };
}

/**
 * Сколько заявок сторож оформляет за один тик. Потолок нужен не ради базы, а ради
 * раздачи лидов: первый прогон после выката видит хвост за трое суток разом, и без
 * предела он вывалил бы его одной пачкой на дежурных агентов. Остаток никуда не
 * денется — следующий тик через час подберёт его.
 */
const MAX_AUTO_ACCEPTS_PER_TICK = 25;

/** Предохранитель по частоте (владелец 15.09.2026) — см. shouldAlert в notifications.ts. */
const ALERT_MIN_INTERVAL_MS = 24 * 60 * 60 * 1000;

/**
 * Оформить заявку тем же приёмом, что и живое сообщение. Возвращает исход, а не
 * бросает: сторож обязан дойти до конца списка, чем бы ни кончился один диалог.
 *
 * `await import` — не украшение: lib → messengers → lib даёт цикл импортов, а на
 * нём CI уже спотыкался (см. коммент к экспорту acceptLead).
 */
async function tryAcceptQuietly(row: PhoneWithoutLead): Promise<"accepted" | "declined" | "failed"> {
  try {
    const { acceptLead } = await import("../messengers/conversation.js");
    const result = await acceptLead(
      row.conversationId,
      row.channel,
      row.name ?? undefined,
      row.phone!,
      (row.draft as LeadDraft) ?? { stage: "chatting" },
      // Тот же приём, что и в живом пути (messengers/conversation.ts): переписка
      // лежит в JSON-колонке, и её форма совпадает с ChatMessage.
      row.history as unknown as ChatMessage[],
      {
        deferAssignment: !(await isWithinWorkingHours()),
        clientText: row.phoneText,
        extraPhones: extractAllPhones(row.phoneText),
        silent: true,
        // `phoneText` взят из УЖЕ сохранённой переписки — приём не должен записать
        // его туда второй раз и не должен двигать lastMessageAt (авария 17.09.2026:
        // именно этим сторож продлевал собственное окно и кормил петлю).
        fromHistory: true,
      }
    );
    if (!result.accepted) return "declined";
    // «accepted» без карточки — не успех (AI-DIALOGUE01): так приём отвечает и
    // опоздавшему из гонки, чей победитель жив или умер до привязки. Тик ставит
    // отметку попытки и больше этот диалог не трогает, поэтому ложный успех
    // прятал бы потерянный лид и от повтора, и от тревоги. Сверяем с базой.
    const linked = await prisma.botConversation.findUnique({
      where: { id: row.conversationId },
      select: { clientId: true },
    });
    if (!linked?.clientId) {
      console.error(`[alarm] phone-without-lead автоприём: диалог ${row.conversationId} принят без карточки`);
      return "failed";
    }
    return "accepted";
  } catch (err) {
    console.error("[alarm] phone-without-lead автоприём:", err instanceof Error ? err.message : err);
    return "failed";
  }
}

/**
 * Отметить, что автоприём по этому диалогу уже пробовали. Не бросает: сторож обязан
 * дойти до конца списка, а пропущенная отметка — это в худшем случае одна лишняя
 * попытка на следующем тике, а не остановка всего прохода.
 */
async function markWatchdogAttempted(conversationId: string): Promise<void> {
  try {
    await prisma.botConversation.update({
      where: { id: conversationId },
      data: { watchdogAttemptedAt: new Date() },
    });
  } catch (err) {
    console.error("[alarm] phone-watchdog отметка попытки:", err instanceof Error ? err.message : err);
  }
}

/**
 * Тик крона: найти, привязать то, что узнали (уровень 2), оформить что можно
 * (уровень 3), показать человеку только настоящих «потеряшек».
 */
export async function runPhoneLeadWatchdogTick(
  now: Date = new Date()
): Promise<{ alerted: number; accepted: number; attached: number }> {
  const found = await findPhonesWithoutLead(now);
  if (found.length === 0) return { alerted: 0, accepted: 0, attached: 0 };

  // Уровень 2 (03.09.2026, план §L): номер уже известен — диалог сам садится на
  // найденную карточку, агент видит вторую переписку вместо ручного дубля.
  // Привязка это данные, а не аларм: идёт круглосуточно, часы тишины её не
  // касаются (сам сигнал ниже уходит через очередь алармов, она их и держит).
  const { attached } = await attachKnownClientConversations(found);
  const candidates = await withoutKnownClient(found);
  if (candidates.length === 0) return { alerted: 0, accepted: 0, attached };

  /**
   * Сначала — приём. Всё, что оформилось, из очереди «показать человеку» уходит:
   * ради этого ступень и делалась.
   *
   * Последовательно, а не Promise.all: приём назначает агента, а распределение
   * считает портфели — пачка параллельных приёмов складывала бы лидов одному и
   * тому же дежурному, каждый со своим снимком счётчиков.
   */
  const leftForHuman: PhoneWithoutLead[] = [];
  let accepted = 0;
  for (const row of candidates) {
    const canTakeItself = !!row.phone && !row.spamFlagged && accepted < MAX_AUTO_ACCEPTS_PER_TICK;
    if (!canTakeItself) {
      leftForHuman.push(row);
      continue;
    }
    const outcome = await tryAcceptQuietly(row);
    // ОДНА ПОПЫТКА НА ДИАЛОГ, чем бы она ни кончилась (авария 17.09.2026). Отказ и
    // сбой тоже считаются попыткой: причина («аренда», «другая страна», упавший
    // приём) через 15 минут не изменится сама, а вот петля из повторов — изменится,
    // и именно она разослала клиентам сотни сообщений. Оба случая не теряются: они
    // уходят в leftForHuman ниже, и человек получает сигнал.
    await markWatchdogAttempted(row.conversationId);
    if (outcome === "accepted") {
      accepted++;
      // След в журнале: «карточка возникла сама, без сообщения клиенту» не должно
      // выглядеть загадкой ни для агента, ни при следующем разборе.
      void logSystemError(
        "ai",
        `Заявка оформлена сторожем: номер ${maskClientPhone(row.phone!)} был в переписке (диалог ${row.conversationId}, ` +
          // Русское название канала вместо сырого кода из базы (ночная проверка 24.09.2026, находка №11).
          `${channelLabel(row.channel)}), а карточки не было. Клиенту при этом ничего не отправлено.`
      );
      continue;
    }
    // Отказ приёма (аренда, другая страна) и сбой одинаково остаются человеку:
    // в первом случае он закроет вопрос глазами, во втором — заведёт руками.
    leftForHuman.push(row);
  }

  if (leftForHuman.length === 0) return { alerted: 0, accepted, attached };

  let alerted = 0;
  for (const row of leftForHuman) {
    const tag = `alarm-phone-without-lead-${row.conversationId}`;
    // Предохранитель по частоте, ДО построения текста и постановки в очередь:
    // диалог остаётся «потеряшкой» на каждом следующем часовом тике, пока никто
    // не заведёт карточку руками, — без этой проверки push уходил бы директору
    // на каждый тик (см. doc-comment файла).
    if (!(await shouldAlert(tag, ALERT_MIN_INTERVAL_MS, now))) continue;

    // Русское название канала вместо сырого кода из базы (ночная проверка 24.09.2026, находка №11).
    const who = row.name?.trim() || `диалог ${channelLabel(row.channel)}`;
    const what = row.phone
      ? `Номер ${maskClientPhone(row.phone)} есть в переписке, карточки в базе нет`
      : `Клиент прислал «${row.raw}» — на номер похоже, но разобрать нельзя (опечатка?)`;
    const payload = {
      kind: "oversight" as const,
      title: `📵 Лид без карточки: ${who}`,
      // Когда/откуда(канал)/что — видно без перехода по ссылке.
      body: `${dushanbeDateTimeString(now)}, канал ${channelLabel(row.channel)}: ${what}${row.spamFlagged ? ". Диалог помечен как рассылка — проверьте, не ошибка ли" : ""}`,
      url: `/messages?open=${row.conversationId}`,
      tag,
    };
    try {
      // Часы алармов (владелец 07.09.2026): ставим в общую очередь вместо
      // мгновенной отправки — диалог уже сохранён, откладывается только сигнал.
      // Срочное: живой человек оставил номер, а карточки на него нет. Пока
      // это лежит в ленте непрочитанным, лид просто не существует для CRM.
      await enqueueDirectorAlert({ ...payload, level: "CRITICAL", recipientRoles: ["DIRECTOR", "ADMIN", "HEAD_OF_SALES"] });
      // След в «Здоровье системы»: пуш можно смахнуть, журнал остаётся — по нему
      // потом видно, как часто ступени 1-2 всё-таки промахиваются.
      void logSystemError(
        "ai",
        // Русское название канала вместо сырого кода из базы (ночная проверка 24.09.2026, находка №11).
        `[alarm] ${what} (диалог ${row.conversationId}, ${channelLabel(row.channel)}, ${who}). ` +
          `Откройте переписку и заведите карточку, если это настоящий клиент.`
      );
      alerted++;
    } catch (err) {
      console.error("[alarm] phone-without-lead notification:", err);
    }
  }
  return { alerted, accepted, attached };
}
