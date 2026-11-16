import {
  TRANSFER_CONFIRM_HOURS_DEFAULT,
  TRANSFER_CONFIRM_HOURS_MAX,
  TRANSFER_CONFIRM_HOURS_MIN,
  transferRequestCreateSchema,
  transferRequestRespondSchema,
  type PermissionId,
  type TransferRequestView,
} from "@royal-home/shared";
import { prisma } from "../db.js";
import { Prisma } from "../generated/prisma/client.js";
import { closeLeadPushNotification, sendPushToAgent } from "../push.js";
import { assignClientManually } from "./assignClientManually.js";
import { logAgentAudit } from "./audit.js";
import { clientNamePhoneSafe } from "./clientPhone.js";
import { publish } from "./eventBus.js";
import { checkManualAssignTarget } from "./manualAssignTarget.js";
import { assignableAgentError } from "./propertyAssignableAgent.js";
import { propertyOwnerAgentId } from "./propertyOwner.js";
import { transferPropertyWithSeller } from "./propertyTransferWithSeller.js";

/**
 * ПЕРЕДАЧА С ПОДТВЕРЖДЕНИЕМ ХОЗЯИНА — ОДНА ДВЕРЬ (владелец 16.11.2026).
 *
 * «РОП может передать ЛЮБОЙ объект или клиента другому агенту, но на любую
 * передачу у текущего хозяина сначала спрашивается подтверждение — большим окном,
 * как при звонке. Не ответил — передача отменяется». Директор (и администратор)
 * передают сразу, без вопроса.
 *
 * Само переназначение НИКОГДА не пишется здесь: после «Подтвердить» зовутся те же
 * функции, что и у прямой передачи — `transferPropertyWithSeller` (объект вместе с
 * продавцом) и `assignClientManually` (клиент вместе со спутниками, единственный
 * писатель владельца — changeClientAgent). Поэтому все их проверки (открытая
 * сделка, закрытый объект, Корзина, получатель) действуют и тут, а правило «кто
 * вправе просить» и «кто вправе ответить» живёт ровно в этом файле.
 *
 * Срок и рубильник — настройки `ownerConfirmTransferHours` и
 * `ownerConfirmTransferEnabled`. Рубильник гасит только путь РОП; директор
 * передаёт напрямую при любом положении рубильника.
 */

/** Как часто повторно напоминаем хозяину, пока он не ответил. */
export const TRANSFER_REMIND_EVERY_MS = 30 * 60_000;
/** Предел напоминаний на один запрос: срок 168 ч не должен дать сотню пушей. */
export const TRANSFER_REMIND_MAX = 12;
/** Метка в resultNote, пока подтверждённая передача выполняется. */
const EXECUTING_MARK = "executing";

export interface TransferActor {
  id: string;
  role: string | null | undefined;
  can: (permission: PermissionId) => boolean;
}

export type TransferOutcome<T = unknown> =
  | { ok: true; status: 200 | 201 | 202; body: T }
  | { ok: false; status: number; body: { error: string; code?: string } };

const fail = (status: number, error: string, code?: string): TransferOutcome<never> => ({
  ok: false,
  status,
  body: code ? { error, code } : { error },
});

/** Директор и администратор передают сразу: вопрос хозяину им не задаётся. */
export function skipsOwnerConfirm(actor: Pick<TransferActor, "role">): boolean {
  return actor.role === "DIRECTOR" || actor.role === "ADMIN";
}

async function loadTransferSettings(): Promise<{ enabled: boolean; hours: number }> {
  const s = await prisma.settings.findFirst({
    select: { ownerConfirmTransferEnabled: true, ownerConfirmTransferHours: true },
  });
  const raw = s?.ownerConfirmTransferHours ?? TRANSFER_CONFIRM_HOURS_DEFAULT;
  const hours = Math.min(TRANSFER_CONFIRM_HOURS_MAX, Math.max(TRANSFER_CONFIRM_HOURS_MIN, Math.round(raw)));
  return { enabled: s?.ownerConfirmTransferEnabled ?? true, hours };
}

/** Нужно ли РОПу спрашивать хозяина перед прямым назначением клиента (используется маршрутом /clients/:id/assign). */
export async function clientNeedsOwnerConfirm(
  actor: Pick<TransferActor, "id" | "role">,
  clientId: string
): Promise<boolean> {
  if (skipsOwnerConfirm(actor) || actor.role !== "HEAD_OF_SALES") return false;
  const client = await prisma.client.findUnique({
    where: { id: clientId },
    select: { assignedAgentId: true, acceptedAt: true, deletedAt: true, assignedAgent: { select: { isActive: true } } },
  });
  if (!client || client.deletedAt || !client.assignedAgentId || !client.acceptedAt) return false;
  if (client.assignedAgentId === actor.id) return false;
  return client.assignedAgent?.isActive === true;
}

type RequestRow = Prisma.OwnershipTransferRequestGetPayload<Record<string, never>>;

async function toViews(rows: RequestRow[]): Promise<TransferRequestView[]> {
  if (rows.length === 0) return [];
  const agentIds = [...new Set(rows.flatMap((r) => [r.fromAgentId, r.toAgentId, r.requestedById]))];
  const propertyIds = rows.map((r) => r.propertyId).filter((v): v is string => !!v);
  const clientIds = rows.map((r) => r.clientId).filter((v): v is string => !!v);
  const [agents, properties, clients] = await Promise.all([
    prisma.agent.findMany({ where: { id: { in: agentIds } }, select: { id: true, fullName: true } }),
    propertyIds.length
      ? prisma.property.findMany({
          where: { id: { in: propertyIds } },
          select: { id: true, shortId: true, title: true, address: true },
        })
      : [],
    clientIds.length
      ? prisma.client.findMany({ where: { id: { in: clientIds } }, select: { id: true, shortId: true, fullName: true } })
      : [],
  ]);
  const agentById = new Map(agents.map((a) => [a.id, a]));
  const propById = new Map(properties.map((p) => [p.id, p]));
  const clientById = new Map(clients.map((c) => [c.id, c]));
  const ag = (id: string | null) => {
    const a = id ? agentById.get(id) : undefined;
    return a ? { id: a.id, fullName: a.fullName } : null;
  };
  return rows.map((r) => {
    const p = r.propertyId ? propById.get(r.propertyId) : undefined;
    const c = r.clientId ? clientById.get(r.clientId) : undefined;
    return {
      id: r.id,
      kind: r.kind,
      status: r.status,
      targetTitle: p
        ? clientNamePhoneSafe(`Объект №${p.shortId} · ${p.title}`, false)
        : c
          ? `Клиент ${clientNamePhoneSafe(c.fullName, false)}`
          : "Удалено",
      targetShortId: p?.shortId ?? c?.shortId ?? null,
      targetId: r.propertyId ?? r.clientId ?? "",
      fromAgent: ag(r.fromAgentId),
      toAgent: ag(r.toAgentId),
      requestedBy: ag(r.requestedById),
      reason: clientNamePhoneSafe(r.reason, false),
      createdAt: r.createdAt.toISOString(),
      expiresAt: r.expiresAt.toISOString(),
      decidedAt: r.decidedAt?.toISOString() ?? null,
      decisionNote: r.decisionNote,
      resultNote: r.resultNote,
    };
  });
}

function pushTag(id: string): string {
  return `transfer-confirm-${id}`;
}

/** Живое событие: хозяину поднимется окно, тому, кто просил, обновится статус. */
function publishTransferChanged(row: Pick<RequestRow, "id" | "fromAgentId" | "requestedById" | "toAgentId">): void {
  void Promise.resolve(
    publish({
      type: "transfer.pending",
      payload: { requestId: row.id },
      agentIds: [...new Set([row.fromAgentId, row.requestedById, row.toAgentId])],
    })
  ).catch(() => {});
}

function notifyOwner(row: RequestRow, view: TransferRequestView, repeat: boolean): void {
  void sendPushToAgent(row.fromAgentId, {
    kind: "lead",
    level: "APPROVAL",
    title: repeat
      ? "⏳ Ждём вашего ответа о передаче"
      : `🔁 Просят передать ${view.kind === "PROPERTY" ? "ваш объект" : "вашего клиента"}`,
    body: `${view.requestedBy?.fullName ?? "Руководитель"} просит передать: ${view.targetTitle} → ${view.toAgent?.fullName ?? "другому агенту"}. Откройте CRM и ответьте: «Подтвердить» или «Отказать».`,
    url: "/",
    tag: pushTag(row.id),
  }).catch((err) => console.error("[push] запрос передачи хозяину:", err));
}

function notifyRequester(row: RequestRow, title: string, body: string): void {
  void sendPushToAgent(row.requestedById, {
    kind: "lead",
    title,
    body,
    url: row.propertyId ? `/properties/${row.propertyId}` : "/clients",
    tag: `transfer-result-${row.id}`,
  }).catch((err) => console.error("[push] итог запроса передачи:", err));
}

function closeOwnerPush(row: Pick<RequestRow, "id" | "fromAgentId">): void {
  void closeLeadPushNotification(row.fromAgentId, pushTag(row.id)).catch(() => {});
}

type CreateBody = { pending: boolean; immediate: boolean; request?: TransferRequestView; created?: boolean };

/**
 * Создать запрос. Директор/администратор — передача выполняется сразу (без вопроса);
 * хозяин сам просит — тоже сразу. Остальным с правом `transfers.request` — запрос
 * хозяину и ожидание ответа.
 */
export async function createTransferRequest(actor: TransferActor, raw: unknown): Promise<TransferOutcome<CreateBody>> {
  const parsed = transferRequestCreateSchema.safeParse(raw);
  if (!parsed.success) return fail(400, "Проверьте данные: кому передать и причину");
  const { kind, targetId, toAgentId, reason } = parsed.data;
  if (!actor.can("transfers.request")) return fail(403, "Просить передачу может руководитель отдела продаж или директор");

  const direct = skipsOwnerConfirm(actor);
  const settings = await loadTransferSettings();
  if (!direct && !settings.enabled) {
    return fail(403, "Передача с подтверждением хозяина сейчас выключена в настройках — обратитесь к директору", "DISABLED");
  }

  // Кто сейчас хозяин и можно ли вообще передавать.
  let fromAgentId: string | null;
  if (kind === "PROPERTY") {
    const property = await prisma.property.findUnique({
      where: { id: targetId },
      select: { id: true, deletedAt: true, status: true, intakeAgentId: true, assignedAgentId: true, createdById: true },
    });
    if (!property || property.deletedAt) return fail(404, "Объект не найден");
    if (property.status === "SOLD" || property.status === "WITHDRAWN") {
      return fail(409, "Объект уже продан или снят с продажи — передавать нечего");
    }
    fromAgentId = propertyOwnerAgentId(property);
  } else {
    const client = await prisma.client.findUnique({
      where: { id: targetId },
      select: { id: true, deletedAt: true, kind: true, assignedAgentId: true },
    });
    if (!client || client.deletedAt) return fail(404, "Клиент не найден");
    if (client.kind === "OTHER") return fail(400, "«Прочее обращение» агентам не передаётся");
    fromAgentId = client.assignedAgentId;
  }
  if (fromAgentId === toAgentId) return fail(409, kind === "PROPERTY" ? "Объект уже у этого агента" : "Клиент уже у этого агента");

  if (kind === "PROPERTY") {
    const err = await assignableAgentError(toAgentId);
    if (err) return fail(400, err);
  } else {
    const target = await checkManualAssignTarget(toAgentId);
    if (!target.ok) return fail(target.status, target.error);
  }

  // Директор передаёт сразу; хозяин сам просит — тоже сразу.
  if (direct || fromAgentId === actor.id) {
    const done = await executeTransfer({
      kind,
      targetId,
      toAgentId,
      reason,
      requestedById: actor.id,
      requesterRole: actor.role,
      via: direct ? "direct" : "owner_self",
    });
    if (!done.ok) return fail(done.status, done.error);
    return { ok: true, status: 200, body: { pending: false, immediate: true } };
  }
  if (!fromAgentId) {
    return fail(409, "У карточки нет хозяина, которого можно спросить — передать её без вопроса может директор", "NO_OWNER");
  }

  // Хозяин есть — он должен быть жив, иначе спрашивать некого. Клиента уволенного РОП раздаёт сразу, как раньше
  // (прямой /assign для такого случая открыт); объект уволенного передаёт директор.
  const owner = await prisma.agent.findUnique({ where: { id: fromAgentId }, select: { isActive: true } });
  if (!owner?.isActive && kind === "CLIENT") {
    const done = await executeTransfer({
      kind,
      targetId,
      toAgentId,
      reason,
      requestedById: actor.id,
      requesterRole: actor.role,
      via: "direct",
    });
    if (!done.ok) return fail(done.status, done.error);
    return { ok: true, status: 200, body: { pending: false, immediate: true } };
  }
  if (!owner?.isActive) {
    return fail(409, "Хозяин уволен или отключён — спрашивать некого. Передачу такой карточки решает директор.", "OWNER_INACTIVE");
  }

  const pendingWhere = { status: "PENDING" as const, ...(kind === "PROPERTY" ? { propertyId: targetId } : { clientId: targetId }) };
  const existing = await prisma.ownershipTransferRequest.findFirst({ where: pendingWhere });
  if (existing) return duplicateOutcome(existing, actor, toAgentId);

  const now = new Date();
  let row: RequestRow;
  try {
    row = await prisma.ownershipTransferRequest.create({
      data: {
        kind,
        propertyId: kind === "PROPERTY" ? targetId : null,
        clientId: kind === "CLIENT" ? targetId : null,
        fromAgentId,
        toAgentId,
        requestedById: actor.id,
        reason,
        expiresAt: new Date(now.getTime() + settings.hours * 3_600_000),
        lastRemindedAt: now,
      },
    });
  } catch (err) {
    // Два РОП нажали одновременно: частичный уникальный индекс пропустил одного.
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002") {
      const again = await prisma.ownershipTransferRequest.findFirst({ where: pendingWhere });
      if (again) return duplicateOutcome(again, actor, toAgentId);
    }
    throw err;
  }

  logAgentAudit(actor.id, "TRANSFER_REQUEST_CREATED", kind === "PROPERTY" ? "Property" : "Client", targetId, {
    requestId: row.id,
    fromAgentId,
    toAgentId,
    reason,
    expiresAt: row.expiresAt.toISOString(),
  } as Prisma.InputJsonValue);

  const [view] = await toViews([row]);
  notifyOwner(row, view, false);
  publishTransferChanged(row);
  return { ok: true, status: 201, body: { pending: true, immediate: false, request: view, created: true } };
}

async function duplicateOutcome(existing: RequestRow, actor: TransferActor, toAgentId: string): Promise<TransferOutcome<CreateBody>> {
  // Повторное нажатие того же человека на того же получателя — не ошибка, а тот же запрос.
  if (existing.requestedById === actor.id && existing.toAgentId === toAgentId) {
    const [view] = await toViews([existing]);
    return { ok: true, status: 200, body: { pending: true, immediate: false, request: view, created: false } };
  }
  return fail(
    409,
    "По этой карточке уже есть запрос на передачу, хозяин ещё не ответил. Дождитесь ответа хозяина (запрос сам отменится по сроку).",
    "ALREADY_PENDING"
  );
}

interface ExecuteInput {
  kind: "PROPERTY" | "CLIENT";
  targetId: string;
  toAgentId: string;
  reason: string;
  requestedById: string;
  requesterRole: string | null | undefined;
  via: "direct" | "owner_self" | "owner_confirm";
  /** Хозяин, при котором спрашивали: если сменился — передавать нельзя. */
  expectedFromAgentId?: string;
}

type ExecuteResult = { ok: true } | { ok: false; status: number; error: string; changed?: boolean };

/** Само переназначение — существующим кодом, без новых путей записи. */
async function executeTransfer(input: ExecuteInput): Promise<ExecuteResult> {
  if (input.kind === "PROPERTY") {
    const property = await prisma.property.findUnique({
      where: { id: input.targetId },
      select: { id: true, deletedAt: true, status: true, intakeAgentId: true, assignedAgentId: true, createdById: true },
    });
    if (!property || property.deletedAt) return { ok: false, status: 404, error: "Объект удалён", changed: true };
    if (property.status === "SOLD" || property.status === "WITHDRAWN") {
      return { ok: false, status: 409, error: "Объект уже продан или снят с продажи", changed: true };
    }
    const owner = propertyOwnerAgentId(property);
    if (input.expectedFromAgentId !== undefined && owner !== input.expectedFromAgentId) {
      return { ok: false, status: 409, error: "Объект уже у другого агента", changed: true };
    }
    if (owner === input.toAgentId) return { ok: false, status: 409, error: "Объект уже у этого агента", changed: true };
    const agentError = await assignableAgentError(input.toAgentId);
    if (agentError) return { ok: false, status: 400, error: agentError };
    const result = await transferPropertyWithSeller({
      propertyId: property.id,
      toAgentId: input.toAgentId,
      reason: input.reason,
      actorId: input.requestedById,
      source: "manual",
    });
    logAgentAudit(input.requestedById, "PROPERTY_TRANSFER", "Property", property.id, {
      fromAgentId: result.fromAgentId,
      toAgentId: input.toAgentId,
      reason: input.reason,
      source: input.via,
    } as Prisma.InputJsonValue);
    return { ok: true };
  }
  const client = await prisma.client.findUnique({
    where: { id: input.targetId },
    select: { assignedAgentId: true, deletedAt: true },
  });
  if (!client || client.deletedAt) return { ok: false, status: 404, error: "Клиент удалён", changed: true };
  if (input.expectedFromAgentId !== undefined && client.assignedAgentId !== input.expectedFromAgentId) {
    return { ok: false, status: 409, error: "Клиент уже у другого агента", changed: true };
  }
  const outcome = await assignClientManually({
    clientId: input.targetId,
    toAgentId: input.toAgentId,
    actor: { id: input.requestedById, role: input.requesterRole },
    via: input.via === "owner_confirm" ? "owner_confirm" : "rest",
    // Гонка с автоматикой: клиента, ушедшего к другому агенту между проверкой и записью, не забираем (ревью 16.11.2026).
    ...(input.expectedFromAgentId !== undefined ? { expected: { assignedAgentId: input.expectedFromAgentId } } : {}),
  });
  if (!outcome.ok) return { ok: false, status: outcome.status, error: outcome.error };
  return { ok: true };
}

/**
 * Ответ хозяина (или директора за него). Двойной клик и гонка с истечением срока
 * решаются одним условным обновлением статуса: выигрывает первый.
 */
export async function respondToTransferRequest(
  actor: TransferActor,
  requestId: string,
  raw: unknown
): Promise<TransferOutcome<{ request: TransferRequestView }>> {
  const parsed = transferRequestRespondSchema.safeParse(raw);
  if (!parsed.success) return fail(400, "Выберите «Подтвердить» или «Отказать»");
  const row = await prisma.ownershipTransferRequest.findUnique({ where: { id: requestId } });
  if (!row) return fail(404, "Запрос не найден");
  const mayAnswer = row.fromAgentId === actor.id || skipsOwnerConfirm(actor);
  if (!mayAnswer) return fail(403, "Ответить может только хозяин или директор");

  const confirm = parsed.data.decision === "confirm";
  const target = confirm ? "CONFIRMED" : "DECLINED";

  if (row.status !== "PENDING") {
    // Тот же ответ повторно (двойной клик, ретрай сети) — не ошибка.
    if (row.status === target) {
      const [view] = await toViews([row]);
      return { ok: true, status: 200, body: { request: view } };
    }
    return fail(409, "На этот запрос уже ответили или срок вышел", "NOT_PENDING");
  }

  const now = new Date();
  const claim = await prisma.ownershipTransferRequest.updateMany({
    where: { id: row.id, status: "PENDING", expiresAt: { gt: now } },
    // resultNote = маркер «выполняется»: упадёт процесс до финализации — тик пометит запрос FAILED (runTransferRequestTick).
    data: {
      status: target,
      decidedById: actor.id,
      decidedAt: now,
      decisionNote: parsed.data.note ?? null,
      resultNote: confirm ? EXECUTING_MARK : null,
    },
  });
  if (claim.count === 0) {
    const fresh = await prisma.ownershipTransferRequest.findUnique({ where: { id: row.id } });
    if (fresh && fresh.status === target) {
      const [view] = await toViews([fresh]);
      return { ok: true, status: 200, body: { request: view } };
    }
    return fail(409, "Срок ответа вышел или на запрос уже ответили", "NOT_PENDING");
  }

  closeOwnerPush(row);
  const finish = async (status: RequestRow["status"], resultNote: string | null) => {
    const updated = await prisma.ownershipTransferRequest.update({
      where: { id: row.id },
      data: { status, resultNote },
    });
    publishTransferChanged(updated);
    const [view] = await toViews([updated]);
    return view;
  };

  const entity = row.kind === "PROPERTY" ? "Property" : "Client";
  const targetId = row.propertyId ?? row.clientId ?? "";

  if (!confirm) {
    logAgentAudit(actor.id, "TRANSFER_REQUEST_DECLINED", entity, targetId, {
      requestId: row.id,
      requestedById: row.requestedById,
      toAgentId: row.toAgentId,
      note: parsed.data.note ?? null,
    } as Prisma.InputJsonValue);
    const view = await finish("DECLINED", null);
    notifyRequester(
      row,
      "❌ Хозяин отказал в передаче",
      `${view.fromAgent?.fullName ?? "Хозяин"} не согласен передать: ${view.targetTitle}.${parsed.data.note ? ` Комментарий: ${parsed.data.note}` : ""}`
    );
    return { ok: true, status: 200, body: { request: view } };
  }

  const requester = await prisma.agent.findUnique({ where: { id: row.requestedById }, select: { role: true } });
  let done: ExecuteResult;
  try {
    done = await executeTransfer({
    kind: row.kind,
    targetId,
    toAgentId: row.toAgentId,
    reason: row.reason,
    requestedById: row.requestedById,
    requesterRole: requester?.role,
    via: "owner_confirm",
    expectedFromAgentId: row.fromAgentId,
    });
  } catch (err) {
    console.error("[transfer-request] передача после подтверждения упала:", err);
    done = { ok: false, status: 500, error: "Не удалось выполнить передачу, попробуйте позже" };
  }
  if (!done.ok) {
    logAgentAudit(actor.id, "TRANSFER_REQUEST_FAILED", entity, targetId, {
      requestId: row.id,
      error: done.error,
    } as Prisma.InputJsonValue);
    // Данные изменились до ответа — это «истёк», а не сбой.
    const view = await finish(done.changed ? "EXPIRED" : "FAILED", done.error);
    notifyRequester(row, "⚠️ Передача не состоялась", `${view.targetTitle}: ${done.error}.`);
    return fail(done.status, `Передача не состоялась: ${done.error}`, "EXECUTE_FAILED");
  }
  logAgentAudit(actor.id, "TRANSFER_REQUEST_CONFIRMED", entity, targetId, {
    requestId: row.id,
    requestedById: row.requestedById,
    fromAgentId: row.fromAgentId,
    toAgentId: row.toAgentId,
  } as Prisma.InputJsonValue);
  const view = await finish("CONFIRMED", null);
  notifyRequester(row, "✅ Хозяин подтвердил передачу", `${view.targetTitle} передан(а) агенту ${view.toAgent?.fullName ?? ""}.`);
  return { ok: true, status: 200, body: { request: view } };
}

/** Отозвать запрос: тот, кто просил, или директор. */
export async function cancelTransferRequest(
  actor: TransferActor,
  requestId: string
): Promise<TransferOutcome<{ request: TransferRequestView }>> {
  const row = await prisma.ownershipTransferRequest.findUnique({ where: { id: requestId } });
  if (!row) return fail(404, "Запрос не найден");
  if (row.requestedById !== actor.id && !skipsOwnerConfirm(actor)) return fail(403, "Отозвать может тот, кто просил, или директор");
  if (row.status === "CANCELLED") {
    const [view] = await toViews([row]);
    return { ok: true, status: 200, body: { request: view } };
  }
  const claim = await prisma.ownershipTransferRequest.updateMany({
    where: { id: row.id, status: "PENDING" },
    data: { status: "CANCELLED", decidedById: actor.id, decidedAt: new Date() },
  });
  if (claim.count === 0) return fail(409, "На этот запрос уже ответили или срок вышел", "NOT_PENDING");
  const updated = await prisma.ownershipTransferRequest.findUniqueOrThrow({ where: { id: row.id } });
  closeOwnerPush(updated);
  logAgentAudit(actor.id, "TRANSFER_REQUEST_CANCELLED", row.kind === "PROPERTY" ? "Property" : "Client", row.propertyId ?? row.clientId, {
    requestId: row.id,
  } as Prisma.InputJsonValue);
  publishTransferChanged(updated);
  const [view] = await toViews([updated]);
  return { ok: true, status: 200, body: { request: view } };
}

/** Ждущие ответа этого сотрудника (окно). Просроченные не отдаём, даже если cron ещё не закрыл. */
export async function listIncomingTransferRequests(agentId: string): Promise<TransferRequestView[]> {
  const rows = await prisma.ownershipTransferRequest.findMany({
    where: { fromAgentId: agentId, status: "PENDING", expiresAt: { gt: new Date() } },
    orderBy: { createdAt: "asc" },
    take: 20,
  });
  return toViews(rows);
}

/** Мои исходящие запросы и их исходы — для РОП; директор видит все. */
export async function listOutgoingTransferRequests(agentId: string, seesAll: boolean): Promise<TransferRequestView[]> {
  const rows = await prisma.ownershipTransferRequest.findMany({
    where: seesAll ? {} : { requestedById: agentId },
    orderBy: { createdAt: "desc" },
    take: 50,
  });
  return toViews(rows);
}

/**
 * Тик раз в несколько минут: закрыть просроченные (хозяин не ответил — передача
 * отменяется, директору не уходит) и напомнить тем, кто ещё может ответить.
 */
export async function runTransferRequestTick(now = new Date()): Promise<{ expired: number; reminded: number }> {
  const overdue = await prisma.ownershipTransferRequest.findMany({
    where: { status: "PENDING", expiresAt: { lte: now } },
    take: 100,
  });
  let expired = 0;
  for (const row of overdue) {
    const claim = await prisma.ownershipTransferRequest.updateMany({
      where: { id: row.id, status: "PENDING" },
      data: { status: "EXPIRED", resultNote: "Хозяин не ответил в срок — передача отменена" },
    });
    if (claim.count === 0) continue;
    expired += 1;
    closeOwnerPush(row);
    publishTransferChanged(row);
    const [view] = await toViews([row]);
    logAgentAudit(null, "TRANSFER_REQUEST_EXPIRED", row.kind === "PROPERTY" ? "Property" : "Client", row.propertyId ?? row.clientId, {
      requestId: row.id,
      fromAgentId: row.fromAgentId,
    } as Prisma.InputJsonValue);
    notifyRequester(
      row,
      "⌛ Хозяин не ответил — передача отменена",
      `${view.targetTitle}: ${view.fromAgent?.fullName ?? "хозяин"} не ответил(а) за отведённое время, карточка осталась у него. Отправьте запрос заново, если ещё нужно.`
    );
  }

  // Подтверждённые, но не доведённые до конца (падение процесса между захватом и передачей).
  const stuck = await prisma.ownershipTransferRequest.findMany({
    where: { status: "CONFIRMED", resultNote: EXECUTING_MARK, decidedAt: { lte: new Date(now.getTime() - 5 * 60_000) } },
    take: 100,
  });
  for (const row of stuck) {
    const claim = await prisma.ownershipTransferRequest.updateMany({
      where: { id: row.id, status: "CONFIRMED", resultNote: EXECUTING_MARK },
      data: { status: "FAILED", resultNote: "Передача не завершилась — проверьте карточку и отправьте запрос заново" },
    });
    if (claim.count === 0) continue;
    publishTransferChanged(row);
    const [view] = await toViews([row]);
    notifyRequester(row, "⚠️ Передача не состоялась", `${view.targetTitle}: передача не завершилась, проверьте карточку и отправьте запрос заново.`);
  }

  const due = await prisma.ownershipTransferRequest.findMany({
    where: {
      status: "PENDING",
      expiresAt: { gt: now },
      remindCount: { lt: TRANSFER_REMIND_MAX },
      OR: [{ lastRemindedAt: null }, { lastRemindedAt: { lte: new Date(now.getTime() - TRANSFER_REMIND_EVERY_MS) } }],
    },
    take: 100,
  });
  let reminded = 0;
  for (const row of due) {
    const claim = await prisma.ownershipTransferRequest.updateMany({
      where: { id: row.id, status: "PENDING", remindCount: row.remindCount },
      data: { lastRemindedAt: now, remindCount: { increment: 1 } },
    });
    if (claim.count === 0) continue;
    reminded += 1;
    const [view] = await toViews([row]);
    notifyOwner(row, view, true);
    publishTransferChanged(row);
  }
  return { expired, reminded };
}
