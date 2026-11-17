import { AsyncLocalStorage } from "node:async_hooks";
import { randomUUID } from "node:crypto";
import { prisma } from "../db.js";
import type { MetaSendBlock } from "../generated/prisma/client.js";
import { logSystemAudit } from "./audit.js";
import { logSystemError } from "./systemError.js";
import { raiseCriticalAlarm } from "./channelKeyAlarm.js";
import { CustomerDeliveryHeldError } from "./customerDeliveryTransport.js";
import { currentManualCustomerDeliveryActor } from "./customerManualDeliveryIntent.js";
import { metaSendAccountFor } from "./metaEternalTokens.js";
import { dushanbeDateTimeString } from "./dushanbeTime.js";
import { describeError } from "./describeError.js";

/**
 * META НЕ ПРОПУСКАЕТ ОТПРАВКУ ПО ПРАВИЛАМ — ОДНА ДВЕРЬ (18.11.2026).
 *
 * Владелец 18.11: «надо чтобы арван и все боты работали всегда». Значит, при
 * блокировке канал нельзя «аккуратно выключить и забыть»: бот перестаёт долбить
 * Meta, человек сразу узнаёт НАСТОЯЩУЮ причину, а отправка САМА возобновляется,
 * как только Meta снова пропускает.
 *
 * ЧТО БЫЛО (разведка 18.11, D:/TASKS-2026-11-14/reports/channels-health-2026-11-18.md).
 * 17.11 Instagram Arvan: четыре попытки за шесть минут на одну переписку, три —
 * отказ 368, четвёртую остановил щит, и директору ушла тревога с неверной причиной
 * «бот написал 4 раза подряд». Повтор зависших диалогов готовился пробовать до 46
 * раз за 13 часов, каждый раз с новым текстом от модели. Текст ошибки журнал
 * обрезал, и подкод Meta терялся.
 *
 * КАК ТЕПЕРЬ. Дверь — физический вызов `callGraph` (messengers/meta.ts): через
 * него уходит любая отправка в Meta (ответ бота старым и новым путём, повтор
 * зависших, напоминания, ручная отправка сотрудника, ответ на комментарий, личный
 * ответ на комментарий, шаблон WhatsApp). Там:
 *  1. отказ из списка META_SEND_POLICY_BLOCKS → метка аккаунту (не каналу) и виду
 *     отправки (`dm` / `comment`); код, подкод и fbtrace — отдельными полями
 *     (таблица MetaSendBlock + журнал действий); одна тревога руководству;
 *  2. пока метка стоит — автоматика в этот аккаунт не пишет вовсе, переписка с
 *     ждущим клиентом уходит человеку штатным «клиент ждёт ответа» с настоящей
 *     причиной, один сигнал на переписку за эпизод;
 *  3. после паузы (лесенка META_SEND_PROBE_LADDER_MS) следующая настоящая отправка
 *     — проба, одна на все процессы: прошла — метка снята и руководству «снова
 *     отправляет», не прошла — следующая ступень. Ручная отправка сотрудника из CRM
 *     разрешена всегда и тоже служит пробой.
 *
 * ГОРЯЧИЙ ПУТЬ. Пока меток нет, проверка — чтение кэша процесса (раз в
 * CACHE_TTL_MS один запрос на весь процесс), без поиска аккаунта и без запросов
 * на каждое сообщение. Пустая таблица = прежнее поведение.
 */

// ─── Коды Meta ───

/** Страницы документации, по которым сверены коды (прочитаны 18.11.2026). */
export const META_ERROR_DOCS = {
  graph: "https://developers.facebook.com/docs/graph-api/guides/error-handling/",
  messenger: "https://developers.facebook.com/documentation/business-messaging/messenger-platform/error-codes",
  instagram: "https://developers.facebook.com/documentation/instagram-platform/instagram-graph-api/reference/error-codes",
} as const;

export interface MetaPolicyBlockCode {
  code: number;
  /** Не задан — любой подкод (у 368 Meta подкоды не документирует). */
  subcode?: number;
  /** Смысл по документации Meta. */
  meaning: string;
  doc: string;
}

/**
 * ЕДИНСТВЕННЫЙ СПИСОК кодов «заблокировано / ограничено по правилам». Сверено по
 * документации Meta (META_ERROR_DOCS, 18.11.2026), не по памяти. Код без подкода
 * (4 — лимит запросов, 10 — нет права, 100 — плохой параметр, 10/2534022 —
 * закрытое окно 24 ч) сюда НЕ входит: это не запрет по правилам, метка от них не
 * ставится. Новый код — строкой сюда, со ссылкой на страницу Meta.
 */
export const META_SEND_POLICY_BLOCKS: readonly MetaPolicyBlockCode[] = [
  { code: 368, meaning: "Temporarily blocked for policies violations. Wait and retry the operation.", doc: META_ERROR_DOCS.graph },
  { code: 10, subcode: 1893063, meaning: "You are temporarily restricted from sending messages (Messaging Policies).", doc: META_ERROR_DOCS.messenger },
  { code: 100, subcode: 2534029, meaning: "The business has been blocked from sending messages via the IG Messaging API.", doc: META_ERROR_DOCS.messenger },
  { code: 613, subcode: 2018338, meaning: "Behavior that may be considered bothersome or abusive; further misuse may result in messaging restrictions.", doc: META_ERROR_DOCS.messenger },
  { code: 4, subcode: 2207051, meaning: "We restrict certain activity to protect our community (suspected spam).", doc: META_ERROR_DOCS.instagram },
  { code: 25, subcode: 2207050, meaning: "The Instagram account is restricted (inactive, checkpointed or restricted).", doc: META_ERROR_DOCS.instagram },
];

/** Ошибка Graph API разобранная: поля, которые обрезка текста раньше съедала. */
export interface MetaGraphErrorFields {
  status: number;
  code: number | null;
  subcode: number | null;
  type: string | null;
  fbtraceId: string | null;
  message: string | null;
}

export function parseMetaGraphError(status: number, text: string): MetaGraphErrorFields {
  let error: Record<string, unknown> | undefined;
  try {
    const parsed = JSON.parse(text) as { error?: unknown };
    error = parsed && parsed.error && typeof parsed.error === "object" ? (parsed.error as Record<string, unknown>) : undefined;
  } catch {
    error = undefined;
  }
  const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : typeof v === "string" && /^\d+$/.test(v) ? Number(v) : null);
  const str = (v: unknown) => (typeof v === "string" && v ? v.slice(0, 500) : null);
  return {
    status,
    code: num(error?.code),
    subcode: num(error?.error_subcode),
    type: str(error?.type),
    fbtraceId: str(error?.fbtrace_id),
    message: str(error?.error_user_msg) ?? str(error?.message),
  };
}

export function metaPolicyBlockOf(error: Pick<MetaGraphErrorFields, "code" | "subcode">): MetaPolicyBlockCode | null {
  if (error.code === null) return null;
  return META_SEND_POLICY_BLOCKS.find((b) => b.code === error.code && (b.subcode === undefined || b.subcode === error.subcode)) ?? null;
}

// ─── Что за запрос ───

/** `dm` — личные сообщения (ответ, ручная отправка, личный ответ на комментарий, шаблон WhatsApp); `comment` — публичный ответ под постом. */
export type MetaSendSurface = "dm" | "comment";

/**
 * Вид отправки по адресу и телу: `action` — «печатает…»/«прочитано» (не отправка,
 * пробой не служит), null — не отправка вовсе (публикация, скрытие комментария, чтение).
 */
export function metaSendSurfaceOf(url: string, body: unknown): MetaSendSurface | "action" | null {
  if (!body || typeof body !== "object") return null;
  const value = body as Record<string, unknown>;
  let path: string;
  try { path = new URL(url).pathname; } catch { return null; }
  if (/\/messages$/.test(path)) {
    if (value.sender_action || value.status === "read") return "action";
    return value.recipient || value.to ? "dm" : null;
  }
  if (/\/(comments|replies)$/.test(path) && typeof value.message === "string") return "comment";
  return null;
}

/** Кому шлём личное (id собеседника); у личного ответа на комментарий — null. */
export function metaSendRecipientOf(body: unknown): string | null {
  if (!body || typeof body !== "object") return null;
  const value = body as { recipient?: { id?: unknown }; to?: unknown };
  if (typeof value.recipient?.id === "string") return value.recipient.id;
  return typeof value.to === "string" ? value.to : null;
}

// ─── Лесенка проб ───

const HOUR_MS = 60 * 60_000;
/** Пауза до пробы: 1 ч → 3 ч → 6 ч, дальше каждые 6 ч. Чаще не пробуем: Meta срок не называет, а долбёжка его продлевает. */
export const META_SEND_PROBE_LADDER_MS: readonly number[] = [HOUR_MS, 3 * HOUR_MS, 6 * HOUR_MS];
export function metaSendProbeDelayMs(step: number): number {
  return META_SEND_PROBE_LADDER_MS[Math.min(Math.max(step, 0), META_SEND_PROBE_LADDER_MS.length - 1)];
}
/** Проба держит замок столько — дольше любой отправки с таймаутом; умерший процесс замок не вешает навсегда. */
const PROBE_LEASE_MS = 2 * 60_000;
/** Тревога «запрет» / «снова отправляет» по одной метке не чаще: мигающий аккаунт не звонит директору каждые пять минут. */
const ALARM_FLAP_MS = 30 * 60_000;

// ─── Аккаунт ───

const CHANNEL_NAME: Record<string, string> = { INSTAGRAM: "Instagram", FACEBOOK: "Facebook", WHATSAPP: "WhatsApp" };
const SURFACE_NAME: Record<MetaSendSurface, string> = { dm: "личные сообщения", comment: "ответы на комментарии" };

/** Аккаунт для проверки снаружи: id строки MessengerAccount или null (ключ из Настроек) и канал. */
export interface MetaSendAccountRef {
  accountId: string | null;
  channel: string;
}

export interface MetaSendAccount extends MetaSendAccountRef {
  key: string;
  /** «Arvan Estate (Instagram)». */
  label: string;
}

export function metaSendAccountKey(ref: MetaSendAccountRef): string {
  return ref.accountId ? `account:${ref.accountId}` : `settings:${ref.channel}`;
}

function channelOfRequest(url: string, body: unknown): string {
  if (body && typeof body === "object" && (body as { messaging_product?: unknown }).messaging_product === "whatsapp") return "WHATSAPP";
  return /instagram/i.test(url) ? "INSTAGRAM" : "FACEBOOK";
}

/**
 * Чей аккаунт отправляет: по транспорту (точно), иначе по личному маркеру из снимка
 * аккаунтов (metaEternalTokens.ts). Вызывается только когда метки есть или пришёл
 * отказ по правилам — не на каждое сообщение.
 */
export async function resolveMetaSendAccount(input: {
  token: string;
  url: string;
  body: unknown;
  transport?: { accountId: string | null; channel: string } | null;
}): Promise<MetaSendAccount> {
  const accountId = input.transport?.accountId ?? null;
  let found: Awaited<ReturnType<typeof metaSendAccountFor>> = null;
  try {
    found = await metaSendAccountFor(accountId ? { accountId } : { token: input.token });
  } catch (err) {
    console.warn("[метка Meta] аккаунт не определён по снимку:", describeError(err));
  }
  const channel = found?.channel ?? input.transport?.channel ?? channelOfRequest(input.url, input.body);
  const ref: MetaSendAccountRef = { accountId: found?.accountId ?? accountId, channel };
  const title = found?.title ?? (ref.accountId ? "аккаунт" : CHANNEL_NAME[channel] ?? channel);
  return { ...ref, key: found?.key ?? metaSendAccountKey(ref), label: `${title} (${CHANNEL_NAME[channel] ?? channel})` };
}

// ─── Метки: кэш процесса ───

/** Как часто процесс перечитывает метки. Worker и API — разные процессы: свой отказ видят сразу, чужой — за это время. */
const CACHE_TTL_MS = 15_000;
let cache: { at: number; rows: Map<string, MetaSendBlock> } | null = null;
let loading: Promise<Map<string, MetaSendBlock>> | null = null;
const cacheKey = (accountKey: string, surface: string) => `${accountKey}|${surface}`;

export function resetMetaSendBlockCache(): void {
  cache = null;
  loading = null;
}

async function activeBlocks(): Promise<Map<string, MetaSendBlock>> {
  if (cache && Date.now() - cache.at < CACHE_TTL_MS) return cache.rows;
  if (!loading) {
    // Через Promise.resolve: и синхронный сбой клиента базы (нет модели, урезанная подмена) не роняет отправку.
    loading = Promise.resolve()
      .then(() => prisma.metaSendBlock.findMany({ where: { liftedAt: null }, take: 200 }))
      .then((rows) => {
        const map = new Map(rows.map((r) => [cacheKey(r.accountKey, r.surface), r]));
        cache = { at: Date.now(), rows: map };
        return map;
      })
      .catch((err) => {
        // База не ответила — не роняем отправку: последнее известное или пусто.
        console.warn("[метка Meta] метки не прочитаны:", describeError(err));
        return cache?.rows ?? new Map<string, MetaSendBlock>();
      })
      .finally(() => { loading = null; });
  }
  return loading;
}

function rememberRow(row: MetaSendBlock): void {
  if (!cache) return;
  const key = cacheKey(row.accountKey, row.surface);
  if (row.liftedAt) cache.rows.delete(key);
  else cache.rows.set(key, row);
}

/** Действующая метка аккаунта (в том числе та, по которой уже пора пробовать) или null. */
export async function currentMetaSendBlock(ref: MetaSendAccountRef, surface: MetaSendSurface = "dm"): Promise<MetaSendBlock | null> {
  const blocks = await activeBlocks();
  if (!blocks.size) return null;
  return blocks.get(cacheKey(metaSendAccountKey(ref), surface)) ?? null;
}

/**
 * ДЛЯ ВЫЗЫВАЮЩИХ СНАРУЖИ (например, «номер из комментария → личный ответ»):
 * true — Meta сейчас не пропускает отправку этого аккаунта и автоматике пробовать
 * рано: идти запасным путём. false — метки нет ИЛИ уже пора пробовать (тогда
 * отправка через callGraph и будет пробой; если пробу успел взять другой процесс,
 * callGraph бросит MetaSendBlockedError — ловить его как «заблокировано»,
 * `isMetaSendBlockError`). Дёшево: кэш процесса, без запроса, пока меток нет.
 */
export async function isAccountSendBlocked(account: MetaSendAccountRef, surface: MetaSendSurface = "dm", now: Date = new Date()): Promise<boolean> {
  const block = await currentMetaSendBlock(account, surface);
  if (!block) return false;
  return block.nextProbeAt.getTime() > now.getTime() || (block.probeLeaseUntil?.getTime() ?? 0) > now.getTime();
}

// ─── Ошибки ───

/** Отказ Graph API с разобранными полями (код, подкод, fbtrace); текст прежний — `Graph API HTTP NNN: <тело>`. */
export class MetaGraphCallError extends Error {
  constructor(message: string, readonly graph: MetaGraphErrorFields) {
    super(message);
    this.name = "MetaGraphCallError";
  }
}

/** Meta отказала по правилам прямо сейчас (метка поставлена или продлена). */
export class MetaSendPolicyError extends MetaGraphCallError {
  constructor(message: string, graph: MetaGraphErrorFields, readonly block: MetaSendBlock) {
    super(message, graph);
    this.name = "MetaSendPolicyError";
  }
}

/**
 * Отправка не делалась: метка стоит, пробовать рано. Наследник CustomerDeliveryHeldError —
 * исходящее нового ядра считает это задержанием (SUPPRESSED), а не сбоем, и не шлёт повторно.
 */
export class MetaSendBlockedError extends CustomerDeliveryHeldError {
  constructor(readonly block: MetaSendBlock) {
    super("meta_send_policy_block");
    this.name = "MetaSendBlockedError";
    this.message = `Meta не пропускает отправку: ${blockSummary(block)} — бот не отправляет до пробы ${dushanbeDateTimeString(block.nextProbeAt)}`;
  }
}

export function isMetaSendBlockError(err: unknown): err is MetaSendBlockedError | MetaSendPolicyError {
  return err instanceof MetaSendBlockedError || err instanceof MetaSendPolicyError;
}

function codeText(block: Pick<MetaSendBlock, "lastCode" | "lastSubcode">): string {
  return `код ${block.lastCode}${block.lastSubcode !== null ? `/${block.lastSubcode}` : ""}`;
}

function surfaceName(surface: string): string {
  return SURFACE_NAME[surface as MetaSendSurface] ?? surface;
}

function blockSummary(block: MetaSendBlock): string {
  return `${block.label}, ${surfaceName(block.surface)}, с ${dushanbeDateTimeString(block.since)} (${codeText(block)})`;
}

function appName(channel: string): string {
  return channel === "WHATSAPP" ? "WhatsApp" : channel === "FACEBOOK" ? "Facebook (Meta Business Suite)" : "Instagram";
}

/** Понятный текст для сотрудника: почему не ушло и что делать. */
export function metaSendBlockStaffText(err: MetaSendBlockedError | MetaSendPolicyError): string {
  const b = err.block;
  return `Meta временно не пропускает отправку с аккаунта ${b.label}: ограничение по правилам (${codeText(b)}) с ${dushanbeDateTimeString(b.since)}. ` +
    `Ответьте клиенту из приложения ${appName(b.channel)} или позвоните.`;
}

// ─── Проба: «из этого пути не пробовать» ───

const noProbe = new AsyncLocalStorage<true>();
/**
 * Фоновая отправка (напоминание молчащему, повтор хода): пробой не служит — проба
 * должна быть ответом живому человеку, а не сообщением тому, кто молчит.
 */
export function withoutMetaSendProbe<T>(run: () => Promise<T>): Promise<T> {
  return noProbe.run(true, run);
}

// ─── Дверь: до отправки ───

export type MetaSendGate =
  | { kind: "open" }
  | { kind: "probe"; block: MetaSendBlock; account: MetaSendAccount; leased: boolean; staff: boolean };

export const META_SEND_OPEN: MetaSendGate = { kind: "open" };

/**
 * Решение до физического запроса. Нет меток — `open` без единого запроса. Метка
 * стоит: сотрудник — проба без замка; автоматика, если пора и замок свободен, —
 * проба; иначе MetaSendBlockedError (и ждущий клиент уходит человеку).
 */
export async function gateMetaSend(input: {
  surface: MetaSendSurface | "action";
  resolveAccount: () => Promise<MetaSendAccount>;
  recipientId: string | null;
  now?: Date;
}): Promise<MetaSendGate> {
  const blocks = await activeBlocks();
  if (!blocks.size) return META_SEND_OPEN;
  const account = await input.resolveAccount();
  const surface: MetaSendSurface = input.surface === "action" ? "dm" : input.surface;
  const block = blocks.get(cacheKey(account.key, surface));
  if (!block) return META_SEND_OPEN;
  // «Печатает…»/«прочитано» в заблокированный аккаунт — лишний вызов, пробой не служит.
  if (input.surface === "action") throw new MetaSendBlockedError(block);
  if (currentManualCustomerDeliveryActor() !== null) return { kind: "probe", block, account, leased: false, staff: true };

  const now = input.now ?? new Date();
  if (!noProbe.getStore() && block.nextProbeAt.getTime() <= now.getTime()) {
    const won = await prisma.metaSendBlock.updateMany({
      where: {
        id: block.id,
        liftedAt: null,
        nextProbeAt: { lte: now },
        OR: [{ probeLeaseUntil: null }, { probeLeaseUntil: { lt: now } }],
      },
      data: { probeLeaseUntil: new Date(now.getTime() + PROBE_LEASE_MS) },
    });
    if (won.count === 1) return { kind: "probe", block, account, leased: true, staff: false };
    // Замок не взят: проба уже идёт — или метку сняли в другом процессе, а кэш старый.
    const fresh = await prisma.metaSendBlock.findUnique({ where: { id: block.id } });
    if (fresh) rememberRow(fresh);
    if (!fresh || fresh.liftedAt) return META_SEND_OPEN;
  }
  if (surface === "dm" && input.recipientId && !noProbe.getStore()) await handOverWaitingChat(block, account, input.recipientId);
  throw new MetaSendBlockedError(block);
}

/**
 * Та же проверка ДО щита исходящих (messengers/meta.ts::sendMessage): отправка,
 * которую метка всё равно не выпустит, не должна попадать в счёт щита — иначе
 * отказы по правилам превращаются в ложное «бот написал N раз подряд». Пробу здесь
 * не берёт: «пора пробовать» пропускает дальше, замок берёт callGraph.
 */
export async function assertMetaSendNotBlocked(input: { account: MetaSendAccountRef; recipientId: string | null; now?: Date }): Promise<void> {
  const blocks = await activeBlocks();
  if (!blocks.size) return;
  if (currentManualCustomerDeliveryActor() !== null) return;
  const block = blocks.get(cacheKey(metaSendAccountKey(input.account), "dm"));
  if (!block) return;
  const now = (input.now ?? new Date()).getTime();
  const due = block.nextProbeAt.getTime() <= now && (block.probeLeaseUntil?.getTime() ?? 0) <= now;
  if (due && !noProbe.getStore()) return;
  if (input.recipientId && !noProbe.getStore()) await handOverWaitingChat(block, input.account, input.recipientId);
  throw new MetaSendBlockedError(block);
}

// ─── Дверь: после отправки ───

/** Отправка прошла. Была пробой — метка снята, руководству «снова отправляет». */
export async function settleMetaSendAccepted(gate: MetaSendGate, now: Date = new Date()): Promise<void> {
  if (gate.kind !== "probe") return;
  try {
    const lifted = await prisma.metaSendBlock.updateMany({
      where: { id: gate.block.id, liftedAt: null },
      data: { liftedAt: now, probeLeaseUntil: null },
    });
    const row = await prisma.metaSendBlock.findUnique({ where: { id: gate.block.id } });
    if (row) rememberRow(row);
    if (lifted.count !== 1) return;
    const b = gate.block;
    logSystemAudit("meta.send_block.lifted", "MetaSendBlock", b.id, {
      accountKey: b.accountKey, surface: b.surface, label: b.label, since: b.since.toISOString(),
      failures: b.failures, by: gate.staff ? "staff" : "probe",
    });
    await raiseCriticalAlarm({
      tag: `meta-send-unblock:${b.accountKey}:${b.surface}`,
      title: "✅ Meta снова пропускает отправку",
      body: `${b.label}, ${surfaceName(b.surface)}: отправка снова проходит (запрет был с ${dushanbeDateTimeString(b.since)}). ` +
        "Старые ответы бот сам не досылает: ответьте ждавшим клиентам.",
      url: "/messages",
      everyMs: ALARM_FLAP_MS,
      quiet: true,
      now,
    });
  } catch (err) {
    void logSystemError("meta", `Метка «Meta не пропускает отправку» не снята после удачной пробы: ${describeError(err)}`, {
      dedupKey: `meta-send-block-lift-failed:${gate.block.id}`,
    });
  }
}

/** Отправка не прошла НЕ по правилам (сеть, 5xx, окно 24 ч): проба не состоялась — замок отпускаем, ступень не меняем. */
export async function releaseMetaSendProbe(gate: MetaSendGate): Promise<void> {
  if (gate.kind !== "probe" || !gate.leased) return;
  await prisma.metaSendBlock
    .updateMany({ where: { id: gate.block.id, liftedAt: null }, data: { probeLeaseUntil: null } })
    .catch((err) => console.warn("[метка Meta] замок пробы не снят (снимется сам):", describeError(err)));
}

/**
 * Отказ по правилам. Метки нет — новый эпизод: метка, первая пауза, одна тревога
 * руководству, строка в журнале ошибок. Метка была — счёт отказов; если это была
 * проба (или сотрудник), пауза продлевается следующей ступенью.
 */
export async function recordMetaSendPolicyBlock(input: {
  account: MetaSendAccount;
  surface: MetaSendSurface;
  graph: MetaGraphErrorFields;
  policy: MetaPolicyBlockCode;
  gate: MetaSendGate;
  recipientId: string | null;
  now?: Date;
}): Promise<MetaSendBlock> {
  const now = input.now ?? new Date();
  const { account, surface, graph } = input;
  const fields = {
    channel: account.channel,
    accountId: account.accountId,
    label: account.label,
    lastFailureAt: now,
    lastCode: graph.code ?? input.policy.code,
    lastSubcode: graph.subcode,
    lastErrorType: graph.type,
    lastFbtraceId: graph.fbtraceId,
    lastMessage: graph.message,
    probeLeaseUntil: null,
  };
  const upsertEpisode = () => prisma.$transaction(async (tx) => {
    const existing = await tx.metaSendBlock.findUnique({ where: { accountKey_surface: { accountKey: account.key, surface } } });
    if (!existing || existing.liftedAt) {
      const fresh = { ...fields, since: now, liftedAt: null, failures: 1, probeStep: 0, nextProbeAt: new Date(now.getTime() + metaSendProbeDelayMs(0)) };
      const saved = existing
        ? await tx.metaSendBlock.update({ where: { id: existing.id }, data: fresh })
        : await tx.metaSendBlock.create({ data: { accountKey: account.key, surface, ...fresh } });
      return { saved, started: true };
    }
    const probed = input.gate.kind === "probe" && input.gate.block.id === existing.id;
    const step = probed ? existing.probeStep + 1 : existing.probeStep;
    const extended = new Date(now.getTime() + metaSendProbeDelayMs(step));
    const saved = await tx.metaSendBlock.update({
      where: { id: existing.id },
      data: {
        ...fields,
        failures: { increment: 1 },
        probeStep: step,
        nextProbeAt: extended.getTime() > existing.nextProbeAt.getTime() ? extended : existing.nextProbeAt,
      },
    });
    return { saved, started: false };
  });
  // Два процесса получили первый отказ одновременно: второй упирается в уникальный
  // ключ и повторяет уже как «метка есть» — эпизод и тревога остаются одни.
  const row = await upsertEpisode().catch((err: unknown) => {
    if ((err as { code?: string })?.code === "P2002") return upsertEpisode();
    throw err;
  });
  rememberRow(row.saved);

  const b = row.saved;
  // Код и подкод — отдельными полями, а не обрезанным текстом (журнал действий, на каждый отказ).
  logSystemAudit("meta.send_block.rejected", "MetaSendBlock", b.id, {
    accountKey: b.accountKey, surface, label: b.label, channel: b.channel,
    httpStatus: graph.status, code: graph.code, subcode: graph.subcode, type: graph.type, fbtraceId: graph.fbtraceId,
    message: graph.message, meaning: input.policy.meaning, doc: input.policy.doc,
    probe: input.gate.kind === "probe" ? (input.gate.staff ? "staff" : "probe") : null,
    nextProbeAt: b.nextProbeAt.toISOString(), failures: b.failures,
  });

  if (row.started) {
    void logSystemError(
      "meta",
      `Meta не пропускает отправку по правилам: ${b.label}, ${surfaceName(surface)} — код ${graph.code ?? "?"}` +
        `${graph.subcode !== null ? `, подкод ${graph.subcode}` : ""}${graph.fbtraceId ? `, fbtrace ${graph.fbtraceId}` : ""}` +
        `${graph.message ? `: ${graph.message}` : ""}. Бот в этот аккаунт не пишет, проба ${dushanbeDateTimeString(b.nextProbeAt)}.`,
      // Руководству уходит своя тревога ниже — пуш «Новая проблема» был бы дублем.
      { dedupKey: `meta-send-block:${b.accountKey}:${surface}`, silent: true }
    );
    await raiseCriticalAlarm({
      tag: `meta-send-block:${b.accountKey}:${surface}`,
      title: "⛔ Meta не пропускает отправку",
      body: `${b.label}, ${surfaceName(surface)}: запрет по правилам (${codeText(b)}). Бот туда не пишет, ждущих клиентов передаёт сотрудникам. ` +
        `Проба ${dushanbeDateTimeString(b.nextProbeAt)}. Ключ не трогать.`,
      url: "/settings?tab=system",
      everyMs: ALARM_FLAP_MS,
      now,
    });
  }
  if (surface === "dm" && input.recipientId && !(input.gate.kind === "probe" && input.gate.staff)) {
    await handOverWaitingChat(b, account, input.recipientId);
  }
  return b;
}

// ─── Сигнал человеку: «клиент ждёт ответа», настоящая причина ───

const HANDOFF_CLAIM_CHANNEL = "meta-send-block-handoff";

type StoredMessage = { role?: unknown; at?: unknown; mid?: unknown; deliveryStatus?: unknown; silentCapture?: unknown; by?: { kind?: unknown } | null };

/**
 * С какого момента клиент ждёт ответа. Реплика бота без mid или с отметкой «не
 * дошло» ответом не считается: в старом пути она записана в историю ДО отправки,
 * которая как раз и не состоялась. Ответ сотрудника (агент/вручную) — ответ.
 */
export function customerWaitingSince(messages: unknown): Date | null {
  if (!Array.isArray(messages)) return null;
  let since: Date | null = null;
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i] as StoredMessage | null;
    if (!m || typeof m !== "object") continue;
    if (m.role === "assistant") {
      const human = !!m.by && typeof m.by === "object" && (m.by.kind === "agent" || m.by.kind === "manual");
      if (!human && (m.deliveryStatus === "failed" || !m.mid)) continue;
      break;
    }
    if (m.role !== "user" || m.silentCapture === true) continue;
    const at = typeof m.at === "string" ? new Date(m.at) : null;
    if (!at || Number.isNaN(at.getTime())) break;
    since = at;
  }
  return since;
}

/** Ждущая переписка → человеку, один сигнал на переписку за эпизод запрета. Никогда не бросает. */
async function handOverWaitingChat(block: MetaSendBlock, account: Pick<MetaSendAccountRef, "channel">, recipientId: string): Promise<void> {
  try {
    const chat = await prisma.botConversation.findUnique({
      where: { channel_subscriberId: { channel: account.channel, subscriberId: recipientId } },
      select: { id: true },
    });
    if (chat) await handOverBlockedConversation(chat.id, block);
  } catch (err) {
    void logSystemError("meta", `Переписку с ждущим клиентом не удалось передать человеку (Meta не пропускает ${block.label}): ${describeError(err)}`, {
      dedupKey: `meta-send-block-handoff-failed:${block.id}`,
    });
  }
}

/**
 * Передать переписку человеку: Meta не пропускает отправку (или не пропускала, пока
 * клиент ждал). Через штатную дверь «клиент ждёт ответа» (clientWaitingAlert.ts),
 * которая сама идемпотентна по эпизоду молчания; поверх — своя отметка на эпизод
 * запрета, чтобы три реплики клиента за время запрета не дали три сигнала.
 */
export async function handOverBlockedConversation(conversationId: string, block: MetaSendBlock): Promise<"sent" | "already" | "not_waiting"> {
  const chat = await prisma.botConversation.findUnique({ where: { id: conversationId }, select: { messages: true } });
  const since = chat ? customerWaitingSince(chat.messages) : null;
  if (!since) return "not_waiting";
  const key = `${conversationId}:${block.since.toISOString()}`;
  const claimed = await prisma.$executeRaw`INSERT INTO "ProcessedMessage" ("id","channel","messageId","createdAt","completedAt")
    VALUES (${randomUUID()},${HANDOFF_CLAIM_CHANNEL},${key},now(),now()) ON CONFLICT ("channel","messageId") DO NOTHING`;
  if (claimed !== 1) return "already";
  const why = block.liftedAt
    ? `ответ клиенту не ушёл, пока Meta не пропускала отправку аккаунта ${block.label}; старые ответы бот сам не досылает`
    : `Meta временно не пропускает ответы аккаунта ${block.label} (ограничение по правилам), бот ответить не может; ответьте вручную из приложения ${appName(block.channel)}`;
  // Динамический импорт: дверь «клиент ждёт ответа» тянет пуши и настройки — транспорту Meta они не нужны до первого запрета.
  const { alertClientWaiting } = await import("./clientWaitingAlert.js");
  const outcome = await alertClientWaiting({ conversationId, trigger: "failed", why, since });
  if (outcome === "skipped") {
    await prisma.processedMessage.deleteMany({ where: { channel: HANDOFF_CLAIM_CHANNEL, messageId: key } }).catch(() => {});
    return "not_waiting";
  }
  return outcome === "already" ? "already" : "sent";
}

/**
 * Для повтора зависших: реплика клиента ждала, пока действовал запрет (идёт сейчас
 * или снят уже после неё)? Тогда автоматика её НЕ досылает — решение за человеком.
 * Возвращает метку эпизода или null. Смотрит последний эпизод аккаунта: реплика,
 * ждавшая во время любого раннего, ждала и во время последнего.
 */
export async function metaSendBlockCoveringMessage(ref: MetaSendAccountRef, messageAt: Date, surface: MetaSendSurface = "dm"): Promise<MetaSendBlock | null> {
  const active = await currentMetaSendBlock(ref, surface);
  if (active) return active;
  const row = await prisma.metaSendBlock.findUnique({ where: { accountKey_surface: { accountKey: metaSendAccountKey(ref), surface } } });
  if (!row) return null;
  if (row.liftedAt && messageAt.getTime() >= row.liftedAt.getTime()) return null;
  return row;
}

/** Метки для реестра функций: действующие и снятые за трое суток. */
export async function listMetaSendBlocksForStatus(now: Date = new Date()): Promise<MetaSendBlock[]> {
  return prisma.metaSendBlock.findMany({
    where: { OR: [{ liftedAt: null }, { liftedAt: { gte: new Date(now.getTime() - 3 * 24 * HOUR_MS) } }] },
    orderBy: { since: "desc" },
    take: 50,
  });
}
