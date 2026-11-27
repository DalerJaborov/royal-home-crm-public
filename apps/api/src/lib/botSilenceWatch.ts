import { pluralizeRu } from "@royal-home/shared";
import { prisma, type TxClient } from "../db.js";
import { customerSpamMuteActive, customerSpamMuteFrom } from "../ai/customerSpamMute.js";
import { automationSwitchOn } from "./automationSwitches.js";
import { episodeAllIntentional, humanRepliedSince, INTENTIONAL_SILENCE_REASONS, waitingEpisodeOf } from "./clientWaitingAlert.js";
import { isCustomerAgentChannelOff } from "./customerAgentChannelOff.js";
import { BOT_STOPPED_TITLE } from "./customerAgentRevisionAlert.js";
import { CUSTOMER_TURN_INTENDED_SILENCE } from "./customerIntendedSilence.js";
import { enqueueDirectorAlert } from "./directorAlertQueue.js";
import { dushanbeDateString, dushanbeTimeString } from "./dushanbeTime.js";

/**
 * СТОРОЖ «БОТ ЗАМОЛЧАЛ» (владелец 27.11.2026).
 *
 * ЗАЧЕМ. 26.11.2026 с 16:00 до 20:22 по Душанбе бот не ответил никому в Instagram, WhatsApp и Facebook (версия ядра
 * застряла, починено #482). Единственным следом была техническая строка в журнале ошибок, которую никто не читал;
 * владелец узнал по входящим Instagram у себя в телефоне. Его слова: «как что-то сломается и бот не отвечает, надо
 * чтобы сторож узнал сразу и сказал мне, админу и директору. Только по-человечески, а не по-технически».
 *
 * ПО ПРИЗНАКУ, А НЕ ПО ПРИЧИНЕ. Сторож не знает, ПОЧЕМУ бот молчит (версия, ключ Meta, упавший процесс, очередь,
 * ИИ — любая будущая причина): он смотрит только на итог в базе. Канал «замолчал», когда одновременно:
 *   1. трое и больше клиентов (SILENCE_MIN_CUSTOMERS) ждут ответа дольше 10 минут (SILENCE_GRACE_MS), и
 *   2. с того момента, как написал первый из них, бот не ответил в этом канале НИКОМУ.
 * Второе условие и отличает поломку от медлительности или отдельных намеренных молчаний: работающий бот отвечает
 * хоть кому-то, и тогда пункт 2 ложен. Ночью и при малом потоке условие то же: если трое подряд написали и бот не
 * ответил ни одному, это поломка в любой час (бот работает круглые сутки). Окно «ждёт ответа» — 6 часов: старое
 * молчание — дело сторожа «клиент ждёт ответа» и утреннего отчёта.
 *
 * ДВА ИСТОЧНИКА ОДНОГО ПРИЗНАКА. (а) Переписка CRM (`BotConversation.messages`): хвост реплик клиента без ответа —
 * то же правило, что у сторожа «клиент ждёт ответа» (`waitingEpisodeOf`, одна дверь). (б) Сообщения нового ядра
 * (`CustomerPropertyIngressTicket`), не получившие ответа: на случай поломки ДО того, как текст лёг в переписку.
 * Человек считается один раз (ключ: переписка, без неё — область ядра). Ответ бота — его реплика сразу после реплики
 * клиента в переписке или принятая площадкой часть ответа ядра (`CustomerOutboxPart.acceptedAt`).
 *
 * КОГО НЕ СЧИТАЕМ (бот молчит намеренно или переписку ведёт человек): молчание из единого списка намеренных
 * (lib/customerIntendedSilence.ts: эхо своих сообщений, спам, свои сотрудники, повтор вложения…), пауза бота,
 * отписавшихся, клиентов в корзине, заглушённый спам, переписку, где сотрудник отвечал за последние сутки, и канал,
 * выключенный аварийным рубильником (CUSTOMER_AGENT_CHANNEL_OFF). Комментарии сюда не входят (это не переписки).
 *
 * КОМУ И КАК. Директору и администратору (владелец — директор) через очередь тревог руководству, срочно (мимо часов
 * алармов; ночью по общему правилу только колокольчик, звонок утром). Один эпизод — одно уведомление; пока он длится,
 * напоминание не чаще раза в час (SILENCE_REMIND_MS) и только если люди всё ещё ждут; когда бот снова ответил в
 * каждом замолчавшем канале — «Бот снова отвечает, без ответа остались N человек». Простыми словами, без кодов.
 * Эпизод хранится в `BotSilenceIncident` (переживает выкат), решение — под замком базы (api и worker не задвоят).
 *
 * РУБИЛЬНИК: `botSilenceWatchEnabled` (Настройки → Автоматика → Бот клиентов), по умолчанию ВКЛ.
 */

export const SILENCE_WATCHED_CHANNELS = ["INSTAGRAM", "WHATSAPP", "FACEBOOK", "WEBSITE"] as const;
export type SilenceChannel = (typeof SILENCE_WATCHED_CHANNELS)[number];
/** Сколько клиентов без ответа в канале нужно для тревоги. Один-два — это сторож «клиент ждёт ответа», не поломка бота. */
export const SILENCE_MIN_CUSTOMERS = 3;
/** Сколько клиент ждёт, прежде чем считаться «без ответа»: обычный ход бота — секунды, склейка сообщений — до минуты. */
export const SILENCE_GRACE_MS = 10 * 60_000;
/** Глубже не смотрим. */
export const SILENCE_LOOKBACK_MS = 6 * 60 * 60_000;
/** Напоминание руководству не чаще. */
export const SILENCE_REMIND_MS = 60 * 60_000;
/** Сотрудник отвечал в переписке за это время — её ведёт человек, молчание бота там не сигнал. */
const HUMAN_LED_MS = 24 * 60 * 60_000;
const ROW_LIMIT = 1500;
const TICKET_LIMIT = 1000;
/** Сколько ключей «без ответа» хранит эпизод (на число в сообщении о восстановлении хватает с запасом). */
const MISSED_KEYS_CAP = 500;
const LOCK_KEY = "bot-silence-watch";
const ALERT_URL = "/messages";
const ALERT_ROLES = ["DIRECTOR", "ADMIN"] as const;

const CHANNEL_WORD: Record<SilenceChannel, string> = {
  INSTAGRAM: "Instagram",
  WHATSAPP: "WhatsApp",
  FACEBOOK: "Facebook",
  WEBSITE: "чате на сайте",
};

function watched(channel: string | null | undefined): SilenceChannel | null {
  const up = (channel ?? "").toUpperCase();
  return (SILENCE_WATCHED_CHANNELS as readonly string[]).includes(up) ? (up as SilenceChannel) : null;
}

export interface WaitingCustomer {
  /** Один человек — один ключ: id переписки CRM, без неё — область ядра. */
  key: string;
  channel: SilenceChannel;
  /** С какого момента ждёт ответа. */
  since: Date;
}

export interface SilenceSnapshot {
  /** Все, кто ждёт ответа дольше SILENCE_GRACE_MS (в окне SILENCE_LOOKBACK_MS), без исключённых. */
  waiting: WaitingCustomer[];
  /** Последний ответ бота клиенту по каждому каналу (в окне), null — не было. */
  lastBotAnswerAt: Partial<Record<SilenceChannel, Date>>;
}

/** Замолчавшие каналы и кто в них ждёт (пришёл ПОСЛЕ последнего ответа бота). Чистая функция. */
export function silentChannels(snapshot: SilenceSnapshot): Map<SilenceChannel, WaitingCustomer[]> {
  const out = new Map<SilenceChannel, WaitingCustomer[]>();
  for (const channel of SILENCE_WATCHED_CHANNELS) {
    const last = snapshot.lastBotAnswerAt[channel]?.getTime() ?? -Infinity;
    const stuck = snapshot.waiting.filter((w) => w.channel === channel && w.since.getTime() > last);
    if (stuck.length >= SILENCE_MIN_CUSTOMERS) out.set(channel, stuck);
  }
  return out;
}

export interface OpenIncident {
  id: string;
  channels: string[];
  startedAt: Date;
  lastAlertAt: Date;
  missedKeys: string[];
}

export type SilenceDecision =
  | { kind: "none" }
  | { kind: "open"; channels: SilenceChannel[]; startedAt: Date; waiting: number; keys: string[] }
  | { kind: "update"; channels: SilenceChannel[]; keys: string[]; remind: boolean; waiting: number }
  | { kind: "recover"; missed: number; stillWaiting: number }
  | { kind: "close" };

/**
 * Что делать на этом тике. Чистая функция — проверяется без базы.
 * `offChannels` — выключенные намеренно: о них эпизод молчит и не ждёт их «восстановления».
 */
export function decideBotSilence(snapshot: SilenceSnapshot, open: OpenIncident | null, now: Date,
  offChannels: ReadonlySet<string> = new Set()): SilenceDecision {
  const silent = silentChannels(snapshot);
  for (const channel of offChannels) silent.delete(channel as SilenceChannel);
  const stuck = [...silent.values()].flat();
  if (!open) {
    if (!silent.size) return { kind: "none" };
    return { kind: "open", channels: [...silent.keys()], startedAt: new Date(Math.min(...stuck.map((w) => w.since.getTime()))),
      waiting: stuck.length, keys: stuck.map((w) => w.key) };
  }
  if (silent.size) {
    const channels = [...new Set([...open.channels.filter((c): c is SilenceChannel => watched(c) !== null), ...silent.keys()])];
    const keys = [...new Set([...open.missedKeys, ...stuck.map((w) => w.key)])].slice(0, MISSED_KEYS_CAP);
    return { kind: "update", channels, keys, remind: now.getTime() - open.lastAlertAt.getTime() >= SILENCE_REMIND_MS, waiting: stuck.length };
  }
  // Бот снова отвечает, только если ответил КОМУ-ТО после начала молчания в каждом замолчавшем канале. Люди, которым
  // ответили вручную, бота не «чинят»: тогда эпизод открыт, но молчит, пока не наберутся новые трое или бот не ответит.
  const live = open.channels.filter((c) => !offChannels.has(c) && watched(c) !== null);
  // Все замолчавшие каналы потом выключили намеренно: «бот снова отвечает» было бы неправдой — эпизод закрывается молча.
  if (!live.length) return { kind: "close" };
  const answered = live.every((c) => (snapshot.lastBotAnswerAt[c as SilenceChannel]?.getTime() ?? -Infinity) > open.startedAt.getTime());
  if (!answered) return { kind: "none" };
  const waitingNow = new Set(snapshot.waiting.map((w) => w.key));
  return { kind: "recover", missed: open.missedKeys.length, stillWaiting: open.missedKeys.filter((k) => waitingNow.has(k)).length };
}

// ---------------------------------------------------------------- тексты: по-человечески, без кодов и английских слов

const people = (n: number) => `${n} ${pluralizeRu(n, ["человек", "человека", "человек"])}`;

/** «в Instagram и WhatsApp», «в Instagram, Facebook и чате на сайте». */
export function channelsInWords(channels: readonly string[]): string {
  const words = SILENCE_WATCHED_CHANNELS.filter((c) => channels.includes(c)).map((c) => CHANNEL_WORD[c]);
  if (!words.length) return "";
  const list = words.length === 1 ? words[0] : `${words.slice(0, -1).join(", ")} и ${words[words.length - 1]}`;
  return `в ${list}`;
}

/** «16:05» сегодня, «26.11 в 23:50» — если молчание началось в другой день (по Душанбе). */
export function sinceInWords(since: Date, now: Date): string {
  const time = dushanbeTimeString(since);
  const day = dushanbeDateString(since);
  if (day === dushanbeDateString(now)) return time;
  return `${day.slice(8, 10)}.${day.slice(5, 7)} в ${time}`;
}

export function silenceAlertText(input: { channels: readonly string[]; since: Date; waiting: number; reminder: boolean; now: Date }):
  { title: string; body: string } {
  const where = channelsInWords(input.channels);
  const since = sinceInWords(input.since, input.now);
  return {
    title: input.reminder ? "Бот всё ещё не отвечает клиентам" : BOT_STOPPED_TITLE,
    body: `${input.reminder ? "Бот всё ещё не отвечает" : "Бот перестал отвечать"} клиентам ${where} с ${since}. ` +
      `Без ответа уже ${people(input.waiting)}. Пока бот молчит, ответьте им вручную в CRM → Чаты и сообщите разработчику.`,
  };
}

export function silenceRecoveredText(input: { channels: readonly string[]; since: Date; missed: number; stillWaiting: number; now: Date }):
  { title: string; body: string } {
  const where = channelsInWords(input.channels);
  const tail = input.stillWaiting > 0
    ? ` Ещё ждут ответа: ${people(input.stillWaiting)}, ответьте им в CRM → Чаты.`
    : " Проверьте их в CRM → Чаты.";
  return {
    title: "Бот снова отвечает клиентам",
    body: `Бот снова отвечает клиентам ${where}. Пока он молчал (с ${sinceInWords(input.since, input.now)}), ` +
      `без ответа ${pluralizeRu(input.missed, ["остался", "остались", "остались"])} ${people(input.missed)}.${tail}`,
  };
}

// ---------------------------------------------------------------- снимок из базы

type ConversationRow = {
  id: string; channel: string; messages: unknown; leadDraft: unknown; pausedUntil: Date | null; optedOutAt: Date | null; brandName: string | null;
};
type TicketRow = { eventKey: string; conversationId: string | null; scopeKey: string; receivedAt: Date; channel: string | null; brandName: string | null };
type MessageLike = { role?: unknown; at?: unknown; deliveryStatus?: unknown; by?: { kind?: unknown } | null };

const BOT_SILENT_AUTHORS = new Set(["agent", "manual", "system"]);
const isoAt = (raw: unknown): Date | null => {
  if (typeof raw !== "string") return null;
  const at = new Date(raw);
  return Number.isNaN(at.getTime()) ? null : at;
};

/** Последний ответ бота клиенту в переписке: его реплика сразу после реплики клиента, доставленная. Чистая функция. */
export function lastBotAnswerIn(messages: unknown): Date | null {
  if (!Array.isArray(messages)) return null;
  let last: Date | null = null;
  for (let i = 1; i < messages.length; i++) {
    const m = messages[i] as MessageLike | null;
    const prev = messages[i - 1] as MessageLike | null;
    if (!m || m.role !== "assistant" || prev?.role !== "user" || m.deliveryStatus === "failed") continue;
    const kind = m.by && typeof m.by === "object" ? m.by.kind : undefined;
    if (typeof kind === "string" && BOT_SILENT_AUTHORS.has(kind)) continue;
    const at = isoAt(m.at);
    if (at && (!last || at > last)) last = at;
  }
  return last;
}

/** Переписку ведёт человек или бот в ней молчит по решению людей — не считаем. */
function conversationExcluded(row: ConversationRow, now: Date): boolean {
  if (row.optedOutAt) return true;
  if (row.pausedUntil && row.pausedUntil.getTime() > now.getTime()) return true;
  const draft = row.leadDraft;
  const spam = draft && typeof draft === "object" && !Array.isArray(draft) ? (draft as Record<string, unknown>).spamMute : undefined;
  if (customerSpamMuteActive(customerSpamMuteFrom(spam), now)) return true;
  if (humanRepliedSince(row.messages, new Date(now.getTime() - HUMAN_LED_MS))) return true;
  return isCustomerAgentChannelOff(row.channel, process.env, row.brandName);
}

export async function loadSilenceSnapshot(now: Date, db: Pick<TxClient, "$queryRaw" | "customerPropertyIngressTicket"> = prisma): Promise<SilenceSnapshot> {
  const from = new Date(now.getTime() - SILENCE_LOOKBACK_MS);
  const graceEdge = new Date(now.getTime() - SILENCE_GRACE_MS);
  const channels = [...SILENCE_WATCHED_CHANNELS];
  const intended = [...CUSTOMER_TURN_INTENDED_SILENCE];
  // Хвост переписки (20 реплик) — его хватает и на «кто ждёт», и на «когда бот ответил»; целые ленты не тянем.
  const [rows, tickets, outbox] = await Promise.all([
    db.$queryRaw<ConversationRow[]>`
      SELECT bc.id, bc.channel, bc."leadDraft", bc."pausedUntil", bc."optedOutAt", ma."brandName",
        (SELECT jsonb_agg(x.e ORDER BY x.o) FROM jsonb_array_elements(bc.messages) WITH ORDINALITY AS x(e, o)
          WHERE x.o > jsonb_array_length(bc.messages) - 20) AS messages
      FROM "BotConversation" bc
      LEFT JOIN "Client" c ON c.id = bc."clientId"
      LEFT JOIN "MessengerAccount" ma ON ma.id = bc."accountId"
      WHERE bc."lastMessageAt" >= ${from} AND upper(bc.channel) = ANY(${channels}::text[])
        AND c."deletedAt" IS NULL
        AND jsonb_typeof(bc.messages) = 'array' AND jsonb_array_length(bc.messages) > 0
      ORDER BY bc."lastMessageAt" DESC
      LIMIT ${ROW_LIMIT}`,
    // Сообщения ядра без ответа: не запланирован ответ, нет ни одной части ответа, не перекрыты более новым отвеченным
    // сообщением того же человека, причина не из списка намеренного молчания.
    db.$queryRaw<TicketRow[]>`
      SELECT t."eventKey", t."conversationId", t."scopeKey", t."receivedAt",
        upper(COALESCE(es.channel, bc.channel)) AS channel, COALESCE(ma."brandName", bma."brandName") AS "brandName"
      FROM "CustomerPropertyIngressTicket" t
      LEFT JOIN "CustomerEndpointScope" es ON es.id = t."endpointScopeId"
      LEFT JOIN "MessengerAccount" ma ON ma.id = es."messengerAccountId"
      LEFT JOIN "BotConversation" bc ON bc.id = t."conversationId"
      LEFT JOIN "MessengerAccount" bma ON bma.id = bc."accountId"
      WHERE t."receivedAt" >= ${from} AND t."receivedAt" <= ${graceEdge}
        AND t."tombstonedAt" IS NULL
        AND t."processingState" IN ('RECEIVED', 'CLAIMED', 'HELD')
        AND (t."errorCode" IS NULL OR NOT (t."errorCode" = ANY(${intended}::text[])))
        AND NOT EXISTS (SELECT 1 FROM "CustomerOutboxPart" p WHERE p."ticketEventKey" = t."eventKey")
        AND NOT EXISTS (SELECT 1 FROM "CustomerPropertyIngressTicket" x
          WHERE x."scopeKey" = t."scopeKey" AND x."order" > t."order" AND x."processingState" = 'PLANNED')
      ORDER BY t."receivedAt" ASC
      LIMIT ${TICKET_LIMIT}`,
    // Принятые площадкой части ответов ядра в личные сообщения (не комментарии) — тоже «бот ответил».
    db.$queryRaw<Array<{ channel: string; at: Date | null }>>`
      SELECT upper(p.channel) AS channel, max(p."acceptedAt") AS at
      FROM "CustomerOutboxPart" p
      WHERE p."acceptedAt" >= ${from} AND p."ticketEventKey" IS NOT NULL
      GROUP BY 1`,
  ]);

  const lastBotAnswerAt: Partial<Record<SilenceChannel, Date>> = {};
  const bump = (channel: SilenceChannel | null, at: Date | null) => {
    if (channel && at && (!lastBotAnswerAt[channel] || at > lastBotAnswerAt[channel]!)) lastBotAnswerAt[channel] = at;
  };
  for (const row of outbox) bump(watched(row.channel), row.at);

  const byConversation = new Map(rows.map((row) => [row.id, row]));
  const waiting = new Map<string, WaitingCustomer>();
  const episodes: Array<{ row: ConversationRow; channel: SilenceChannel; episode: NonNullable<ReturnType<typeof waitingEpisodeOf>> }> = [];
  for (const row of rows) {
    const channel = watched(row.channel);
    if (!channel) continue;
    bump(channel, lastBotAnswerIn(row.messages));
    const episode = waitingEpisodeOf(row.messages);
    if (!episode || episode.since < from || episode.since > graceEdge || conversationExcluded(row, now)) continue;
    episodes.push({ row, channel, episode });
  }
  // Намеренное молчание ядра (все реплики эпизода удержаны по списку намеренных) — тем же правилом, что у сторожа
  // «клиент ждёт ответа»; причины тикетов одним запросом на всю пачку, не в цикле.
  const keys = [...new Set(episodes.flatMap((e) => e.episode.eventKeys))];
  const codes = keys.length
    ? await db.customerPropertyIngressTicket.findMany({ where: { eventKey: { in: keys } }, select: { eventKey: true, errorCode: true } })
    : [];
  const intentional = new Set(codes.filter((t) => t.errorCode && INTENTIONAL_SILENCE_REASONS.has(t.errorCode)).map((t) => t.eventKey));
  for (const { row, channel, episode } of episodes) {
    if (episodeAllIntentional(episode, intentional)) continue;
    waiting.set(row.id, { key: row.id, channel, since: episode.since });
  }

  for (const ticket of tickets) {
    const channel = watched(ticket.channel);
    if (!channel) continue;
    const key = ticket.conversationId ?? `scope:${ticket.scopeKey}`;
    if (waiting.has(key)) continue;
    const row = ticket.conversationId ? byConversation.get(ticket.conversationId) : undefined;
    if (row) {
      if (conversationExcluded(row, now)) continue;
      // В переписке после этого сообщения уже ответили (бот старым путём или человек): не ждёт.
      const answered = Array.isArray(row.messages) && (row.messages as MessageLike[]).some((m) => m?.role === "assistant" &&
        m.deliveryStatus !== "failed" && (isoAt(m.at)?.getTime() ?? 0) > ticket.receivedAt.getTime());
      if (answered) continue;
      // Переписка ждёт по своей ленте, но реплика клиента в окно не попала (или её там нет) — считаем по тикету.
    } else if (ticket.conversationId) {
      // Переписка вне выборки (старше окна, удалённый клиент) — по её правилам не судим, тикет не считаем.
      continue;
    } else if (isCustomerAgentChannelOff(channel, process.env, ticket.brandName)) {
      continue;
    }
    waiting.set(key, { key, channel, since: ticket.receivedAt });
  }
  return { waiting: [...waiting.values()], lastBotAnswerAt };
}

// ---------------------------------------------------------------- тик

export interface BotSilenceTickResult {
  action: "off" | "busy" | SilenceDecision["kind"];
  alerted: boolean;
}

/** Каналы, выключенные аварийным рубильником целиком (без разбора по аккаунтам): о них тревоги нет. */
function channelsOff(): Set<string> {
  return new Set(SILENCE_WATCHED_CHANNELS.filter((c) => isCustomerAgentChannelOff(c, process.env, null)));
}

export async function runBotSilenceWatchTick(now: Date = new Date()): Promise<BotSilenceTickResult> {
  if (!(await automationSwitchOn("botSilenceWatchEnabled"))) return { action: "off", alerted: false };
  const snapshot = await loadSilenceSnapshot(now);
  const off = channelsOff();
  return prisma.$transaction(async (tx) => {
    // Решение и запись — под одним замком: два процесса не заведут два эпизода и не пошлют одно уведомление дважды.
    const [{ locked }] = await tx.$queryRaw<Array<{ locked: boolean }>>`SELECT pg_try_advisory_xact_lock(hashtext(${LOCK_KEY})) AS locked`;
    if (!locked) return { action: "busy" as const, alerted: false };
    const row = await tx.botSilenceIncident.findFirst({ where: { recoveredAt: null }, orderBy: { detectedAt: "desc" } });
    const open: OpenIncident | null = row
      ? { id: row.id, channels: row.channels, startedAt: row.startedAt, lastAlertAt: row.lastAlertAt,
          missedKeys: Array.isArray(row.missedKeys) ? (row.missedKeys as unknown[]).filter((k): k is string => typeof k === "string") : [] }
      : null;
    const decision = decideBotSilence(snapshot, open, now, off);
    const send = (tag: string, text: { title: string; body: string }, urgent: boolean) => enqueueDirectorAlert({
      ...text, url: ALERT_URL, tag, recipientRoles: [...ALERT_ROLES], ...(urgent ? { level: "CRITICAL" as const, severity: "critical" as const } : {}),
    }, tx);
    if (decision.kind === "open") {
      const created = await tx.botSilenceIncident.create({ data: { channels: decision.channels, startedAt: decision.startedAt,
        detectedAt: now, lastAlertAt: now, missedKeys: decision.keys } });
      const alerted = await send(`bot-silence-${created.id}`,
        silenceAlertText({ channels: decision.channels, since: decision.startedAt, waiting: decision.waiting, reminder: false, now }), true);
      if (!alerted) throw new Error("очередь тревог руководству недоступна");
      return { action: decision.kind, alerted };
    }
    if (decision.kind === "update" && open) {
      let alerted = false;
      if (decision.remind) {
        alerted = await send(`bot-silence-${open.id}`,
          silenceAlertText({ channels: decision.channels, since: open.startedAt, waiting: decision.waiting, reminder: true, now }), true);
        if (!alerted) throw new Error("очередь тревог руководству недоступна");
      }
      await tx.botSilenceIncident.update({ where: { id: open.id }, data: { channels: decision.channels, missedKeys: decision.keys,
        ...(alerted ? { lastAlertAt: now } : {}) } });
      return { action: decision.kind, alerted };
    }
    if (decision.kind === "recover" && open) {
      // Кто-то ещё ждёт — сказать сразу; всем уже ответили — «к сведению», звонок телефона в часы алармов.
      const alerted = await send(`bot-silence-ok-${open.id}`,
        silenceRecoveredText({ channels: open.channels, since: open.startedAt, missed: decision.missed, stillWaiting: decision.stillWaiting, now }),
        decision.stillWaiting > 0);
      if (!alerted) throw new Error("очередь тревог руководству недоступна");
      await tx.botSilenceIncident.update({ where: { id: open.id }, data: { recoveredAt: now } });
      return { action: decision.kind, alerted };
    }
    if (decision.kind === "close" && open) {
      await tx.botSilenceIncident.update({ where: { id: open.id }, data: { recoveredAt: now } });
      return { action: decision.kind, alerted: false };
    }
    return { action: "none" as const, alerted: false };
  }, { timeout: 15_000 });
}
