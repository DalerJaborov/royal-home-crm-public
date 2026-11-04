import { createHash } from "node:crypto";
import {
  assistantActionPreviewSchema,
  type AssistantActionOutcome,
  type AssistantActionPreview,
  type AssistantActionView,
  type PermissionId,
} from "@royal-home/shared";
import { prisma, type TxClient } from "../db.js";
import { Prisma, type AssistantAction } from "../generated/prisma/client.js";
import { canonicalJson, toPlainJson } from "./canonicalJson.js";
import { logAgentAudit } from "./audit.js";
import { logSystemError } from "./systemError.js";

/**
 * ConfirmationBroker ИИ-помощника — действия уровня C (П2, задача 2.3,
 * docs/design/internal-assistant-architecture-2026-10-31.md, раздел 2.3).
 *
 * Поток: инструмент записи НЕ пишет сам — `createPending` читает текущее
 * состояние (снимок «было»), строит превью «было → станет» и кладёт строку
 * `AssistantAction PENDING` со сроком 10 минут. Сотрудник жмёт «Подтвердить» —
 * `confirm` исполняет действие РОВНО ОДИН РАЗ, «Отмена» — `cancel`, «Отменить»
 * после исполнения — `undo`.
 *
 * ГАРАНТИИ И КАК ОНИ ДЕРЖАТСЯ:
 * - Ровно один запуск при двойном нажатии и при гонке двух запросов: переход
 *   PENDING → CONFIRMED делается одним `updateMany` с условием на статус. Его
 *   выигрывает ровно один запрос (Postgres перепроверяет условие под блокировкой
 *   строки); проигравший видит count = 0 и получает либо прежний результат
 *   (EXECUTED), либо 409 «уже исполняется». Тот же приём, что `guardWhere` в
 *   `changeClientAgent` и `claimCallback` в `telegramModeration`.
 * - Чужое действие — 403 ДО любых других проверок: чужой id не должен даже
 *   сообщать, истёк он или нет.
 * - Истёкшее — 410. Снимок «было» устарел (сущность успели поменять после
 *   показа превью) — 409 `{stale: true}` и СВЕЖЕЕ действие с новым превью;
 *   старое гасится, чтобы второе нажатие по старому id не исполнило то, чего
 *   человек не видел.
 * - Откат — только если у инструмента есть `undo`, превью не помечено
 *   необратимым, окно не прошло и снимок «стало» не изменился с исполнения.
 *
 * ПРАВА: брокер права актора НЕ расширяет и не обходит. Он проверяет
 * `requires` исполнителя (защита в глубину), а сам исполнитель ОБЯЗАН проверять
 * права по переданному `actor` в `snapshot` и `execute` — так же, как это
 * делает REST-аналог. Актор собирается из `req.agent` на КАЖДОМ запросе, то есть
 * права перечитываются на нажатии, а не берутся из момента показа превью.
 *
 * Исполнители регистрирует реестр инструментов помощника (ai/assistant/tools/index.ts,
 * П3): change_client_agent, заявки по объектам, перемонтаж, показы, заметки.
 * Согласованность реестра и брокера держит tests/ai-assistant-tool-registry.test.ts.
 */

export const ASSISTANT_ACTION_TTL_MS = 10 * 60_000;
export const ASSISTANT_ACTION_UNDO_WINDOW_MS = 15 * 60_000;
/** Окно идемпотентности: та же просьба над тем же состоянием в эти 10 минут — то же действие. */
const IDEMPOTENCY_WINDOW_MS = 10 * 60_000;

export type AssistantActionChannel = "crm" | "telegram";

export interface AssistantActionActor {
  agentId: string;
  /** Откуда пришло нажатие. Инструменты со step-up доступны только из CRM. */
  channel: AssistantActionChannel;
  /** Verified from the Telegram update, never inferred from the actor's role. */
  telegramPrivate?: boolean;
  can: (permission: PermissionId) => boolean;
}

/**
 * Превью, вид действия и исход — общий договор с панелью на сайте
 * (packages/shared/src/assistantAction.ts): одно описание на обе стороны.
 */
export { assistantActionPreviewSchema };
export type { AssistantActionOutcome, AssistantActionPreview, AssistantActionView };

/** Снимок — объект полей, которые действие трогает (сравнивается канонически). */
export type AssistantActionSnapshot = Record<string, unknown>;

export interface AssistantActionExecuteResult {
  result: unknown;
  /** Что именно изменено — для AuditLog; без него пишется ссылка на само действие. */
  audit?: { entityType: string; entityId?: string | null };
  /** Best-effort work for transactional tools, invoked only after commit. */
  afterCommit?: () => void;
}

/**
 * Исполнитель действия уровня C. Регистрируется по имени инструмента.
 * Контракт: `snapshot` и `buildPreview` НИЧЕГО не пишут; `snapshot` одна и та же
 * функция до и после исполнения; права проверяются по `actor` здесь же
 * (бросать `AssistantActionError(403, …)`), а не полагаются на брокера.
 */
export interface AssistantActionUndoContext {
  actionId: string;
  snapshotBefore: AssistantActionSnapshot;
  snapshotAfter: AssistantActionSnapshot;
  result: unknown;
}

export interface AssistantActionExecutor<A = unknown> {
  tool: string;
  requires?: readonly PermissionId[];
  /** По умолчанию только CRM: из Telegram step-up не ввести. */
  channels?: readonly AssistantActionChannel[];
  /** This action may use Telegram only in a private chat. */
  privateTelegram?: boolean;
  /** DB-only execution with the claim, score/domain writes, audit and result in one transaction. */
  transactional?: true;
  /** Revalidate current entity access before returning an existing action, including a replay. */
  authorize?: (args: A, actor: AssistantActionActor, action: Pick<AssistantAction, "status" | "result">) => Promise<void>;
  /** Разбор аргументов (zod) — тот же, что на REST-границе. */
  parseArgs: (raw: unknown) => A;
  snapshot: (args: A, actor: AssistantActionActor, tx?: TxClient) => Promise<AssistantActionSnapshot>;
  buildPreview: (
    args: A,
    snapshot: AssistantActionSnapshot,
    actor: AssistantActionActor
  ) => Promise<AssistantActionPreview> | AssistantActionPreview;
  execute: (
    args: A,
    actor: AssistantActionActor,
    ctx: { actionId: string; snapshotBefore: AssistantActionSnapshot; tx?: TxClient }
  ) => Promise<AssistantActionExecuteResult>;
  undo?: (
    args: A,
    actor: AssistantActionActor,
    ctx: AssistantActionUndoContext,
  ) => Promise<void>;
  /** Use the domain journal for undo that can resume across transactions and process restarts. */
  recoverableUndo?: {
    matches: (result: unknown) => boolean;
    execute: (args: A, actor: AssistantActionActor, ctx: AssistantActionUndoContext & { now: Date; undoUntil: Date }) =>
      Promise<{ replay: boolean }>;
  };
  /** Opt in for results whose undo uses this transaction for every durable write. */
  transactionalUndo?: {
    matches: (result: unknown) => boolean;
    execute: (
      args: A,
      actor: AssistantActionActor,
      ctx: AssistantActionUndoContext & { tx: TxClient; assertSnapshot: (current: AssistantActionSnapshot) => void },
    ) => Promise<{ afterCommit?: () => void | Promise<void> }>;
  };
  undoWindowMs?: number;
}

export class AssistantActionError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly extra: Record<string, unknown> = {}
  ) {
    super(message);
    this.name = "AssistantActionError";
  }
}

const executors = new Map<string, AssistantActionExecutor>();

/** Регистрирует исполнитель; возвращает функцию снятия (нужна тестам). */
export function registerAssistantActionExecutor<A>(executor: AssistantActionExecutor<A>): () => void {
  if (executors.has(executor.tool)) {
    throw new Error(`Исполнитель действия помощника «${executor.tool}» уже зарегистрирован`);
  }
  const stored = executor as unknown as AssistantActionExecutor;
  executors.set(executor.tool, stored);
  return () => {
    if (executors.get(executor.tool) === stored) executors.delete(executor.tool);
  };
}

export function getAssistantActionExecutor(tool: string): AssistantActionExecutor | null {
  return executors.get(tool) ?? null;
}

function toView(row: AssistantAction): AssistantActionView {
  const executor = getAssistantActionExecutor(row.tool);
  const preview = row.preview as AssistantActionPreview;
  const undoable =
    row.status === "EXECUTED" && row.executedAt && executor && canUndo(executor, row.result) &&
    !preview.irreversible && row.snapshotAfter;
  return {
    id: row.id,
    tool: row.tool,
    status: row.status,
    preview,
    expiresAt: row.expiresAt.toISOString(),
    executedAt: row.executedAt?.toISOString() ?? null,
    undoneAt: row.undoneAt?.toISOString() ?? null,
    undoUntil: undoable
      ? new Date(row.executedAt!.getTime() + (executor!.undoWindowMs ?? ASSISTANT_ACTION_UNDO_WINDOW_MS)).toISOString()
      : null,
    result: row.result ?? null,
    serverNow: new Date().toISOString(),
  };
}

function canUndo(executor: AssistantActionExecutor, result: unknown): boolean {
  return Boolean(executor.undo || executor.transactionalUndo?.matches(result) || executor.recoverableUndo?.matches(result));
}

const sha256 = (text: string) => createHash("sha256").update(text).digest("hex");

function asJson(value: unknown): Prisma.InputJsonValue {
  return toPlainJson(value) as Prisma.InputJsonValue;
}

function requireExecutor(tool: string): AssistantActionExecutor {
  const executor = getAssistantActionExecutor(tool);
  if (!executor) throw new AssistantActionError(422, "UNKNOWN_TOOL", "Такое действие помощник не умеет");
  return executor;
}

function assertActorAllowed(executor: AssistantActionExecutor, actor: AssistantActionActor) {
  const channels = executor.channels ?? ["crm"];
  if (!channels.includes(actor.channel)) {
    throw new AssistantActionError(403, "CHANNEL_NOT_ALLOWED", "Это действие доступно только в CRM");
  }
  assertPrivateTelegram(executor, actor);
  for (const permission of executor.requires ?? []) {
    if (!actor.can(permission)) throw new AssistantActionError(403, "FORBIDDEN", "Недостаточно прав на это действие");
  }
}

function assertPrivateTelegram(executor: AssistantActionExecutor | null, actor: AssistantActionActor) {
  if (executor?.privateTelegram && actor.channel === "telegram" && actor.telegramPrivate !== true) {
    throw new AssistantActionError(403, "PRIVATE_CHAT_REQUIRED", "Это действие доступно в личке с Шабнам");
  }
}

function parseArgs(executor: AssistantActionExecutor, raw: unknown): unknown {
  try {
    return executor.parseArgs(raw);
  } catch (err) {
    if (err instanceof AssistantActionError) throw err;
    throw new AssistantActionError(400, "BAD_ARGS", "Неверные параметры действия");
  }
}

async function readSnapshot(
  executor: AssistantActionExecutor,
  args: unknown,
  actor: AssistantActionActor,
  tx?: TxClient,
): Promise<AssistantActionSnapshot> {
  const snapshot = toPlainJson(await executor.snapshot(args, actor, tx));
  if (snapshot === null || typeof snapshot !== "object" || Array.isArray(snapshot)) {
    throw new Error(`Снимок действия «${executor.tool}» обязан быть объектом`);
  }
  return snapshot as AssistantActionSnapshot;
}

const sameSnapshot = (a: unknown, b: unknown) => canonicalJson(a) === canonicalJson(b);

async function loadOwned(actionId: string, actor: AssistantActionActor): Promise<AssistantAction> {
  const row = await prisma.assistantAction.findUnique({ where: { id: actionId } });
  if (!row) throw new AssistantActionError(404, "NOT_FOUND", "Действие не найдено");
  if (row.agentId !== actor.agentId) throw new AssistantActionError(403, "FORBIDDEN", "Это действие не ваше");
  return row;
}

async function loadAuthorizedAction(actionId: string, actor: AssistantActionActor) {
  const row = await loadOwned(actionId, actor);
  const executor = requireExecutor(row.tool);
  // Settled and in-flight responses can include the same preview and result as execution.
  assertActorAllowed(executor, actor);
  await assertActionReadable(row, executor, actor);
  return { row, executor };
}

async function assertActionReadable(row: AssistantAction, executor: AssistantActionExecutor, actor: AssistantActionActor): Promise<void> {
  if (executor.authorize) await executor.authorize(parseArgs(executor, row.args), actor, row);
}

/** Гасит просроченное PENDING (условно — гонка со сборщиком/вторым запросом безопасна). */
async function expireIfDue(row: AssistantAction, now: Date): Promise<void> {
  await prisma.assistantAction.updateMany({
    where: { id: row.id, status: "PENDING", expiresAt: { lte: now } },
    data: { status: "EXPIRED", idempotencyKey: null },
  });
}

const expiredError = () => new AssistantActionError(410, "EXPIRED", "Время на подтверждение вышло, попросите заново");

/**
 * Создаёт ожидающее действие с превью «было → станет». Ничего в сущностях не
 * пишет. Повтор той же просьбы над тем же состоянием (модель позвала инструмент
 * дважды, вебхук доставил дважды) возвращает то же действие, а не второе.
 */
export async function createPendingAssistantAction(
  actor: AssistantActionActor,
  tool: string,
  rawArgs: unknown,
  opts: { now?: Date } = {}
): Promise<AssistantActionView> {
  const now = opts.now ?? new Date();
  const executor = requireExecutor(tool);
  assertActorAllowed(executor, actor);
  const args = parseArgs(executor, rawArgs);
  const snapshot = await readSnapshot(executor, args, actor);
  const preview = assistantActionPreviewSchema.parse(await executor.buildPreview(args, snapshot, actor));

  const argsHash = sha256(canonicalJson(args));
  const windowBucket = Math.floor(now.getTime() / IDEMPOTENCY_WINDOW_MS);
  // Снимок входит в ключ: та же просьба над ИЗМЕНИВШИМСЯ состоянием — это новое
  // превью, и его нельзя склеить со старым (иначе человек подтвердит «было»,
  // которого уже нет).
  const idempotencyKey = sha256([actor.agentId, tool, argsHash, sha256(canonicalJson(snapshot)), windowBucket].join("|"));

  for (let attempt = 0; attempt < 3; attempt++) {
    const existing = await prisma.assistantAction.findUnique({ where: { idempotencyKey } });
    if (existing) {
      if (existing.status === "CONFIRMED") return toView(existing);
      if (existing.status === "PENDING" && existing.expiresAt > now) return toView(existing);
      // Ключ держат только живые действия; просроченное PENDING освобождает его здесь.
      await expireIfDue(existing, now);
      continue;
    }
    try {
      const row = await prisma.assistantAction.create({
        data: {
          agentId: actor.agentId,
          channel: actor.channel,
          tool,
          args: asJson(args),
          argsHash,
          preview: asJson(preview),
          snapshotBefore: asJson(snapshot),
          idempotencyKey,
          expiresAt: new Date(now.getTime() + ASSISTANT_ACTION_TTL_MS),
        },
      });
      return toView(row);
    } catch (err) {
      // Параллельный двойник успел вставить — на следующем круге вернём его.
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002") continue;
      throw err;
    }
  }
  throw new AssistantActionError(409, "IN_PROGRESS", "Такое же действие уже обрабатывается");
}

/** Объяснение исхода для строки, которую не удалось захватить (или которая уже не PENDING). */
function settledOutcome(row: AssistantAction, now: Date): AssistantActionOutcome {
  if (row.status === "EXECUTED") return { action: toView(row), replay: true };
  if (row.status === "CONFIRMED") {
    throw new AssistantActionError(409, "IN_PROGRESS", "Действие уже исполняется", { action: toView(row) });
  }
  if (row.status === "EXPIRED" || (row.status === "PENDING" && row.expiresAt <= now)) throw expiredError();
  throw new AssistantActionError(409, "NOT_PENDING", "Действие уже закрыто", { action: toView(row) });
}

async function failClaimed(actionId: string, reason: string): Promise<void> {
  await prisma.assistantAction.updateMany({
    where: { id: actionId, status: "CONFIRMED" },
    data: { status: "FAILED", statusReason: reason.slice(0, 500), idempotencyKey: null },
  });
}

async function stalePreviewError(row: AssistantAction, actor: AssistantActionActor, now: Date): Promise<AssistantActionError> {
  const action = await createPendingAssistantAction(actor, row.tool, row.args, { now }).catch(() => null);
  return new AssistantActionError(409, "STALE", "Данные изменились, проверьте ещё раз", { stale: true, action });
}

function claimPendingAction(db: TxClient, row: AssistantAction, actor: AssistantActionActor, now: Date) {
  return db.assistantAction.updateMany({
    where: { id: row.id, agentId: actor.agentId, status: "PENDING", expiresAt: { gt: now } },
    data: { status: "CONFIRMED", confirmedAt: now },
  });
}

function saveExecutedAction(
  db: TxClient, row: AssistantAction, executed: AssistantActionExecuteResult, snapshotAfter: AssistantActionSnapshot | null,
) {
  return db.assistantAction.update({
    where: { id: row.id },
    data: {
      status: "EXECUTED",
      executedAt: new Date(),
      result: executed.result === undefined || executed.result === null ? Prisma.DbNull : asJson(executed.result),
      snapshotAfter: snapshotAfter ? asJson(snapshotAfter) : Prisma.DbNull,
      idempotencyKey: null,
    },
  });
}

async function confirmTransactionalAction(
  row: AssistantAction, executor: AssistantActionExecutor, actor: AssistantActionActor, now: Date,
): Promise<AssistantActionOutcome> {
  const outcome = await prisma.$transaction(async (tx) => {
    const claimed = await claimPendingAction(tx, row, actor, now);
    if (claimed.count === 0) {
      const fresh = await tx.assistantAction.findUnique({ where: { id: row.id } });
      if (!fresh) throw new AssistantActionError(404, "NOT_FOUND", "Действие не найдено");
      return { kind: "settled" as const, row: fresh };
    }
    const args = parseArgs(executor, row.args);
    const snapshotBefore = row.snapshotBefore as AssistantActionSnapshot;
    const current = await readSnapshot(executor, args, actor, tx);
    if (!sameSnapshot(current, snapshotBefore)) {
      await tx.assistantAction.update({
        where: { id: row.id },
        data: { status: "CANCELLED", statusReason: "stale: данные изменились после превью", idempotencyKey: null },
      });
      return { kind: "stale" as const };
    }

    const executed = await executor.execute(args, actor, { actionId: row.id, snapshotBefore, tx });
    const snapshotAfter = canUndo(executor, executed.result) ? await readSnapshot(executor, args, actor, tx) : null;
    const agent = await tx.agent.findUnique({ where: { id: actor.agentId }, select: { fullName: true } });
    await tx.auditLog.create({
      data: {
        action: `ASSISTANT_${row.tool.toUpperCase()}`,
        entityType: executed.audit?.entityType ?? "AssistantAction",
        entityId: executed.audit?.entityId ?? row.id,
        agentId: actor.agentId,
        agentName: agent?.fullName ?? "Неизвестно",
        meta: { source: "assistant", actionId: row.id, channel: actor.channel },
      },
    });
    const done = await saveExecutedAction(tx, row, executed, snapshotAfter);
    return { kind: "executed" as const, row: done, afterCommit: executed.afterCommit };
  }).catch(async (err: unknown) => {
    if (err instanceof AssistantActionError) throw err;
    // A disconnected client may miss COMMIT's acknowledgement. Check the durable result, never rerun here.
    const persisted = await prisma.assistantAction.findUnique({ where: { id: row.id } }).catch(() => null);
    if (persisted?.status === "EXECUTED") return { kind: "settled" as const, row: persisted };
    await logSystemError("ai", `Помощник: транзакция действия «${row.tool}» (${row.id}): ${err instanceof Error ? err.message : String(err)}`);
    throw new AssistantActionError(503, "CONFIRM_RETRY", "Не получилось. Нажмите «Подтвердить» ещё раз.");
  });

  if (outcome.kind === "stale") throw await stalePreviewError(row, actor, now);
  if (outcome.kind === "settled") {
    await assertActionReadable(outcome.row, executor, actor);
    if (outcome.row.status === "PENDING" && outcome.row.expiresAt <= now) await expireIfDue(outcome.row, now);
    return settledOutcome(outcome.row, now);
  }
  if (outcome.afterCommit) {
    void Promise.resolve().then(outcome.afterCommit).catch((err) =>
      console.error("[assistant] post-commit work failed:", err)
    );
  }
  return { action: toView(outcome.row), replay: false };
}

/**
 * «Подтвердить». Исполняет действие ровно один раз; повтор по тому же id после
 * исполнения отдаёт прежний результат (`replay: true`).
 */
export async function confirmAssistantAction(
  actionId: string,
  actor: AssistantActionActor,
  opts: { now?: Date } = {}
): Promise<AssistantActionOutcome> {
  const now = opts.now ?? new Date();
  const { row, executor } = await loadAuthorizedAction(actionId, actor);
  if (row.status !== "PENDING") return settledOutcome(row, now);
  if (row.expiresAt <= now) {
    await expireIfDue(row, now);
    throw expiredError();
  }
  if (executor.transactional) return confirmTransactionalAction(row, executor, actor, now);

  const claimed = await claimPendingAction(prisma, row, actor, now);
  if (claimed.count === 0) {
    const fresh = await prisma.assistantAction.findUnique({ where: { id: row.id } });
    if (!fresh) throw new AssistantActionError(404, "NOT_FOUND", "Действие не найдено");
    if (fresh.status === "PENDING" && fresh.expiresAt <= now) await expireIfDue(fresh, now);
    return settledOutcome(fresh, now);
  }

  // Дальше — только победитель гонки.
  let args: unknown;
  let current: AssistantActionSnapshot;
  try {
    args = parseArgs(executor, row.args);
    current = await readSnapshot(executor, args, actor);
  } catch (err) {
    await failClaimed(row.id, `Снимок перед исполнением: ${(err as Error).message}`);
    throw err;
  }

  const snapshotBefore = row.snapshotBefore as AssistantActionSnapshot;
  if (!sameSnapshot(current, snapshotBefore)) {
    await prisma.assistantAction.updateMany({
      where: { id: row.id, status: "CONFIRMED" },
      data: { status: "CANCELLED", statusReason: "stale: данные изменились после превью", idempotencyKey: null },
    });
    throw await stalePreviewError(row, actor, now);
  }

  let executed: AssistantActionExecuteResult;
  try {
    executed = await executor.execute(args, actor, { actionId: row.id, snapshotBefore });
  } catch (err) {
    await failClaimed(row.id, (err as Error).message ?? "ошибка исполнения");
    if (err instanceof AssistantActionError) throw err;
    await logSystemError("ai", `Помощник: действие «${row.tool}» (${row.id}) упало при исполнении: ${(err as Error).message}`, {
      stack: (err as Error).stack,
    });
    throw new AssistantActionError(500, "EXECUTION_FAILED", "Не получилось выполнить действие");
  }

  let snapshotAfter: AssistantActionSnapshot | null = null;
  try {
    snapshotAfter = await readSnapshot(executor, args, actor);
  } catch {
    // Без снимка «стало» откат просто будет недоступен — само действие уже сделано.
  }

  const done = await saveExecutedAction(prisma, row, executed, snapshotAfter);
  logAgentAudit(
    actor.agentId,
    `ASSISTANT_${row.tool.toUpperCase()}`,
    executed.audit?.entityType ?? "AssistantAction",
    executed.audit?.entityId ?? row.id,
    { source: "assistant", actionId: row.id, channel: actor.channel }
  );
  return { action: toView(done), replay: false };
}

function cancelPendingRow(row: AssistantAction, actor: AssistantActionActor, onlyUnbundled = false) {
  return prisma.assistantAction.updateMany({
    where: { id: row.id, agentId: actor.agentId, status: "PENDING", ...(onlyUnbundled ? { bundleId: null } : {}) },
    data: { status: "CANCELLED", statusReason: "отменено сотрудником", idempotencyKey: null },
  });
}

/** Telegram cleanup may discard an owned draft without reading its preview or result. */
export async function discardPendingAssistantAction(
  actionId: string,
  actor: AssistantActionActor,
  opts: { onlyUnbundled?: boolean } = {},
): Promise<void> {
  const row = await loadOwned(actionId, actor);
  assertPrivateTelegram(getAssistantActionExecutor(row.tool), actor);
  await cancelPendingRow(row, actor, opts.onlyUnbundled);
}

/** «Отмена» до исполнения. Повтор по уже отменённому — не ошибка. */
export async function cancelAssistantAction(
  actionId: string,
  actor: AssistantActionActor,
  opts: { now?: Date } = {}
): Promise<AssistantActionOutcome> {
  const now = opts.now ?? new Date();
  const { row, executor } = await loadAuthorizedAction(actionId, actor);
  const cancelled = await cancelPendingRow(row, actor);
  const fresh = await prisma.assistantAction.findUniqueOrThrow({ where: { id: row.id } });
  if (cancelled.count === 1) return { action: toView(fresh), replay: false };
  if (fresh.status !== row.status) await assertActionReadable(fresh, executor, actor);
  if (fresh.status === "CANCELLED") return { action: toView(fresh), replay: true };
  return settledOutcome(fresh, now);
}

/**
 * «Отменить» после исполнения. Только пока снимок «стало» совпадает с текущим
 * состоянием: если сущность успели поменять ещё раз, откат затёр бы чужую правку.
 */
const undoStaleError = () =>
  new AssistantActionError(409, "UNDO_STALE", "Данные уже изменились после действия — откат затёр бы чужую правку");

function assertUndoSnapshot(current: unknown, expected: AssistantActionSnapshot): void {
  if (!sameSnapshot(current, expected)) throw undoStaleError();
}

const claimUndoAction = (db: TxClient, row: AssistantAction, actor: AssistantActionActor, now: Date) =>
  db.assistantAction.updateMany({
    where: { id: row.id, agentId: actor.agentId, status: "EXECUTED", undoClaimedAt: null },
    data: { undoClaimedAt: now },
  });

const saveUndoneAction = (db: TxClient, row: AssistantAction) =>
  db.assistantAction.update({ where: { id: row.id }, data: { status: "UNDONE", undoneAt: new Date() } });

const undoAuditMeta = (row: AssistantAction, actor: AssistantActionActor) => ({
  source: "assistant.undo",
  actionId: row.id,
  channel: actor.channel,
});

async function undoTransactionalAction(
  row: AssistantAction,
  executor: AssistantActionExecutor,
  run: NonNullable<AssistantActionExecutor["transactionalUndo"]>["execute"],
  actor: AssistantActionActor,
  now: Date,
): Promise<AssistantActionOutcome> {
  const outcome = await prisma.$transaction(async (tx) => {
    const claimed = await claimUndoAction(tx, row, actor, now);
    if (claimed.count === 0) {
      const fresh = await tx.assistantAction.findUniqueOrThrow({ where: { id: row.id } });
      if (fresh.status !== "UNDONE") throw new AssistantActionError(409, "IN_PROGRESS", "Откат уже выполняется");
      return { row: fresh, replay: true as const };
    }
    const snapshotAfter = row.snapshotAfter as AssistantActionSnapshot | null;
    if (!snapshotAfter) throw undoStaleError();
    const { afterCommit } = await run(parseArgs(executor, row.args), actor, {
      actionId: row.id,
      snapshotBefore: row.snapshotBefore as AssistantActionSnapshot,
      snapshotAfter,
      result: row.result,
      tx,
      assertSnapshot: (current) => assertUndoSnapshot(current, snapshotAfter),
    });
    const agent = await tx.agent.findUnique({ where: { id: actor.agentId }, select: { fullName: true } });
    await tx.auditLog.create({
      data: {
        action: `ASSISTANT_${row.tool.toUpperCase()}_UNDO`,
        entityType: "AssistantAction",
        entityId: row.id,
        agentId: actor.agentId,
        agentName: agent?.fullName ?? "Неизвестно",
        meta: undoAuditMeta(row, actor),
      },
    });
    return { row: await saveUndoneAction(tx, row), replay: false as const, afterCommit };
  }).catch(async (err: unknown) => {
    if (err instanceof AssistantActionError) throw err;
    // Never replay the mutation after losing COMMIT's acknowledgement.
    const persisted = await prisma.assistantAction.findUnique({ where: { id: row.id } }).catch(() => null);
    if (persisted?.status === "UNDONE") return { row: persisted, replay: true as const };
    await logSystemError("ai", `Помощник: транзакция отката «${row.tool}» (${row.id}): ${err instanceof Error ? err.message : String(err)}`);
    throw new AssistantActionError(503, "UNDO_RETRY", "Не получилось. Нажмите «Отменить» ещё раз.");
  });
  if (outcome.replay) {
    await assertActionReadable(outcome.row, executor, actor);
  } else if (outcome.afterCommit) {
    void Promise.resolve().then(outcome.afterCommit).catch((err) =>
      console.error("[assistant] post-commit undo work failed:", err)
    );
  }
  return { action: toView(outcome.row), replay: outcome.replay };
}

export async function undoAssistantAction(
  actionId: string,
  actor: AssistantActionActor,
  opts: { now?: Date } = {}
): Promise<AssistantActionOutcome> {
  const now = opts.now ?? new Date();
  const { row, executor } = await loadAuthorizedAction(actionId, actor);
  if (row.status === "UNDONE") return { action: toView(row), replay: true };
  if (row.status !== "EXECUTED" || !row.executedAt) {
    throw new AssistantActionError(409, "NOT_EXECUTED", "Откатить можно только выполненное действие");
  }
  const preview = row.preview as AssistantActionPreview;
  if (!canUndo(executor, row.result) || preview.irreversible) {
    throw new AssistantActionError(409, "NOT_UNDOABLE", "Это действие не откатывается");
  }
  const windowMs = executor.undoWindowMs ?? ASSISTANT_ACTION_UNDO_WINDOW_MS;
  const undoUntil = new Date(row.executedAt.getTime() + windowMs);
  if (executor.recoverableUndo?.matches(row.result)) {
    const snapshotAfter = row.snapshotAfter as AssistantActionSnapshot | null;
    if (!snapshotAfter) throw undoStaleError();
    const outcome = await executor.recoverableUndo.execute(parseArgs(executor, row.args), actor, {
      actionId: row.id,
      snapshotBefore: row.snapshotBefore as AssistantActionSnapshot,
      snapshotAfter,
      result: row.result,
      now,
      undoUntil,
    });
    const { row: fresh } = await loadAuthorizedAction(actionId, actor);
    if (fresh.status !== "UNDONE") throw new AssistantActionError(503, "UNDO_RETRY", "Откат ещё не завершён. Проверьте позже.");
    return { action: toView(fresh), replay: outcome.replay };
  }
  if (undoUntil <= now) {
    throw new AssistantActionError(410, "UNDO_WINDOW_PASSED", "Время на отмену вышло");
  }
  if (executor.transactionalUndo?.matches(row.result)) {
    return undoTransactionalAction(row, executor, executor.transactionalUndo.execute, actor, now);
  }
  if (!executor.undo) throw new AssistantActionError(409, "NOT_UNDOABLE", "Это действие не откатывается");
  const claimed = await claimUndoAction(prisma, row, actor, now);
  if (claimed.count === 0) {
    const fresh = await prisma.assistantAction.findUniqueOrThrow({ where: { id: row.id } });
    if (fresh.status === "UNDONE") return { action: toView(fresh), replay: true };
    throw new AssistantActionError(409, "IN_PROGRESS", "Откат уже выполняется");
  }
  const release = () =>
    prisma.assistantAction.updateMany({
      where: { id: row.id, status: "EXECUTED" },
      data: { undoClaimedAt: null },
    });

  const snapshotBefore = row.snapshotBefore as AssistantActionSnapshot;
  const snapshotAfter = row.snapshotAfter as AssistantActionSnapshot | null;
  let args: unknown;
  try {
    args = parseArgs(executor, row.args);
    if (!snapshotAfter) throw undoStaleError();
    assertUndoSnapshot(await readSnapshot(executor, args, actor), snapshotAfter);
    await executor.undo(args, actor, { actionId: row.id, snapshotBefore, snapshotAfter, result: row.result });
  } catch (err) {
    await release();
    if (err instanceof AssistantActionError) throw err;
    await logSystemError("ai", `Помощник: откат «${row.tool}» (${row.id}) упал: ${(err as Error).message}`, {
      stack: (err as Error).stack,
    });
    throw new AssistantActionError(500, "UNDO_FAILED", "Не получилось отменить действие");
  }

  const undone = await saveUndoneAction(prisma, row);
  logAgentAudit(actor.agentId, `ASSISTANT_${row.tool.toUpperCase()}_UNDO`, "AssistantAction", row.id, undoAuditMeta(row, actor));
  return { action: toView(undone), replay: false };
}
