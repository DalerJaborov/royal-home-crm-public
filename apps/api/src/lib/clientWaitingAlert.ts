import { randomUUID } from "node:crypto";
import { prisma } from "../db.js";
import { TG_PREFIX, TG_DIRECT_PREFIX } from "./conversationId.js";
import { sendPushToAgent } from "../push.js";
import { customerSpamMuteActive, customerSpamMuteFrom } from "../ai/customerSpamMute.js";
import { CUSTOMER_TURN_INTENDED_SILENCE } from "./customerIntendedSilence.js";
import { enqueueDirectorAlert } from "./directorAlertQueue.js";
import { fetchLastCallContactByClient } from "./botPauseWatch.js";
import { isWithinWorkingHours } from "./workingHours.js";
import { logSystemError } from "./systemError.js";
import { reportCronRowError } from "./cronHeartbeat.js";

/**
 * «КЛИЕНТ НАПИСАЛ — ЕМУ НИКТО НЕ ОТВЕТИЛ» (14.11.2026, аудит скрытых механизмов №4).
 *
 * ЗАЧЕМ. Новое ядро бота держит часть сообщений без ответа (HELD) — по делу
 * (эхо своих сообщений, склейка подряд идущих) и не по делу: модель решила
 * «передать сотруднику», а передача не оформлена (`staff_or_supported_reply_required`),
 * сломался контекст, кончились круги. Клиенту в этих случаях — тишина, сотруднику —
 * ни сигнала: был только журнал трассировки. ФАКТ (прод, 7 дней до 14.11): 41 диалог
 * без ответа бота дольше 6 часов. Тот же исход у диалогов, где бот на паузе, а агент
 * не ответил (87 «вечных» пауз, где клиент написал последним).
 *
 * ОДНА ДВЕРЬ — `alertClientWaiting`. Её зовут два места:
 *   1. ядро бота сразу, когда модель выбрала «передать сотруднику», а ответа нет
 *      (lib/customerDmAgentTurn.ts, причины STAFF_NEEDED_NOW_REASONS);
 *   2. сторож `runClientSilenceSweep` (cron.ts, раз в 10 минут, только в часы
 *      раздачи): реплика клиента без ответа бота или человека дольше 30 минут —
 *      ловит ВСЕ остальные причины молчания, не перечисляя их.
 *
 * КОМУ. Закреплённому агенту (действующему) — пушем «Сообщения клиентов». Агента нет —
 * руководству через очередь тревог как СРОЧНОЕ (мимо часов алармов): без агента
 * отвечать должен бот, и раз он молчит, это сбой, а не чья-то медлительность.
 *
 * НЕ ЧАЩЕ ОДНОГО РАЗА НА ЭПИЗОД МОЛЧАНИЯ. Эпизод — от первой неотвеченной реплики
 * клиента до ответа. Клиент дописал ещё — эпизод тот же, второго сигнала нет; ему
 * ответили, а потом он снова остался без ответа — новый эпизод. Метка эпизода —
 * `BotConversation.silenceAlertFor`, ставится атомарно ДО отправки (двое не пройдут).
 *
 * ЧЕГО СТОРОЖ НЕ ТРОГАЕТ: молчание, выбранное намеренно (чужой ролик без вопроса,
 * спам, повтор вложения после нашего вопроса), отписавшихся, клиентов в корзине,
 * и случай, когда агент после реплики ПОЗВОНИЛ клиенту — разговор состоялся.
 */

/** Сколько клиент ждёт ответа, прежде чем сторож скажет человеку. */
export const CLIENT_WAITING_MINUTES = 30;
/** Глубже суток не смотрим: старое молчание — дело утреннего отчёта и сторожа пауз, а не пуша. */
const LOOKBACK_MS = 24 * 60 * 60 * 1000;
/** Предел выборки за тик (правило «у любой выборки есть предел»). */
const SWEEP_LIMIT = 300;

/** Ядро промолчало НАМЕРЕННО — это решение, а не сбой, человека не зовём. Список один
 *  на оба сторожа (lib/customerIntendedSilence.ts): мгновенный после хода и этот. */
export const INTENTIONAL_SILENCE_REASONS: ReadonlySet<string> = new Set(CUSTOMER_TURN_INTENDED_SILENCE);

/** Модель сама решила, что нужен сотрудник, а ответа клиенту нет — звать сразу, не ждать 30 минут. */
export const STAFF_NEEDED_NOW_REASONS: ReadonlySet<string> = new Set(["staff_or_supported_reply_required"]);

type StoredMessage = {
  role?: unknown;
  at?: unknown;
  silentCapture?: unknown;
  deliveryStatus?: unknown;
  customerPropertyAdmission?: { eventKey?: unknown } | null;
};

export interface WaitingEpisode {
  /** Первая неотвеченная реплика клиента — начало эпизода и его ключ. */
  since: Date;
  /** eventKey тикетов ядра у неотвеченных реплик (у старого бота их нет). */
  eventKeys: string[];
  /** Сколько неотвеченных реплик без тикета ядра (их намеренность не доказать). */
  untracked: number;
}

/**
 * Хвост неотвеченных реплик клиента. Чистая функция — проверяется без базы.
 *
 * Ответом считается любая ДОСТАВЛЕННАЯ реплика с нашей стороны — бот, агент из CRM,
 * сотрудник из приложения мессенджера. Реплика бота с `deliveryStatus: "failed"`
 * клиенту не дошла — молчание продолжается. Реплику клиента, записанную самим кодом
 * (`silentCapture`, тихий приём номера), клиент не писал — она не начинает эпизод.
 * Реплика без отметки времени (до 01.08.2026) начало доказать не может — нет эпизода.
 */
export function waitingEpisodeOf(messages: unknown): WaitingEpisode | null {
  if (!Array.isArray(messages)) return null;
  let since: Date | null = null;
  const eventKeys: string[] = [];
  let untracked = 0;
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i] as StoredMessage | null;
    if (!m || typeof m !== "object") continue;
    if (m.role === "assistant") {
      if (m.deliveryStatus === "failed") continue;
      break;
    }
    if (m.role !== "user" || m.silentCapture === true) continue;
    const at = typeof m.at === "string" ? new Date(m.at) : null;
    if (!at || Number.isNaN(at.getTime())) return null;
    since = at;
    const key = m.customerPropertyAdmission?.eventKey;
    if (typeof key === "string") eventKeys.push(key);
    else untracked++;
  }
  return since ? { since, eventKeys, untracked } : null;
}

/** escalate — модель сама решила «нужен сотрудник»; failed — ход бота сломался (лимит шагов,
 *  сбой, очередь сдалась); silence — сторож увидел молчание через 30 минут. */
export type ClientWaitingTrigger = "escalate" | "failed" | "silence";
export type ClientWaitingOutcome = "agent" | "director" | "skipped";

const CHANNEL_NAME: Record<string, string> = {
  INSTAGRAM: "Instagram",
  FACEBOOK: "Facebook",
  WHATSAPP: "WhatsApp",
  TELEGRAM: "Telegram",
  WEBSITE: "чат сайта",
};

/**
 * Откуда переписка. Клиентский бот Meta и чат сайта — `BotConversation`; Telegram-бот
 * и Telegram Direct живут в своих таблицах (15.11.2026, В4 владельца: «никого не
 * пропускать» — до этого их молчание не видел ни один сторож).
 */
export type WaitingChatSource = "bot" | "telegram" | "telegramDirect";

/** Канал отметок эпизода для Telegram-таблиц: у них нет `silenceAlertFor`, а миграция ради отметки не нужна. */
const TELEGRAM_EPISODE_CLAIM = "client-waiting-telegram";

interface WaitingChat {
  /** Как переписку открывает инбокс (`/messages?open=`): у Telegram свой префикс. */
  openId: string;
  name: string;
  messages: unknown;
  agentId: string | null;
  /** Атомарно занять эпизод ДО отправки: true — этот вызов первый. */
  claim(since: Date): Promise<boolean>;
  /** Сигнал не ушёл — снять отметку, следующий тик попробует снова. */
  release(since: Date): Promise<void>;
  /** Ответить из CRM нельзя (Telegram Direct) — подсказка, где отвечать. */
  replyHint: string;
}

const activeAgent = (client: { assignedAgent: { id: string; isActive: boolean } | null } | null | undefined) =>
  client?.assignedAgent?.isActive ? client.assignedAgent.id : null;

async function loadWaitingChat(source: WaitingChatSource, id: string): Promise<WaitingChat | null> {
  const client = { select: { fullName: true, deletedAt: true, assignedAgent: { select: { id: true, isActive: true } } } } as const;
  if (source === "bot") {
    const chat = await prisma.botConversation.findUnique({
      where: { id },
      select: { id: true, name: true, channel: true, messages: true, optedOutAt: true, silenceAlertFor: true, client },
    });
    if (!chat || chat.optedOutAt || chat.client?.deletedAt) return null;
    const previous = chat.silenceAlertFor;
    return {
      openId: chat.id,
      name: chat.client?.fullName?.trim() || chat.name?.trim() || `клиент из ${CHANNEL_NAME[chat.channel] ?? chat.channel}`,
      messages: chat.messages,
      agentId: activeAgent(chat.client),
      replyHint: "Ответьте клиенту.",
      async claim(since) {
        if (previous && previous.getTime() >= since.getTime()) return false;
        const claimed = await prisma.botConversation.updateMany({
          where: { id: chat.id, OR: [{ silenceAlertFor: null }, { silenceAlertFor: { lt: since } }] },
          data: { silenceAlertFor: since },
        });
        return claimed.count === 1;
      },
      async release(since) {
        await prisma.botConversation.updateMany({ where: { id: chat.id, silenceAlertFor: since }, data: { silenceAlertFor: previous } });
      },
    };
  }
  const chat = source === "telegram"
    ? await prisma.telegramConversation.findUnique({ where: { id }, select: { id: true, username: true, messages: true, client } })
    : await prisma.telegramDirectConversation.findUnique({ where: { id }, select: { id: true, username: true, messages: true, client } });
  if (!chat || chat.client?.deletedAt) return null;
  const key = (since: Date) => `${source}:${chat.id}:${since.toISOString()}`;
  return {
    openId: `${source === "telegram" ? TG_PREFIX : TG_DIRECT_PREFIX}${chat.id}`,
    name: chat.client?.fullName?.trim() || (chat.username ? `@${chat.username}` : "клиент из Telegram"),
    messages: chat.messages,
    agentId: activeAgent(chat.client),
    // Telegram Direct из CRM не отвечает (инбокс: canReply=false) — честно говорим, где отвечать.
    replyHint: source === "telegram" ? "Ответьте клиенту." : "Ответьте клиенту в Telegram — из CRM в эту переписку ответить нельзя.",
    async claim(since) {
      const claimed = await prisma.$executeRaw`INSERT INTO "ProcessedMessage" ("id","channel","messageId","createdAt","completedAt")
        VALUES (${randomUUID()},${TELEGRAM_EPISODE_CLAIM},${key(since)},now(),now()) ON CONFLICT ("channel","messageId") DO NOTHING`;
      return claimed === 1;
    },
    async release(since) {
      await prisma.processedMessage.deleteMany({ where: { channel: TELEGRAM_EPISODE_CLAIM, messageId: key(since) } });
    },
  };
}

/**
 * ОДНА ДВЕРЬ: сказать ответственному, что клиент ждёт ответа. Идемпотентна по
 * эпизоду молчания: второй вызов на тот же эпизод (ядро + сторож, два тика)
 * ничего не шлёт. Одна и та же для всех таблиц переписок (`source`).
 */
export async function alertClientWaiting(input: {
  conversationId: string;
  /** По умолчанию — `BotConversation` (Meta и чат сайта). */
  source?: WaitingChatSource;
  trigger: ClientWaitingTrigger;
  /** Для failed: почему бот не ответил, простыми словами (без служебных кодов). */
  why?: string;
  now?: Date;
}): Promise<ClientWaitingOutcome> {
  const now = input.now ?? new Date();
  const chat = await loadWaitingChat(input.source ?? "bot", input.conversationId);
  if (!chat) return "skipped";
  const episode = waitingEpisodeOf(chat.messages);
  // Ядро держит ход ДО записи ответа, но реплика клиента к этому моменту уже в
  // истории; нет её (или нет времени) — для эскалации начало эпизода «сейчас».
  const since = episode?.since ?? (input.trigger !== "silence" ? now : null);
  if (!since) return "skipped";

  // Атомарная метка эпизода ДО отправки: два одновременных вызова не пройдут оба.
  if (!(await chat.claim(since))) return "skipped";

  const name = chat.name;
  const waitedMin = Math.max(0, Math.round((now.getTime() - since.getTime()) / 60_000));
  const body =
    input.trigger === "escalate"
      ? `${name}: бот решил, что нужен сотрудник, и не ответил. ${chat.replyHint}`
      : input.trigger === "failed"
        // Правда о причине (ревью 193-3, 15.11): бот сломался, а не «решил».
        ? `${name}: ${input.why ?? "бот не смог подготовить ответ"} — клиент без ответа. ${chat.replyHint}`
        : `${name}: ждёт ответа в переписке ${waitedMin} мин. Ни бот, ни сотрудник не ответили.` +
          (chat.replyHint === "Ответьте клиенту." ? "" : ` ${chat.replyHint}`);
  const url = `/messages?open=${chat.openId}`;
  const tag = `client-waiting-${chat.openId}`;
  const agent = chat.agentId;

  try {
    if (agent) {
      await sendPushToAgent(agent, { kind: "message", level: "CRITICAL", title: "💬 Клиент ждёт ответа", body, url, tag });
      return "agent";
    }
    const queued = await enqueueDirectorAlert({
      title: "💬 Клиент ждёт ответа, агента нет",
      body,
      url,
      kind: "message",
      level: "CRITICAL",
      severity: "critical",
      tag,
      recipientRoles: ["DIRECTOR", "ADMIN"],
    });
    if (!queued) throw new Error("очередь тревог руководству недоступна");
    return "director";
  } catch (err) {
    // Сигнал не ушёл — снимаем метку эпизода, следующий тик попробует снова.
    await chat.release(since).catch(() => {});
    void logSystemError(
      "api",
      `Сигнал «клиент ждёт ответа» не отправлен: ${err instanceof Error ? err.message : String(err)}`,
      { dedupKey: "client-waiting-alert-failed" }
    );
    return "skipped";
  }
}

export interface ClientSilenceSweepResult {
  checked: number;
  alerted: number;
  skippedOffHours: boolean;
}

/**
 * СТОРОЖ МОЛЧАНИЯ — тик крона. Только в часы раздачи (то же окно, что у круга
 * лидов и у тихих часов пушей, lib/workingHours.ts): ночью отвечать некому, а
 * утренний первый тик подберёт ночные эпизоды.
 */
export async function runClientSilenceSweep(now: Date = new Date()): Promise<ClientSilenceSweepResult> {
  if (!(await isWithinWorkingHours(now))) return { checked: 0, alerted: 0, skippedOffHours: true };
  const bot = await sweepBotConversations(now);
  // Telegram-бот и Telegram Direct — тот же сторож и та же дверь (15.11.2026, В4); свой рубильник.
  const telegram = await sweepTelegramConversations(now);
  return { checked: bot.checked + telegram.checked, alerted: bot.alerted + telegram.alerted, skippedOffHours: false };
}

/** Рубильник «Telegram: клиент без ответа — сказать человеку» (Settings.telegramSilenceWatchEnabled). */
export async function isTelegramSilenceWatchEnabled(): Promise<boolean> {
  const s = await prisma.settings.findUnique({ where: { id: "singleton" }, select: { telegramSilenceWatchEnabled: true } });
  return s?.telegramSilenceWatchEnabled ?? true;
}

/**
 * Telegram-бот (TelegramConversation) и Telegram Direct (TelegramDirectConversation).
 * Тикетов ядра у них нет, поэтому намеренное молчание ядра здесь не различается: любой
 * хвост реплик клиента без ответа дольше CLIENT_WAITING_MINUTES — сигнал. Спам, звонок
 * агента после реплики и клиент в корзине — как у основной выборки.
 */
async function sweepTelegramConversations(now: Date): Promise<{ checked: number; alerted: number }> {
  if (!(await isTelegramSilenceWatchEnabled())) return { checked: 0, alerted: 0 };
  const since = new Date(now.getTime() - LOOKBACK_MS);
  type Row = { id: string; messages: unknown; leadDraft: unknown; clientId: string | null };
  const [bots, direct] = await Promise.all([
    prisma.$queryRaw<Row[]>`
      SELECT t.id, t.messages, t."leadDraft", t."clientId"
      FROM "TelegramConversation" t LEFT JOIN "Client" c ON c.id = t."clientId"
      WHERE t."lastMessageAt" >= ${since} AND c."deletedAt" IS NULL
        AND jsonb_typeof(t.messages) = 'array' AND jsonb_array_length(t.messages) > 0
        AND (t.messages -> -1 ->> 'role' = 'user'
          OR (t.messages -> -1 ->> 'role' = 'assistant' AND t.messages -> -1 ->> 'deliveryStatus' = 'failed'))
      ORDER BY t."lastMessageAt" ASC LIMIT ${SWEEP_LIMIT}`,
    prisma.$queryRaw<Row[]>`
      SELECT t.id, t.messages, t."leadDraft", t."clientId"
      FROM "TelegramDirectConversation" t LEFT JOIN "Client" c ON c.id = t."clientId"
      WHERE t."lastMessageAt" >= ${since} AND c."deletedAt" IS NULL
        AND jsonb_typeof(t.messages) = 'array' AND jsonb_array_length(t.messages) > 0
        AND (t.messages -> -1 ->> 'role' = 'user'
          OR (t.messages -> -1 ->> 'role' = 'assistant' AND t.messages -> -1 ->> 'deliveryStatus' = 'failed'))
      ORDER BY t."lastMessageAt" ASC LIMIT ${SWEEP_LIMIT}`,
  ]);
  const threshold = now.getTime() - CLIENT_WAITING_MINUTES * 60_000;
  const due: Array<{ id: string; source: WaitingChatSource; clientId: string | null; since: Date }> = [];
  for (const [source, rows] of [["telegram", bots], ["telegramDirect", direct]] as const) {
    for (const row of rows) {
      const episode = waitingEpisodeOf(row.messages);
      if (!episode || episode.since.getTime() > threshold) continue;
      const draft = row.leadDraft;
      const spam = draft && typeof draft === "object" && !Array.isArray(draft) ? (draft as Record<string, unknown>).spamMute : undefined;
      if (customerSpamMuteActive(customerSpamMuteFrom(spam), now)) continue;
      due.push({ id: row.id, source, clientId: row.clientId, since: episode.since });
    }
  }
  if (!due.length) return { checked: bots.length + direct.length, alerted: 0 };
  const lastCall = await fetchLastCallContactByClient([...new Set(due.map((d) => d.clientId).filter((id): id is string => !!id))]);
  let alerted = 0;
  for (const d of due) {
    try {
      const called = d.clientId ? lastCall.get(d.clientId) : undefined;
      if (called && called.getTime() > d.since.getTime()) continue;
      const outcome = await alertClientWaiting({ conversationId: d.id, source: d.source, trigger: "silence", now });
      if (outcome !== "skipped") alerted++;
    } catch (err) {
      reportCronRowError("Сторож «клиент ждёт ответа» (Telegram)", d.id, err);
    }
  }
  return { checked: bots.length + direct.length, alerted };
}

async function sweepBotConversations(now: Date): Promise<{ checked: number; alerted: number }> {

  // Предвыборка в базе: последняя реплика — клиента (или недоставленный ответ бота),
  // переписка свежая, не отписан. Хвост и эпизод считает waitingEpisodeOf.
  const rows = await prisma.$queryRaw<
    Array<{ id: string; messages: unknown; leadDraft: unknown; silenceAlertFor: Date | null; clientId: string | null }>
  >`
    SELECT bc.id, bc.messages, bc."leadDraft", bc."silenceAlertFor", bc."clientId"
    FROM "BotConversation" bc
    LEFT JOIN "Client" c ON c.id = bc."clientId"
    WHERE bc."lastMessageAt" >= ${new Date(now.getTime() - LOOKBACK_MS)}
      AND bc."optedOutAt" IS NULL
      AND c."deletedAt" IS NULL
      AND jsonb_typeof(bc.messages) = 'array'
      AND jsonb_array_length(bc.messages) > 0
      AND (
        bc.messages -> -1 ->> 'role' = 'user'
        OR (bc.messages -> -1 ->> 'role' = 'assistant' AND bc.messages -> -1 ->> 'deliveryStatus' = 'failed')
      )
    -- Ещё ни разу не сигналившие — первыми: уже сказанное о прошлом эпизоде не должно
    -- вытеснить из предела новое молчание.
    ORDER BY (bc."silenceAlertFor" IS NOT NULL) ASC, bc."lastMessageAt" ASC
    LIMIT ${SWEEP_LIMIT}
  `;

  const threshold = now.getTime() - CLIENT_WAITING_MINUTES * 60_000;
  const due: Array<{ id: string; clientId: string | null; episode: WaitingEpisode }> = [];
  for (const row of rows) {
    const episode = waitingEpisodeOf(row.messages);
    if (!episode || episode.since.getTime() > threshold) continue;
    if (row.silenceAlertFor && row.silenceAlertFor.getTime() >= episode.since.getTime()) continue;
    const draft = row.leadDraft;
    const spam = draft && typeof draft === "object" && !Array.isArray(draft) ? (draft as Record<string, unknown>).spamMute : undefined;
    if (customerSpamMuteActive(customerSpamMuteFrom(spam), now)) continue;
    due.push({ id: row.id, clientId: row.clientId, episode });
  }
  if (due.length === 0) return { checked: rows.length, alerted: 0 };

  // Намеренное молчание ядра: эпизод пропускаем, только если ВСЕ его реплики
  // удержаны намеренно. Одним запросом на пачку, не в цикле.
  const keys = [...new Set(due.flatMap((d) => d.episode.eventKeys))];
  const tickets = keys.length
    ? await prisma.customerPropertyIngressTicket.findMany({ where: { eventKey: { in: keys } }, select: { eventKey: true, errorCode: true } })
    : [];
  const intentional = new Set(tickets.filter((t) => t.errorCode && INTENTIONAL_SILENCE_REASONS.has(t.errorCode)).map((t) => t.eventKey));
  // Звонок агента после первой неотвеченной реплики — разговор был, тоже одним запросом.
  const lastCall = await fetchLastCallContactByClient([...new Set(due.map((d) => d.clientId).filter((id): id is string => !!id))]);

  let alerted = 0;
  for (const d of due) {
    try {
      const allIntentional = d.episode.untracked === 0 && d.episode.eventKeys.every((k) => intentional.has(k));
      if (allIntentional) continue;
      const called = d.clientId ? lastCall.get(d.clientId) : undefined;
      if (called && called.getTime() > d.episode.since.getTime()) continue;
      const outcome = await alertClientWaiting({ conversationId: d.id, trigger: "silence", now });
      if (outcome !== "skipped") alerted++;
    } catch (err) {
      reportCronRowError("Сторож «клиент ждёт ответа»", d.id, err);
    }
  }
  return { checked: rows.length, alerted };
}
