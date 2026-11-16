import { randomUUID } from "node:crypto";
import { prisma } from "../db.js";
import { TG_PREFIX, TG_DIRECT_PREFIX } from "./conversationId.js";
import { silentTurnReason } from "../messengers/replyChain.js";
import type { ChatMessage } from "../ai/client.js";
import { sendPushToAgent } from "../push.js";
import { customerSpamMuteActive, customerSpamMuteFrom } from "../ai/customerSpamMute.js";
import { CUSTOMER_TURN_INTENDED_SILENCE } from "./customerIntendedSilence.js";
import { enqueueDirectorAlert } from "./directorAlertQueue.js";
import { fetchLastCallContactByClient, loadBotPauseWatchSettings } from "./botPauseWatch.js";
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
/** follow_up — бот ответил клиенту «это скажет агент» / «агент позвонит» (15.11.2026): обещание правдиво, только
 *  если ответственный узнал. Эпизод — эта реплика клиента (`since`), а не окно в 6 ч: каждое обещание доходит. */
export type ClientWaitingTrigger = "escalate" | "failed" | "silence" | "follow_up";

/** A person (an agent in the CRM or staff from the messenger app) answered in the chat after `since`. Pure. */
export function humanRepliedSince(messages: unknown, since: Date): boolean {
  if (!Array.isArray(messages)) return false;
  return messages.some(raw => {
    const m = raw as { role?: unknown; at?: unknown; by?: { kind?: unknown } | null } | null;
    if (!m || m.role !== "assistant" || typeof m.at !== "string") return false;
    const kind = m.by && typeof m.by === "object" ? m.by.kind : undefined;
    return (kind === "agent" || kind === "manual") && new Date(m.at).getTime() > since.getTime();
  });
}
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
  /** Последний сигнал «клиент ждёт» по этой переписке (только BotConversation; у Telegram-таблиц нет). */
  lastAlertAt: Date | null;
  /** Клиент CRM — чтобы звонок после сигнала считался ответом (ревью #205, С-4). */
  clientId: string | null;
}

const activeAgent = (client: { assignedAgent: { id: string; isActive: boolean } | null } | null | undefined) =>
  client?.assignedAgent?.isActive ? client.assignedAgent.id : null;

async function loadWaitingChat(source: WaitingChatSource, id: string): Promise<WaitingChat | null> {
  const client = { select: { fullName: true, deletedAt: true, assignedAgent: { select: { id: true, isActive: true } } } } as const;
  if (source === "bot") {
    const chat = await prisma.botConversation.findUnique({
      where: { id },
      select: { id: true, name: true, channel: true, messages: true, optedOutAt: true, silenceAlertFor: true, clientId: true, client },
    });
    if (!chat || chat.optedOutAt || chat.client?.deletedAt) return null;
    const previous = chat.silenceAlertFor;
    return {
      openId: chat.id,
      name: chat.client?.fullName?.trim() || chat.name?.trim() || `клиент из ${CHANNEL_NAME[chat.channel] ?? chat.channel}`,
      messages: chat.messages,
      agentId: activeAgent(chat.client),
      replyHint: "Ответьте клиенту.",
      lastAlertAt: previous,
      clientId: chat.clientId,
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
    lastAlertAt: null,
    // follow_up по звонку проверяется только при lastAlertAt — у Telegram-таблиц его нет.
    clientId: null,
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
  /** Для follow_up: время реплики клиента, на которую бот пообещал агента (ключ эпизода). */
  since?: Date;
  now?: Date;
}): Promise<ClientWaitingOutcome> {
  const now = input.now ?? new Date();
  const chat = await loadWaitingChat(input.source ?? "bot", input.conversationId);
  if (!chat) return "skipped";
  const episode = waitingEpisodeOf(chat.messages);
  // Ядро держит ход ДО записи ответа, но реплика клиента к этому моменту уже в
  // истории; нет её (или нет времени) — для эскалации начало эпизода «сейчас».
  const since = input.since ?? episode?.since ?? (input.trigger !== "silence" ? now : null);
  if (!since) return "skipped";
  // «Агент уточнит» — one CRITICAL per chat until a person answers in the chat (re-review #201, Н-нов-3; owner: rarely
  // disturb people): three empty searches in a row are one signal, not three.
  // A completed CALL after the previous signal is an answer too (review #205, С-4): the agent who phoned the customer learns
  // about the NEXT promise "the agent will tell", instead of never hearing of this chat again.
  if (input.trigger === "follow_up" && chat.lastAlertAt && !humanRepliedSince(chat.messages, chat.lastAlertAt)) {
    const called = chat.clientId ? (await fetchLastCallContactByClient([chat.clientId])).get(chat.clientId) : undefined;
    if (!called || called.getTime() <= chat.lastAlertAt.getTime()) return "skipped";
  }

  // Атомарная метка эпизода ДО отправки: два одновременных вызова не пройдут оба.
  if (!(await chat.claim(since))) return "skipped";

  const name = chat.name;
  const waitedMin = Math.max(0, Math.round((now.getTime() - since.getTime()) / 60_000));
  const body =
    input.trigger === "follow_up"
      // Подсказка, где отвечать (Telegram Direct: из CRM нельзя), потерялась при своде #201 с #198 — возвращена 16.11.
      ? `${name}: бот ответил клиенту, что это уточнит агент. ${chat.replyHint === "Ответьте клиенту." ? "Ответьте клиенту или позвоните." : chat.replyHint}`
      : input.trigger === "escalate"
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
      // Бот Telegram промолчал НАМЕРЕННО («ок, спасибо» без нашего вопроса, повтор чужого поста, повтор фото) —
      // тот же признак, по которому молчит сам бот (messengers/replyChain.ts::silentTurnReason), не второй список.
      if (telegramSilenceIntended(row.messages, episode.since)) continue;
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

/** Хвост реплик клиента — то, на что бот Telegram молчит по своему же правилу. Чистая функция. */
export function telegramSilenceIntended(messages: unknown, since: Date): boolean {
  if (!Array.isArray(messages)) return false;
  const start = messages.findIndex((m) => {
    const at = (m as { at?: unknown } | null)?.at;
    return (m as { role?: unknown } | null)?.role === "user" && typeof at === "string" && new Date(at).getTime() === since.getTime();
  });
  if (start < 0) return false;
  const tail = messages.slice(start) as Array<Record<string, unknown>>;
  const text = tail.filter((m) => m.role === "user").map((m) => (typeof m.content === "string" ? m.content : "")).join("\n").trim();
  const hasMedia = tail.some((m) => m.role === "user" && (m.attachments !== undefined || m.media !== undefined || m.photo !== undefined));
  return silentTurnReason({ text, hasMedia, history: messages.slice(0, start) as ChatMessage[] }) !== null;
}

async function sweepBotConversations(now: Date): Promise<{ checked: number; alerted: number }> {

  // Предвыборка в базе: последняя реплика — клиента (или недоставленный ответ бота),
  // переписка свежая, не отписан. Хвост и эпизод считает waitingEpisodeOf.
  const rows = await prisma.$queryRaw<
    Array<{ id: string; messages: unknown; leadDraft: unknown; silenceAlertFor: Date | null; clientId: string | null; pausedUntil: Date | null }>
  >`
    SELECT bc.id, bc.messages, bc."leadDraft", bc."silenceAlertFor", bc."clientId", bc."pausedUntil"
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
  const repeat: Array<{ id: string; clientId: string | null; episode: WaitingEpisode }> = [];
  for (const row of rows) {
    const episode = waitingEpisodeOf(row.messages);
    if (!episode || episode.since.getTime() > threshold) continue;
    const draft = row.leadDraft;
    const spam = draft && typeof draft === "object" && !Array.isArray(draft) ? (draft as Record<string, unknown>).spamMute : undefined;
    if (customerSpamMuteActive(customerSpamMuteFrom(spam), now)) continue;
    if (row.silenceAlertFor && row.silenceAlertFor.getTime() >= episode.since.getTime()) {
      // Already signalled once. A person TOOK this chat (the bot is paused) and the customer is still unanswered:
      // the second, last signal (repeatClientWaiting). The bot stays paused (owner decision on the pause unchanged).
      if (row.pausedUntil && row.pausedUntil.getTime() > now.getTime() && personTookChat(row.messages) &&
          now.getTime() - episode.since.getTime() <= REPEAT_EPISODE_MAX_AGE_MS) {
        repeat.push({ id: row.id, clientId: row.clientId, episode });
      }
      continue;
    }
    due.push({ id: row.id, clientId: row.clientId, episode });
  }
  if (due.length === 0 && repeat.length === 0) return { checked: rows.length, alerted: 0 };

  // Намеренное молчание ядра: эпизод пропускаем, только если ВСЕ его реплики
  // удержаны намеренно. Одним запросом на пачку, не в цикле.
  const keys = [...new Set([...due, ...repeat].flatMap((d) => d.episode.eventKeys))];
  const tickets = keys.length
    ? await prisma.customerPropertyIngressTicket.findMany({ where: { eventKey: { in: keys } }, select: { eventKey: true, errorCode: true } })
    : [];
  const intentional = new Set(tickets.filter((t) => t.errorCode && INTENTIONAL_SILENCE_REASONS.has(t.errorCode)).map((t) => t.eventKey));
  // Звонок агента после первой неотвеченной реплики — разговор был, тоже одним запросом.
  const lastCall = await fetchLastCallContactByClient([...new Set([...due, ...repeat].map((d) => d.clientId).filter((id): id is string => !!id))]);

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
  const repeatOn = repeat.length > 0 && (await loadBotPauseWatchSettings()).enabled;
  for (const d of repeatOn ? repeat : []) {
    try {
      const allIntentional = d.episode.untracked === 0 && d.episode.eventKeys.every((k) => intentional.has(k));
      if (allIntentional) continue;
      const called = d.clientId ? lastCall.get(d.clientId) : undefined;
      if (called && called.getTime() > d.episode.since.getTime()) continue;
      if ((await repeatClientWaiting({ conversationId: d.id, since: d.episode.since, now })) === "sent") alerted++;
    } catch (err) {
      reportCronRowError("Сторож «клиент ждёт ответа» (повтор)", d.id, err);
    }
  }
  return { checked: rows.length, alerted };
}

/**
 * ВЗЯЛ ЧАТ И НЕ ОТВЕТИЛ — ВТОРОЙ И ПОСЛЕДНИЙ СИГНАЛ (16.11.2026, аудит молчания: 3 горячие переписки, напр.
 * Arvan: клиентка ответила агенту про бюджет 15.11 13:48 и ждала 19 часов; бот на «вечной» паузе, первый пуш
 * ушёл один раз — и всё).
 *
 * Только для переписок, где бот на паузе (человек взял разговор), эпизод уже сигналили (silenceAlertFor), а
 * ответа всё нет CLIENT_WAITING_REPEAT_MINUTES с момента, когда сторож впервые увидел этот сигнал (сторож ходит
 * только в рабочие часы). Тогда — ответственному (если есть) И руководству, один раз на эпизод. Паузу не трогает:
 * решение владельца про паузу (botPauseWatch 24/72 ч) прежнее. Метки в «ProcessedMessage», без миграции:
 * `client-waiting-repeat-armed` (сторож впервые увидел сигнал) и `client-waiting-repeat` (повтор ушёл).
 */
export const CLIENT_WAITING_REPEAT_MINUTES = 120;
/** Only a fresh episode is repeated (review #205, С-2/М-3): no wake-up for old pauses right after a deploy (ФАКТ prod
 *  16.11: 2 such chats in the last 24 h), and the ProcessedMessage marks (cleaned after 3 days) never re-arm it. */
const REPEAT_EPISODE_MAX_AGE_MS = 24 * 60 * 60 * 1000;

/**
 * A PERSON took the chat (review #205, С-1): the last message from our side before the customer's unanswered tail is a
 * human's (an agent in the CRM or staff from the messenger app). A pause the bot set itself (repeat shield, off-topic
 * hand-over) is not "an employee took the chat" — that silence is the 30-minute sweep's, with its own words. Pure.
 */
export function personTookChat(messages: unknown): boolean {
  if (!Array.isArray(messages)) return false;
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i] as { role?: unknown; by?: { kind?: unknown } | null } | null;
    if (!m || m.role !== "assistant") continue;
    const kind = m.by && typeof m.by === "object" ? m.by.kind : undefined;
    return kind === "agent" || kind === "manual";
  }
  return false;
}
const REPEAT_ARMED = "client-waiting-repeat-armed";
const REPEAT_SENT = "client-waiting-repeat";

export async function repeatClientWaiting(input: { conversationId: string; since: Date; now?: Date }): Promise<"sent" | "armed" | "skipped"> {
  const now = input.now ?? new Date();
  const key = `${input.conversationId}:${input.since.toISOString()}`;
  // Armed once: the timer starts when the sweep first sees the signalled episode, so a night message signalled at the
  // first morning tick is not repeated ten minutes later.
  await prisma.$executeRaw`INSERT INTO "ProcessedMessage" ("id","channel","messageId","createdAt","completedAt")
    VALUES (${randomUUID()},${REPEAT_ARMED},${key},${now},${now}) ON CONFLICT ("channel","messageId") DO NOTHING`;
  const armed = await prisma.processedMessage.findFirst({ where: { channel: REPEAT_ARMED, messageId: key }, select: { createdAt: true } });
  if (!armed || now.getTime() - armed.createdAt.getTime() < CLIENT_WAITING_REPEAT_MINUTES * 60_000) return "armed";
  const chat = await prisma.botConversation.findUnique({
    where: { id: input.conversationId },
    select: { id: true, name: true, channel: true, messages: true, optedOutAt: true, pausedUntil: true,
      client: { select: { fullName: true, deletedAt: true, assignedAgent: { select: { id: true, isActive: true } } } } },
  });
  if (!chat || chat.optedOutAt || chat.client?.deletedAt || !chat.pausedUntil || chat.pausedUntil <= now || !personTookChat(chat.messages)) return "skipped";
  if (now.getTime() - input.since.getTime() > REPEAT_EPISODE_MAX_AGE_MS) return "skipped";
  const episode = waitingEpisodeOf(chat.messages);
  if (!episode || episode.since.getTime() !== input.since.getTime()) return "skipped"; // answered meanwhile
  // Atomic: two ticks or two instances never both send.
  const claimed = await prisma.$executeRaw`INSERT INTO "ProcessedMessage" ("id","channel","messageId","createdAt","completedAt")
    VALUES (${randomUUID()},${REPEAT_SENT},${key},${now},${now}) ON CONFLICT ("channel","messageId") DO NOTHING`;
  if (claimed !== 1) return "skipped";
  const name = chat.client?.fullName?.trim() || chat.name?.trim() || `клиент из ${CHANNEL_NAME[chat.channel] ?? chat.channel}`;
  const hours = Math.max(1, Math.round((now.getTime() - input.since.getTime()) / 3_600_000));
  const body = `${name}: переписку взял сотрудник, а клиент ждёт ответа уже ${hours} ч. Ответьте клиенту.`;
  const url = `/messages?open=${chat.id}`;
  const tag = `client-waiting-repeat-${chat.id}`;
  const agent = chat.client?.assignedAgent?.isActive ? chat.client.assignedAgent.id : null;
  let agentPushed = false;
  try {
    if (agent) { await sendPushToAgent(agent, { kind: "message", level: "CRITICAL", title: "💬 Клиент всё ещё ждёт ответа", body, url, tag }); agentPushed = true; }
    const queued = await enqueueDirectorAlert({ title: "💬 Клиент ждёт ответа после передачи сотруднику", body, url, kind: "message",
      level: "CRITICAL", severity: "critical", tag, recipientRoles: ["DIRECTOR", "ADMIN"], ...(agent ? { excludeAgentId: agent } : {}) });
    if (!queued && !agent) throw new Error("очередь тревог руководству недоступна");
    return "sent";
  } catch (err) {
    // Release only when NOBODY was told (review #205, М-5): a pushed agent must not get the same push again in 10 minutes.
    if (!agentPushed) await prisma.processedMessage.deleteMany({ where: { channel: REPEAT_SENT, messageId: key } }).catch(() => {});
    void logSystemError("api", `Повторный сигнал «клиент ждёт ответа» не отправлен: ${err instanceof Error ? err.message : String(err)}`,
      { dedupKey: "client-waiting-repeat-failed" });
    return "skipped";
  }
}
