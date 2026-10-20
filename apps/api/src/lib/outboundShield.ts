import { createHash, randomUUID } from "node:crypto";
import { prisma } from "../db.js";
import { Prisma } from "../generated/prisma/client.js";
import { lockCustomerStateSnapshot, loadCustomerStateSnapshot } from "./customerState.js";
import { customerShieldPauseMatches } from "./customerShieldPause.js";
import { CustomerScopeDenied, customerTransportInput, findScopedBotConversation, resolveCustomerEndpoint,
  type CustomerTransportHint, type CustomerTransportReference } from "./customerConversationScope.js";
import { guardFired } from "../ai/guardMetrics.js";
import { isOwnAccountSender } from "./ownAccountGuard.js";
import { logSystemError } from "./systemError.js";

/**
 * ПРЕДОХРАНИТЕЛЬ ИСХОДЯЩИХ СООБЩЕНИЙ БОТА (владелец 17.09.2026).
 *
 * ЗАЧЕМ. Два инцидента за три дня:
 *   15.09 — два НАШИХ аккаунта (@royalhome.info и @royal.home.tj) вежливо
 *           прощались друг с другом по кругу: защита по своему аккаунту
 *           ослепла, потому что Meta заблокировала резолв профиля;
 *   17.09 — сторож номеров каждые 15 минут дописывал номер клиента в историю
 *           как поддельную реплику, второй крон отвечал на неё, и шесть
 *           кандидатов четыре часа получали «Ташаккур, рақаматонро қабул
 *           кардам…» каждые полчаса.
 *
 * Сценарии разные, исход один: наружу ушло то, чего человек не ждал, много раз
 * подряд. Чинить каждый сценарий по отдельности — гонка, в которой мы всегда
 * вторые. Поэтому щит стоит НЕ в сценарии, а в единой точке отправки, ниже всех
 * кронов, очередей и ходов модели: что бы ни сломалось выше, бот физически не
 * может ни зациклиться, ни завалить человека повторами.
 *
 * ⚠️ ГЛАВНОЕ ОГРАНИЧЕНИЕ (владелец, то же 17.09): «не нужно, чтобы из-за этой
 * защиты бот молчал как рыба настоящим клиентам». Поэтому щит различает два
 * рода исходящих и обращается с ними по-разному:
 *
 *   ОТВЕТ (`reply`) — в диалоге есть настоящее входящее (с идентификатором
 *     провайдера) свежее REPLY_WINDOW_MS. Это разговор с живым человеком.
 *     Его не трогают ни счётчик монолога, ни темп, ни общая пауза. Не пройдёт
 *     он ровно в двух случаях: получатель — наш собственный аккаунт, и третий
 *     дословный повтор одного и того же текста за сутки.
 *
 *   ИНИЦИАТИВА (`initiative`) — всё, что бот затевает сам: кроны, очереди,
 *     напоминания, просьбы о номере, повторы зависших ходов. Именно здесь
 *     случились оба инцидента, и здесь действуют все правила.
 *
 *   РУКА (`staff`) — сообщение живого сотрудника из CRM. Не блокируется
 *     никогда и ничем, только считается в статистике.
 *
 * ПАУЗА, поставленная щитом, снимается сама первым же настоящим входящим от
 * человека (см. noteRealInbound) — и на это входящее бот отвечает как обычно.
 * Состояний, из которых бот не выходит без кнопки, щит не создаёт.
 */

/** Сколько после настоящего входящего исходящее считается ОТВЕТОМ, а не инициативой. */
const REPLY_WINDOW_MS = 10 * 60_000;

/** Правило 1: сообщений бота подряд без настоящего входящего. Пятое блокируется. */
export const MAX_MESSAGES_WITHOUT_INBOUND = 4;

/** Правило 3: темп инициативы в один диалог. */
export const MAX_INITIATIVE_PER_HOUR = 8;
export const MAX_INITIATIVE_PER_DAY = 20;

/** Правило 2: окно, в котором текст считается повтором. */
const REPEAT_WINDOW_MS = 24 * 60 * 60_000;
/** Короткое подтверждение («хорошо», «принял, спасибо») можно повторить один раз. */
const SHORT_CONFIRMATION_WORDS = 3;

/** Правило 5: окно общего пульса и его порог. */
const PULSE_WINDOW_MS = 10 * 60_000;
const PULSE_FLOOR = 60;
const PULSE_MULTIPLIER = 5;
const PULSE_BASELINE_DAYS = 7;
const GLOBAL_PAUSE_MS = 30 * 60_000;

/**
 * Пауза диалога от щита. Срок конечный и заведомо короче суток: настоящий
 * клиент снимет её сам первым же сообщением, а если он не напишет вовсе —
 * молчать вечно из-за сбоя крона мы тоже не хотим.
 */
const SHIELD_PAUSE_MS = 6 * 60 * 60_000;

/** Не чаще раза в сутки на диалог — в журнал и руководству. */
const CONVERSATION_ALERT_INTERVAL_MS = 24 * 60 * 60_000;
/** Общий пульс — не чаще раза в полчаса (столько же длится сама пауза). */
const GLOBAL_ALERT_INTERVAL_MS = GLOBAL_PAUSE_MS;

/** Сколько отпечатков текстов держим в строке состояния. */
const MAX_REMEMBERED_TEXTS = 60;

export type OutboundOrigin = "bot" | "staff";
export type OutboundKind = "reply" | "initiative" | "staff";

export type ShieldReason =
  | "own_account"
  | "monologue"
  | "repeat"
  | "rate_hour"
  | "rate_day"
  | "global_pulse"
  | "shield_pause"
  | "scope_unknown";

/** Человеческие причины — их видит и сотрудник в карточке диалога, и журнал. */
export const SHIELD_REASON_TEXT: Record<ShieldReason, string> = {
  own_account: "получатель — наш же аккаунт, разговор с самим собой",
  monologue: `бот написал ${MAX_MESSAGES_WITHOUT_INBOUND} раза подряд, а человек не отвечал`,
  repeat: "дословный повтор того, что бот уже писал в этом диалоге за сутки",
  rate_hour: `больше ${MAX_INITIATIVE_PER_HOUR} сообщений бота в этот диалог за час`,
  rate_day: `больше ${MAX_INITIATIVE_PER_DAY} сообщений бота в этот диалог за сутки`,
  global_pulse: "всплеск исходящих по всей системе — бот на общей паузе",
  shield_pause: "диалог остановлен щитом, ждём сообщения от человека",
  scope_unknown: "подключение отправителя изменилось или не определено",
};

/**
 * Щит не выпустил сообщение.
 *
 * Именно исключение, а не «отправлено, но без mid»: транспорт возвращает null и
 * когда сообщение УШЛО, просто без идентификатора, — и на этом различии
 * вызывающие пишут реплику в историю переписки. Молчаливый null превратил бы
 * заблокированное сообщение в запись, которой человек никогда не видел.
 */
export class OutboundBlockedError extends Error {
  readonly reason: ShieldReason;
  readonly kind: OutboundKind;
  constructor(verdict: { reason: ShieldReason; kind: OutboundKind; reasonText: string }) {
    super(`Щит исходящих не выпустил сообщение: ${verdict.reasonText}`);
    this.name = "OutboundBlockedError";
    this.reason = verdict.reason;
    this.kind = verdict.kind;
  }
}

export function isOutboundBlockedError(err: unknown): err is OutboundBlockedError {
  return err instanceof OutboundBlockedError;
}

export type OutboundVerdict =
  | { allowed: true; kind: OutboundKind }
  | { allowed: false; kind: OutboundKind; reason: ShieldReason; reasonText: string };

export interface OutboundRequest {
  transport?: CustomerTransportReference;
  /** WHATSAPP | INSTAGRAM | FACEBOOK | TELEGRAM | WEBSITE */
  channel: string;
  /** Получатель: subscriberId у Meta, chatId у Telegram. */
  subscriberId: string;
  text: string;
  /** По умолчанию «бот»: незнакомый путь обязан считаться ботом, а не рукой. */
  origin?: OutboundOrigin;
  /** Имя получателя, если вызывающий его знает (уточняет правило 4). */
  recipientName?: string | null;
  now?: Date;
  /**
   * Щит сторожит только диалоги, которые знает (правило действует для Telegram):
   * служебные чаты сотрудников через ту же телеграмную отправку проходят не
   * тронутыми. `true` — не заводить состояние с нуля, пропустить и ничего не
   * считать, если строки ещё нет.
   */
  onlyIfKnown?: boolean;
}

/** Отпечаток текста: короткий хэш + время + сколько раз. */
interface TextPrint {
  h: string;
  t: number;
  n: number;
}

/**
 * Нормализация текста для правила 2: регистр, пунктуация, эмодзи и пробелы не
 * должны превращать дословный повтор в «другое сообщение».
 */
export function normalizeOutboundText(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();
}

function fingerprint(text: string): string {
  return createHash("sha1").update(normalizeOutboundText(text)).digest("hex").slice(0, 16);
}

function isShortConfirmation(text: string): boolean {
  const normalized = normalizeOutboundText(text);
  if (!normalized) return true;
  return normalized.split(" ").length <= SHORT_CONFIRMATION_WORDS;
}

function readPrints(value: unknown, now: number): TextPrint[] {
  if (!Array.isArray(value)) return [];
  const cutoff = now - REPEAT_WINDOW_MS;
  const out: TextPrint[] = [];
  for (const raw of value) {
    if (!raw || typeof raw !== "object") continue;
    const row = raw as Partial<TextPrint>;
    if (typeof row.h !== "string" || typeof row.t !== "number") continue;
    if (row.t < cutoff) continue;
    out.push({ h: row.h, t: row.t, n: typeof row.n === "number" && row.n > 0 ? row.n : 1 });
  }
  return out.slice(-MAX_REMEMBERED_TEXTS);
}

function countedPrint(prints: TextPrint[], hash: string): number {
  return prints.find((p) => p.h === hash)?.n ?? 0;
}

function withPrint(prints: TextPrint[], hash: string, now: number): TextPrint[] {
  const existing = prints.find((p) => p.h === hash);
  if (existing) {
    existing.n += 1;
    existing.t = now;
    return prints;
  }
  prints.push({ h: hash, t: now, n: 1 });
  return prints.slice(-MAX_REMEMBERED_TEXTS);
}

type ShieldState = {
  endpointScopeId: string | null;
  id: string;
  recipientName: string | null;
  lastInboundAt: Date | null;
  botSentSinceInbound: number;
  hourWindowStart: Date | null;
  hourCount: number;
  dayWindowStart: Date | null;
  dayCount: number;
  recentTexts: unknown;
  pausedUntil: Date | null;
  pausedReason: string | null;
  pausedAt: Date | null;
  pauseFence: unknown;
  loggedAt: Date | null;
  alertedAt: Date | null;
  firedCount: number;
};

const STATE_SELECT = {
  endpointScopeId: true,
  id: true,
  recipientName: true,
  lastInboundAt: true,
  botSentSinceInbound: true,
  hourWindowStart: true,
  hourCount: true,
  dayWindowStart: true,
  dayCount: true,
  recentTexts: true,
  pausedUntil: true,
  pausedReason: true,
  pausedAt: true,
  pauseFence: true,
  loggedAt: true,
  alertedAt: true,
  firedCount: true,
} as const;

interface ShieldKey { channel: string; subscriberId: string; endpointScopeId: string | null; transport?: CustomerTransportReference }
async function shieldKey(channel: string, subscriberId: string, hint?: CustomerTransportHint): Promise<ShieldKey> {
  // Existing Telegram safety is retained separately. It is not a new-core
  // endpoint/native authority and never fabricates a BotConversation.
  if (channel === "TELEGRAM") return { channel, subscriberId, endpointScopeId: null };
  const transport = await resolveCustomerEndpoint(customerTransportInput(channel, subscriberId, hint));
  return { channel, subscriberId, endpointScopeId: transport.endpointScopeId, transport };
}
async function loadState(key: ShieldKey): Promise<ShieldState | null> {
  return prisma.outboundShieldState.findFirst({
    where: { channel: key.channel, subscriberId: key.subscriberId, endpointScopeId: key.endpointScopeId },
    select: STATE_SELECT,
  });
}
async function ensureShieldState(key: ShieldKey): Promise<ShieldState> {
  try {
    const conflict = key.endpointScopeId ? Prisma.sql`("endpointScopeId", "subscriberId")`
      : Prisma.sql`("channel", "subscriberId") WHERE "endpointScopeId" IS NULL`;
    await prisma.$executeRaw(Prisma.sql`
      INSERT INTO "OutboundShieldState" ("id", "channel", "subscriberId", "endpointScopeId", "updatedAt")
      VALUES (${randomUUID()}, ${key.channel}, ${key.subscriberId}, ${key.endpointScopeId}, now())
      ON CONFLICT ${conflict} DO NOTHING`);
  } catch (error) {
    // Gate A may still have an old global row for a different/unmapped scope.
    // That collision is a held namespace, not a DB-error permission to send.
    if (error && typeof error === "object" && "meta" in error && error.meta && typeof error.meta === "object" &&
        "code" in error.meta && error.meta.code === "23505") throw new CustomerScopeDenied("compat_collision");
    throw error;
  }
  const state = await loadState(key);
  if (!state) throw new CustomerScopeDenied("scope_unknown");
  return state;
}

/* ------------------------------------------------------------------------- *
 * ОБЩИЙ ПУЛЬС
 * ------------------------------------------------------------------------- */

function pulseBucket(now: Date): Date {
  const bucket = new Date(now);
  bucket.setUTCSeconds(0, 0);
  return bucket;
}

/**
 * Норма исходящих за 10 минут. Пересчитывается раз в окно: сумма за неделю —
 * запрос по индексу первичного ключа, но звать его на каждую отправку незачем,
 * норма за 10 минут не меняется.
 */
let baselineCache: { at: number; perWindow: number } | null = null;

export function resetOutboundShieldCache(): void {
  baselineCache = null;
}

async function pulseThreshold(now: Date): Promise<number> {
  if (baselineCache && now.getTime() - baselineCache.at < PULSE_WINDOW_MS) {
    return Math.max(PULSE_FLOOR, Math.round(PULSE_MULTIPLIER * baselineCache.perWindow));
  }
  const from = new Date(now.getTime() - PULSE_BASELINE_DAYS * 24 * 60 * 60_000);
  const total = await prisma.outboundShieldPulse.aggregate({
    where: { bucket: { gte: from, lt: pulseBucket(now) } },
    _sum: { count: true },
  });
  const windows = (PULSE_BASELINE_DAYS * 24 * 60) / (PULSE_WINDOW_MS / 60_000);
  const perWindow = (total._sum.count ?? 0) / windows;
  baselineCache = { at: now.getTime(), perWindow };
  return Math.max(PULSE_FLOOR, Math.round(PULSE_MULTIPLIER * perWindow));
}

async function pulseLastWindow(now: Date): Promise<number> {
  const from = new Date(now.getTime() - PULSE_WINDOW_MS);
  const total = await prisma.outboundShieldPulse.aggregate({
    where: { bucket: { gte: from } },
    _sum: { count: true },
  });
  return total._sum.count ?? 0;
}

async function notePulse(now: Date): Promise<void> {
  const bucket = pulseBucket(now);
  await prisma.outboundShieldPulse.upsert({
    where: { bucket },
    update: { count: { increment: 1 } },
    create: { bucket, count: 1 },
  });
}

/** Действует ли сейчас общая пауза инициативы. */
export async function globalPause(now: Date = new Date()): Promise<Date | null> {
  const row = await prisma.outboundShieldGlobal.findUnique({
    where: { id: 1 },
    select: { pausedUntil: true },
  });
  if (!row?.pausedUntil || row.pausedUntil <= now) return null;
  return row.pausedUntil;
}

async function raiseGlobalPause(now: Date, sentInWindow: number, threshold: number): Promise<void> {
  const until = new Date(now.getTime() + GLOBAL_PAUSE_MS);
  const current = await prisma.outboundShieldGlobal.findUnique({ where: { id: 1 } });
  const alertedRecently =
    current?.alertedAt && now.getTime() - current.alertedAt.getTime() < GLOBAL_ALERT_INTERVAL_MS;
  const reason = `${sentInWindow} исходящих за 10 минут при норме ${threshold}`;
  await prisma.outboundShieldGlobal.upsert({
    where: { id: 1 },
    update: { pausedUntil: until, reason, ...(alertedRecently ? {} : { alertedAt: now }) },
    create: { id: 1, pausedUntil: until, reason, alertedAt: now },
  });
  if (alertedRecently) return;
  void logSystemError(
    "ai",
    `Щит исходящих: общая пауза бота на 30 минут — ${reason}. Инициативные сообщения (кроны, напоминания, повторы) не отправляются; ответы живым людям продолжают идти.`,
    { dedupKey: "outbound-shield-global" }
  );
  await raiseAlert({
    tag: "outbound-shield-global",
    title: "Щит исходящих: бот на общей паузе",
    body:
      `За 10 минут бот отправил ${sentInWindow} сообщений при норме ${threshold}. ` +
      "Инициатива бота (напоминания, кроны, повторы) остановлена на 30 минут, ответы живым людям идут как обычно. " +
      "Проверьте журнал ошибок и последние изменения в кронах.",
    intervalMs: GLOBAL_ALERT_INTERVAL_MS,
  });
}

/* ------------------------------------------------------------------------- *
 * ЖУРНАЛ И АЛАРМ
 * ------------------------------------------------------------------------- */

/**
 * Динамический импорт: очередь алармов тянет за собой push и получателей, а щит
 * стоит внутри транспорта (messengers/meta.ts). Статический импорт замкнул бы
 * граф загрузки модулей на ровном месте.
 */
async function raiseAlert(input: { tag: string; title: string; body: string; intervalMs: number }): Promise<void> {
  try {
    const [{ enqueueDirectorAlert }, { shouldAlert }] = await Promise.all([
      import("./directorAlertQueue.js"),
      import("./notifications.js"),
    ]);
    if (!(await shouldAlert(input.tag, input.intervalMs))) return;
    await enqueueDirectorAlert({
      title: input.title,
      body: input.body,
      kind: "system",
      level: "CRITICAL",
      tag: input.tag,
      recipientRoles: ["DIRECTOR", "ADMIN"],
    });
  } catch (err) {
    console.error("[щит] аларм не отправлен:", err instanceof Error ? err.message : err);
  }
}

/* ------------------------------------------------------------------------- *
 * ПАУЗА ДИАЛОГА
 * ------------------------------------------------------------------------- */

/**
 * DIRECT MESSAGES КАНАЛА — ОТДЕЛЬНЫЙ СОБЕСЕДНИК, А НЕ ВЕСЬ КАНАЛ (правка 22.09.2026).
 *
 * В инбоксе Direct Messages `chat_id` ОДИН на всех написавших, людей разносит
 * только `direct_messages_topic_id`. Поэтому ключ щита там составной,
 * `chatId:topicId` (его ставит telegram/api.ts sendMessage), и пауза обязана
 * ложиться на одну строку TelegramDirectConversation, а не на весь канал.
 *
 * Раньше пауза в личке (`chatId` без двоеточия) заодно гасила КАЖДУЮ строку
 * Direct Messages с тем же `chatId` — совпасть эти идентификаторы на практике
 * не могли (у канала он отрицательный), но правило было написано неверно, и
 * стоило подключить щит к Direct как есть, оно накрыло бы весь канал разом.
 * Ровно поэтому щит там и не включали до сих пор.
 */
function directKey(subscriberId: string): { chatId: string; topicId: string } | null {
  const at = subscriberId.lastIndexOf(":");
  if (at <= 0) return null;
  const chatId = subscriberId.slice(0, at);
  const topicId = subscriberId.slice(at + 1);
  return chatId && topicId ? { chatId, topicId } : null;
}

/**
 * Ставит паузу тем же механизмом, что и кнопка «Поставить на паузу» в CRM:
 * pausedUntil + botPausedAt на самом диалоге. Своего признака у щита нет
 * намеренно — иначе у паузы стало бы два источника правды, и кнопка снятия в
 * интерфейсе перестала бы работать.
 */
async function pauseConversation(key: ShieldKey, until: Date, now: Date): Promise<void> {
  const { channel, subscriberId } = key;
  const data = { pausedUntil: until, botPausedAt: now };
  if (channel === "TELEGRAM") {
    const direct = directKey(subscriberId);
    if (direct) {
      // Составной ключ (`chatId:topicId`) значит один конкретный топик Direct
      // Messages — пауза ложится ТОЛЬКО на него, а не на весь чат (см. заголовок
      // функции). Вторую таблицу здесь не трогаем: `chatId` без топика чужой
      // записи не соответствует ровно этому человеку.
      await prisma.telegramDirectConversation
        .updateMany({ where: direct, data: { pausedUntil: until } })
        .catch(() => ({}));
      return;
    }
    // Обе записи — одна пауза одного и того же человека (22.09.2026): порознь
    // перезапуск процесса между ними оставлял щит поднятым лишь в одном из двух
    // телеграм-диалогов, и бот продолжал отвечать во втором. Составной ключ сюда
    // не попадает (см. ветку выше), поэтому `chatId` здесь однозначно определяет
    // и обычный чат, и Direct-запись того же человека.
    await prisma
      .$transaction([
        prisma.telegramConversation.updateMany({ where: { chatId: subscriberId }, data }),
        prisma.telegramDirectConversation.updateMany({
          where: { chatId: subscriberId },
          data: { pausedUntil: until },
        }),
      ])
      .catch(() => []);
    return;
  }
  // Scoped Meta/Website pauses are written atomically with their final native
  // fence in recordFire. No timestamp-only fallback for an unmapped endpoint.
}

/**
 * Снимает ТОЛЬКО свою паузу: в условии стоит ровно то значение, которое щит
 * записал. Паузу, поставленную оператором поверх, мы не трогаем — иначе
 * «сотрудник ведёт диалог сам» молча отменялось бы входящим сообщением.
 */
async function liftShieldPause(key: ShieldKey, until: Date): Promise<void> {
  const { channel, subscriberId } = key;
  const data = { pausedUntil: null, botPausedAt: null };
  if (channel === "TELEGRAM") {
    const direct = directKey(subscriberId);
    if (direct) {
      await prisma.telegramDirectConversation
        .updateMany({ where: { ...direct, pausedUntil: until }, data: { pausedUntil: null } })
        .catch(() => ({}));
      return;
    }
    await prisma.telegramConversation
      .updateMany({ where: { chatId: subscriberId, pausedUntil: until }, data })
      .catch(() => ({}));
    return;
  }
  // Scoped Meta/Website undo is performed in noteRealInbound's locked tx.
}

/* ------------------------------------------------------------------------- *
 * ВХОДЯЩЕЕ
 * ------------------------------------------------------------------------- */

/**
 * НАСТОЯЩЕЕ входящее от человека.
 *
 * Обязателен идентификатор провайдера (`mid` у Meta, `message_id` у Telegram):
 * именно его отсутствие отличает живого человека от реплики, которую дописал в
 * историю наш же код. На этом и сгорел 17.09 сторож номеров — его поддельная
 * запись выглядела как сообщение клиента, и второй крон исправно на неё отвечал.
 *
 * Вызывать ДО обработки хода: здесь снимается пауза щита, и бот обязан успеть
 * ответить на то самое сообщение, которым человек вернулся.
 */
export async function noteRealInbound(input: {
  transport?: CustomerTransportHint;
  channel: string;
  subscriberId: string;
  /** mid / message_id. Пусто — это не входящее, и считать его таковым нельзя. */
  providerId?: string | number | null;
  name?: string | null;
  now?: Date;
  /** Managed FINAL is already fenced to its original controller. Record the
   * actual inbound without changing that controller/native pause afterward. */
  preserveNativeOwner?: true;
}): Promise<void> {
  const providerId = input.providerId == null ? "" : String(input.providerId);
  if (!providerId) return;
  const now = input.now ?? new Date();
  try {
    const key = await shieldKey(input.channel, input.subscriberId, input.transport);
    const previous = await loadState(key);
    const state = previous ?? await ensureShieldState(key);
    if (key.endpointScopeId) {
      const native = await findScopedBotConversation(customerTransportInput(key.channel, key.subscriberId, key.transport));
      await prisma.$transaction(async tx => {
        // Same order as native legacy writers and credential rotation: native,
        // exact scope, policy, inquiry, then the shield row. No shield→native.
        const snapshot = native ? await lockCustomerStateSnapshot(tx, { conversationId: native.id }) : null;
        if (snapshot && !shieldSnapshotMatchesTransport(key, snapshot.fence)) throw new CustomerScopeDenied("account_mismatch");
        await tx.$queryRaw`SELECT "id" FROM "OutboundShieldState" WHERE "id"=${state.id} FOR UPDATE`;
        const current = await tx.outboundShieldState.findUnique({ where: { id: state.id }, select: STATE_SELECT });
        if (!current || current.endpointScopeId !== key.endpointScopeId) throw new CustomerScopeDenied("scope_unknown");
        if (!input.preserveNativeOwner && snapshot && current.pausedUntil && current.pausedAt && customerShieldPauseMatches(current.pauseFence, snapshot.fence)) {
          await tx.botConversation.updateMany({ where: { id: snapshot.fence.nativeId!, endpointScopeId: key.endpointScopeId,
            pausedUntil: current.pausedUntil, botPausedAt: current.pausedAt, propertyChatAgentId: null },
            data: { pausedUntil: null, botPausedAt: null } });
        }
        await tx.outboundShieldState.update({ where: { id: state.id }, data: { lastInboundAt: now,
          lastInboundId: providerId, botSentSinceInbound: 0,
          ...(!input.preserveNativeOwner ? { pausedUntil: null, pausedReason: null, pausedAt: null, pauseFence: Prisma.DbNull } : {}),
          ...(input.name ? { recipientName: input.name } : {}) } });
      });
      return;
    }
    await prisma.outboundShieldState.update({
      where: { id: state.id },
      data: {
        lastInboundAt: now,
        lastInboundId: providerId,
        botSentSinceInbound: 0,
        pausedUntil: null,
        pausedReason: null,
        pausedAt: null,
        ...(input.name ? { recipientName: input.name } : {}),
      },
    });
    // Человек вернулся — щит обязан отпустить диалог сам, без кнопки.
    if (previous?.pausedUntil && previous.pausedUntil > now) {
      await liftShieldPause(key, previous.pausedUntil);
    }
  } catch (err) {
    // Отказ базы не имеет права уронить обработку входящего.
    console.error("[щит] входящее не записано:", err instanceof Error ? err.message : err);
  }
}

function shieldSnapshotMatchesTransport(key: ShieldKey, fence: import("@royal-home/shared").CustomerFence): boolean {
  return !!key.transport && fence.endpoint.endpointScopeId === key.endpointScopeId &&
    fence.endpoint.channel === key.channel && fence.endpoint.peerId === key.subscriberId &&
    fence.endpoint.accountId === key.transport.accountId && fence.scopeRevision === key.transport.scopeRevision;
}

/* ------------------------------------------------------------------------- *
 * ГЛАВНОЕ: ДОПУСК ИСХОДЯЩЕГО
 * ------------------------------------------------------------------------- */

function block(kind: OutboundKind, reason: ShieldReason): OutboundVerdict {
  guardFired("outbound_shield");
  return { allowed: false, kind, reason, reasonText: SHIELD_REASON_TEXT[reason] };
}

/**
 * Пропустить это сообщение наружу?
 *
 * Считает сам: разрешённая отправка тут же попадает в счётчики, отдельного
 * «подтвердите доставку» нет намеренно — вызывающий не обязан помнить второй шаг,
 * а забытый второй шаг превратил бы щит в украшение.
 *
 * Отказ базы = ПРОПУСТИТЬ. Щит не имеет права стать новой причиной, по которой
 * настоящий клиент не получил ответ.
 */
export async function admitOutbound(req: OutboundRequest): Promise<OutboundVerdict> {
  const now = req.now ?? new Date();
  const origin = req.origin ?? "bot";

  try {
    const key = await shieldKey(req.channel, req.subscriberId, req.transport);
    const state = await loadState(key);

    /**
     * ПРАВИЛО 4 — СВОЙ АККАУНТ. Единственное, что блокирует всё и всегда,
     * включая руку сотрудника: переписки между нашими же аккаунтами не бывает
     * полезной, а бывает петлёй (15.09).
     */
    if (
      await isOwnAccountSender({
        senderId: req.subscriberId,
        senderName: req.recipientName ?? state?.recipientName ?? undefined,
      })
    ) {
      await recordFire(key, "own_account", now, state, { pause: false });
      return block(origin === "staff" ? "staff" : "initiative", "own_account");
    }

    // Рука сотрудника: считаем в статистике, не ограничиваем ничем.
    if (origin === "staff") {
      if (state) await bumpSent(state.id, now, "staff", state, req.text);
      return { allowed: true, kind: "staff" };
    }

    // Служебный чат, о котором щит ничего не знает (Telegram сотрудников).
    if (!state && req.onlyIfKnown) return { allowed: true, kind: "initiative" };

    const isReply =
      !!state?.lastInboundAt && now.getTime() - state.lastInboundAt.getTime() <= REPLY_WINDOW_MS;
    const kind: OutboundKind = isReply ? "reply" : "initiative";

    const prints = readPrints(state?.recentTexts, now.getTime());
    const hash = fingerprint(req.text);
    const seen = countedPrint(prints, hash);

    /**
     * ПРАВИЛО 2 — НЕ ПОВТОРЯТЬСЯ, разной строгости (порог — repeatLimitFor).
     *
     * ПАУЗА — ТОЛЬКО ИНИЦИАТИВЕ (аудит ботов 10.10.2026, P0-1). Повтор в ОТВЕТЕ
     * живому человеку — это не петля крона, а неудачная формулировка модели:
     * сообщение не выпускаем, но диалог не глушим на 6 часов. 42 таких паузы за
     * месяц оставили клиентов без ответа; цепочка ответа теперь сама спрашивает
     * щит заранее (repeatBlockedTexts) и вместо повтора отправляет другую реплику.
     */
    if (seen > repeatLimitFor(isReply, req.text)) {
      await recordFire(key, "repeat", now, state, { pause: !isReply });
      return block(kind, "repeat");
    }

    // Ответ живому человеку дальше не проверяется ничем: остальные правила —
    // про инициативу бота, и глушить ими разговор запрещено.
    if (isReply) {
      await bumpSent(state!.id, now, kind, state!, req.text);
      return { allowed: true, kind };
    }

    // Пауза щита глушит ТОЛЬКО инициативу (ответы сюда не доходят — они выше).
    if (state?.pausedUntil && state.pausedUntil > now) {
      return block(kind, "shield_pause");
    }

    // ПРАВИЛО 5 — общий пульс. Пауза общая, но снова только для инициативы.
    if (await globalPause(now)) return block(kind, "global_pulse");

    // ПРАВИЛО 1 — без входящего нет монолога.
    if ((state?.botSentSinceInbound ?? 0) >= MAX_MESSAGES_WITHOUT_INBOUND) {
      await recordFire(key, "monologue", now, state, { pause: true });
      return block(kind, "monologue");
    }

    // ПРАВИЛО 3 — темп.
    const hourCount = windowCount(state?.hourWindowStart, state?.hourCount, now, 60 * 60_000);
    if (hourCount >= MAX_INITIATIVE_PER_HOUR) {
      await recordFire(key, "rate_hour", now, state, { pause: true });
      return block(kind, "rate_hour");
    }
    const dayCount = windowCount(state?.dayWindowStart, state?.dayCount, now, 24 * 60 * 60_000);
    if (dayCount >= MAX_INITIATIVE_PER_DAY) {
      await recordFire(key, "rate_day", now, state, { pause: true });
      return block(kind, "rate_day");
    }

    await bumpSent(state?.id ?? null, now, kind, state, req.text, key);
    await notePulse(now);

    // Порог общего пульса проверяем ПОСЛЕ записи: всплеск должен быть виден на
    // том же сообщении, которое его создало, а не на следующем.
    const inWindow = await pulseLastWindow(now);
    const threshold = await pulseThreshold(now);
    if (inWindow > threshold) await raiseGlobalPause(now, inWindow, threshold);

    return { allowed: true, kind };
  } catch (err) {
    if (err instanceof CustomerScopeDenied) return block(origin === "staff" ? "staff" : "initiative", "scope_unknown");
    console.error("[щит] проверка не выполнена, сообщение пропущено:", err instanceof Error ? err.message : err);
    return { allowed: true, kind: origin === "staff" ? "staff" : "initiative" };
  }
}

/**
 * Сколько раз текст уже можно было сказать, прежде чем следующий — повтор.
 *
 * Инициативе повтор запрещён сразу (коротким подтверждениям — со второго раза):
 * именно дословный повтор и был обоими инцидентами 15 и 17.09.
 *
 * Ответу живому человеку первый повтор разрешён: люди переспрашивают, и «я уже
 * это говорил, поэтому промолчу» — тот самый бот-рыба, которого владелец
 * запретил. Блокируется только ТРЕТЬЕ дословное повторение.
 */
function repeatLimitFor(isReply: boolean, text: string): number {
  return isReply ? 1 : isShortConfirmation(text) ? 1 : 0;
}

/**
 * КАКИЕ ИЗ ЭТИХ ТЕКСТОВ ЩИТ НЕ ВЫПУСТИТ КАК ПОВТОР — ЗАРАНЕЕ, БЕЗ ПОБОЧНЫХ
 * ДЕЙСТВИЙ (аудит ботов 10.10.2026, P0-1).
 *
 * Цепочка ответа (messengers/replyChain.ts::finalizeBotReply) спрашивает это ДО
 * записи реплики в переписку и до отправки: заблокированный на транспорте ответ
 * оставлял в CRM реплику, которой клиент не видел, и сам ход — без ответа. Тот
 * же порог, что у admitOutbound (repeatLimitFor), но ничего не пишет и не
 * считает. Отказ базы — «ничего не блокируется»: щит не имеет права стать
 * причиной молчания.
 */
export async function repeatBlockedTexts(
  channel: string,
  subscriberId: string,
  texts: string[],
  now: Date = new Date(),
  transport?: CustomerTransportHint
): Promise<string[]> {
  if (texts.length === 0) return [];
  try {
    const state = await loadState(await shieldKey(channel, subscriberId, transport));
    if (!state) return [];
    const isReply = !!state.lastInboundAt && now.getTime() - state.lastInboundAt.getTime() <= REPLY_WINDOW_MS;
    const prints = readPrints(state.recentTexts, now.getTime());
    return texts.filter((t) => countedPrint(prints, fingerprint(t)) > repeatLimitFor(isReply, t));
  } catch (err) {
    console.error("[щит] проверка повтора заранее не выполнена:", err instanceof Error ? err.message : err);
    return [];
  }
}

function windowCount(start: Date | null | undefined, count: number | undefined, now: Date, spanMs: number): number {
  if (!start || now.getTime() - start.getTime() >= spanMs) return 0;
  return count ?? 0;
}

async function bumpSent(
  id: string | null,
  now: Date,
  kind: OutboundKind,
  state: ShieldState | null,
  text: string,
  key?: ShieldKey
): Promise<void> {
  const prints = withPrint(readPrints(state?.recentTexts, now.getTime()), fingerprint(text), now.getTime());
  // Рука сотрудника в счётчики темпа не идёт: её щит не ограничивает, и
  // засчитывать её боту значило бы глушить бота за чужую работу.
  const countsToRate = kind === "initiative";
  const hourFresh = windowCount(state?.hourWindowStart, state?.hourCount, now, 60 * 60_000);
  const dayFresh = windowCount(state?.dayWindowStart, state?.dayCount, now, 24 * 60 * 60_000);

  const data = {
    botSentSinceInbound: kind === "staff" ? (state?.botSentSinceInbound ?? 0) : (state?.botSentSinceInbound ?? 0) + 1,
    /**
     * Текст РУКИ сотрудника в память повторов не идёт (17.09.2026).
     *
     * Иначе «Здравствуйте», сказанное агентом, запретило бы то же слово боту, и
     * защита от петли превратилась бы в цензуру нормального разговора. Щит
     * помнит только то, что говорил сам бот.
     */
    ...(kind === "staff" ? {} : { recentTexts: prints as unknown as object }),
    ...(countsToRate
      ? {
          hourWindowStart: hourFresh === 0 ? now : (state?.hourWindowStart ?? now),
          hourCount: hourFresh + 1,
          dayWindowStart: dayFresh === 0 ? now : (state?.dayWindowStart ?? now),
          dayCount: dayFresh + 1,
        }
      : {}),
  };

  if (id) {
    await prisma.outboundShieldState.update({ where: { id }, data });
    return;
  }
  if (!key) return;
  const created = await ensureShieldState(key);
  await prisma.outboundShieldState.update({ where: { id: created.id }, data });
}

/**
 * ПРАВИЛО 6 — сработало, значит автомат: пауза диалога, причина, журнал и аларм.
 * Журнал и аларм — не чаще раза в сутки на диалог, иначе шестью кандидатами
 * 17.09 руководству пришло бы полсотни одинаковых уведомлений.
 */
async function recordFire(
  key: ShieldKey,
  reason: ShieldReason,
  now: Date,
  state: ShieldState | null,
  opts: { pause: boolean }
): Promise<void> {
  const { channel, subscriberId } = key;
  const until = new Date(now.getTime() + SHIELD_PAUSE_MS);
  const shouldLog = !state?.loggedAt || now.getTime() - state.loggedAt.getTime() >= CONVERSATION_ALERT_INTERVAL_MS;

  const row = state ?? await ensureShieldState(key);
  if (opts.pause && key.endpointScopeId) {
    const native = await findScopedBotConversation(customerTransportInput(channel, subscriberId, key.transport));
    await prisma.$transaction(async tx => {
      const before = native ? await lockCustomerStateSnapshot(tx, { conversationId: native.id }) : null;
      if (before && !shieldSnapshotMatchesTransport(key, before.fence)) throw new CustomerScopeDenied("account_mismatch");
      await tx.$queryRaw`SELECT "id" FROM "OutboundShieldState" WHERE "id"=${row.id} FOR UPDATE`;
      const current = await tx.outboundShieldState.findUnique({ where: { id: row.id }, select: STATE_SELECT });
      if (!current || current.endpointScopeId !== key.endpointScopeId) throw new CustomerScopeDenied("scope_unknown");
      // Do not replace a staff/manual pause. A repeated shield pause can be
      // extended only while its exact previous controller fence still owns it.
      const alreadyOurs = before && customerShieldPauseMatches(current.pauseFence, before.fence);
      const changed = before && before.ownerMode !== "HUMAN" && !before.closedAt
        ? await tx.botConversation.updateMany({ where: { id: before.fence.nativeId!, endpointScopeId: key.endpointScopeId,
          propertyChatAgentId: null, optedOutAt: null,
          ...(alreadyOurs ? { pausedUntil: current.pausedUntil, botPausedAt: current.pausedAt }
            : { OR: [{ pausedUntil: null }, { pausedUntil: { lte: now } }] }) },
          data: { pausedUntil: until, botPausedAt: now } }) : { count: 0 };
      // Native AFTER triggers change the epoch: capture the resulting fence,
      // never the pre-pause epoch or an assumed '+1'.
      const after = changed.count > 0 && native ? await loadCustomerStateSnapshot({ conversationId: native.id }, tx) : null;
      await tx.outboundShieldState.update({ where: { id: row.id }, data: { firedCount: { increment: 1 },
        pausedUntil: until, pausedReason: reason, pausedAt: now,
        pauseFence: after ? { version: 1, fence: after.fence } : Prisma.DbNull,
        ...(shouldLog ? { loggedAt: now, alertedAt: now } : {}) } });
    });
  } else await prisma.outboundShieldState.update({
    where: { id: row.id },
    data: {
      firedCount: { increment: 1 },
      ...(opts.pause ? { pausedUntil: until, pausedReason: reason, pausedAt: now } : {}),
      ...(shouldLog ? { loggedAt: now, alertedAt: now } : {}),
    },
  });

  if (opts.pause && !key.endpointScopeId) await pauseConversation(key, until, now);
  if (!shouldLog) return;


  const where = `${channel} ${subscriberId}`;
  // Без паузы (повтор в ответе живому человеку) не обещаем «диалог на паузе» —
  // журнал обязан говорить то, что произошло на самом деле.
  void logSystemError(
    "ai",
    `Щит исходящих остановил бота в диалоге ${where}: ${SHIELD_REASON_TEXT[reason]}. ` +
      (opts.pause
        ? "Диалог поставлен на паузу; она снимется сама, как только человек напишет, или кнопкой «Снять с паузы»."
        : "Не ушло только это сообщение, диалог НЕ на паузе: бот ответит на следующее сообщение человека."),
    { dedupKey: `outbound-shield:${where}` }
  );
  // Дожидаемся: сообщение уже не ушло, спешить некуда, а незамеченное
  // срабатывание щита ровно так же плохо, как незамеченная петля.
  await raiseAlert({
    tag: `outbound-shield:${where}`,
    title: "Щит исходящих остановил бота",
    body:
      `Диалог ${where}: ${SHIELD_REASON_TEXT[reason]}. ` +
      (opts.pause
        ? "Бот в этом диалоге замолчал. Ответы возобновятся сами, как только человек напишет."
        : "Не ушло одно сообщение, бот продолжает отвечать."),
    intervalMs: CONVERSATION_ALERT_INTERVAL_MS,
  });
}

/* ------------------------------------------------------------------------- *
 * ЧТЕНИЕ ДЛЯ ИНТЕРФЕЙСА
 * ------------------------------------------------------------------------- */

export interface ShieldPauseView {
  reason: ShieldReason;
  reasonText: string;
  since: Date | null;
  until: Date;
}

/** Остановлен ли диалог щитом прямо сейчас — для бейджа в карточке переписки. */
export async function shieldPauseFor(
  channel: string,
  subscriberId: string,
  now: Date = new Date(),
  transport?: CustomerTransportHint
): Promise<ShieldPauseView | null> {
  const state = await shieldKey(channel, subscriberId, transport).then(loadState).catch(() => null);
  if (!state?.pausedUntil || state.pausedUntil <= now || !state.pausedReason) return null;
  const reason = state.pausedReason as ShieldReason;
  return {
    reason,
    reasonText: SHIELD_REASON_TEXT[reason] ?? state.pausedReason,
    since: state.pausedAt,
    until: state.pausedUntil,
  };
}

/** Столько же, но пачкой — список переписок рисуется одним запросом, не N+1. */
export async function shieldPausesFor(
  keys: { channel: string; subscriberId: string; transport?: CustomerTransportHint }[],
  now: Date = new Date()
): Promise<Map<string, ShieldPauseView>> {
  const out = new Map<string, ShieldPauseView>();
  if (!keys.length) return out;
  const scoped = (await Promise.all(keys.map(k => shieldKey(k.channel, k.subscriberId, k.transport)
    .catch(error => { if (error instanceof CustomerScopeDenied) return null; throw error; })))).filter((k): k is ShieldKey => k !== null);
  if (!scoped.length) return out;
  const rows = await prisma.outboundShieldState
    .findMany({
      where: { OR: scoped.map((k) => ({ channel: k.channel, subscriberId: k.subscriberId, endpointScopeId: k.endpointScopeId })), pausedUntil: { gt: now } },
      select: { channel: true, subscriberId: true, pausedUntil: true, pausedReason: true, pausedAt: true },
    })
    .catch(() => []);
  for (const row of rows) {
    if (!row.pausedUntil || !row.pausedReason) continue;
    // The legacy view map has a channel:peer key. If callers ask for A and B
    // with the same raw peer, omit the ambiguous badge rather than mislabel it.
    if (scoped.filter(k => k.channel === row.channel && k.subscriberId === row.subscriberId).length !== 1) continue;
    const reason = row.pausedReason as ShieldReason;
    out.set(`${row.channel}:${row.subscriberId}`, {
      reason,
      reasonText: SHIELD_REASON_TEXT[reason] ?? row.pausedReason,
      since: row.pausedAt,
      until: row.pausedUntil,
    });
  }
  return out;
}

/** «Щит исходящих: N срабатываний за сутки» на пульте. */
export async function shieldFiredLastDay(now: Date = new Date()): Promise<number> {
  const from = new Date(now.getTime() - 24 * 60 * 60_000);
  const rows = await prisma.outboundShieldState
    .aggregate({ where: { alertedAt: { gte: from } }, _sum: { firedCount: true } })
    .catch(() => ({ _sum: { firedCount: 0 } }));
  return rows._sum.firedCount ?? 0;
}
