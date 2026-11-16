import { transferRequestRespondSchema, type TransferRequestView } from "@royal-home/shared";
import { prisma } from "../db.js";
import type { Prisma } from "../generated/prisma/client.js";
import { closeLeadPushNotification, sendPushToAgent } from "../push.js";
import { assignClientManually } from "./assignClientManually.js";
import { logAgentAudit } from "./audit.js";
import {
  EXECUTING_MARK,
  isTransferReviewer,
  publishTransferChanged,
  pushTag,
  reviewerAgents,
  toViews,
  type RequestRow,
} from "./ownershipTransferRecord.js";
import { assignableAgentError } from "./propertyAssignableAgent.js";
import { propertyOwnerAgentId } from "./propertyOwner.js";
import { transferPropertyWithSeller } from "./propertyTransferWithSeller.js";

/**
 * РЕШЕНИЕ ДИРЕКТОРА ПО ПЕРЕДАЧЕ РОП И ВОЗВРАТ КАРТОЧКИ (владелец 16.11.2026). Запись и уведомление — в
 * ownershipTransferRecord.ts (см. шапку там). «Подтвердить» снимает вопрос, «Отклонить» возвращает карточку
 * прежнему хозяину теми же функциями передачи.
 */

export { isTransferReviewer } from "./ownershipTransferRecord.js";

interface ReturnInput {
  kind: "PROPERTY" | "CLIENT";
  targetId: string;
  toAgentId: string;
  reason: string;
  actorId: string;
  actorRole: string | null | undefined;
  /** Кто должен быть хозяином сейчас: если сменился — вернуть нельзя. */
  expectedFromAgentId: string;
}

type ExecuteResult = { ok: true } | { ok: false; status: number; error: string };

/** Возврат карточки — существующим кодом передачи, без новых путей записи. */
async function executeReturn(input: ReturnInput): Promise<ExecuteResult> {
  if (input.kind === "PROPERTY") {
    const property = await prisma.property.findUnique({
      where: { id: input.targetId },
      select: { id: true, deletedAt: true, status: true, intakeAgentId: true, assignedAgentId: true, createdById: true },
    });
    if (!property || property.deletedAt) return { ok: false, status: 404, error: "Объект удалён" };
    if (property.status === "SOLD" || property.status === "WITHDRAWN") return { ok: false, status: 409, error: "Объект уже продан или снят с продажи" };
    if (propertyOwnerAgentId(property) !== input.expectedFromAgentId) return { ok: false, status: 409, error: "Объект уже у другого агента" };
    const agentError = await assignableAgentError(input.toAgentId);
    if (agentError) return { ok: false, status: 400, error: agentError };
    const result = await transferPropertyWithSeller({
      propertyId: property.id,
      toAgentId: input.toAgentId,
      reason: input.reason,
      actorId: input.actorId,
      source: "manual",
    });
    logAgentAudit(input.actorId, "PROPERTY_TRANSFER", "Property", property.id, {
      fromAgentId: result.fromAgentId,
      toAgentId: input.toAgentId,
      reason: input.reason,
      source: "rop_transfer_declined",
    } as Prisma.InputJsonValue);
    return { ok: true };
  }
  const client = await prisma.client.findUnique({ where: { id: input.targetId }, select: { assignedAgentId: true, deletedAt: true } });
  if (!client || client.deletedAt) return { ok: false, status: 404, error: "Клиент удалён" };
  if (client.assignedAgentId !== input.expectedFromAgentId) return { ok: false, status: 409, error: "Клиент уже у другого агента" };
  const outcome = await assignClientManually({
    clientId: input.targetId,
    toAgentId: input.toAgentId,
    actor: { id: input.actorId, role: input.actorRole },
    via: "owner_confirm",
    note: input.reason,
    // Гонка с автоматикой: клиента, ушедшего к другому между проверкой и записью, не трогаем.
    expected: { assignedAgentId: input.expectedFromAgentId },
  });
  if (!outcome.ok) return { ok: false, status: outcome.status, error: outcome.error };
  return { ok: true };
}

export type TransferOutcome<T = unknown> =
  | { ok: true; status: 200; body: T }
  | { ok: false; status: number; body: { error: string; code?: string } };

const fail = (status: number, error: string, code?: string): TransferOutcome<never> => ({
  ok: false,
  status,
  body: code ? { error, code } : { error },
});

export interface TransferReviewer {
  id: string;
  role: string | null | undefined;
}

/**
 * Решение директора (или администратора). «Подтвердить» — снимает вопрос. «Отклонить» — возвращает
 * карточку прежнему хозяину. Двойной клик и гонка двух директоров решаются одним условным захватом статуса.
 */
export async function reviewRopTransfer(
  actor: TransferReviewer,
  requestId: string,
  raw: unknown
): Promise<TransferOutcome<{ request: TransferRequestView }>> {
  if (!isTransferReviewer(actor.role)) return fail(403, "Решает директор или администратор");
  const parsed = transferRequestRespondSchema.safeParse(raw);
  if (!parsed.success) return fail(400, "Выберите «Подтвердить» или «Отклонить»");
  const row = await prisma.ownershipTransferRequest.findUnique({ where: { id: requestId } });
  if (!row) return fail(404, "Запрос не найден");

  const decline = parsed.data.decision === "decline";
  const target = decline ? "DECLINED" : "CONFIRMED";
  if (row.status !== "PENDING") {
    if (row.status === target && row.resultNote !== EXECUTING_MARK) {
      const [view] = await toViews([row]);
      return { ok: true, status: 200, body: { request: view } };
    }
    if (row.status === target) return fail(409, "Возврат уже выполняется, подождите", "IN_PROGRESS");
    return fail(409, row.status === "CANCELLED" ? "Карточку уже передали повторно — решайте по новому уведомлению" : "Решение уже принято", "NOT_PENDING");
  }

  const now = new Date();
  const claim = await prisma.ownershipTransferRequest.updateMany({
    where: { id: row.id, status: "PENDING" },
    data: {
      status: target,
      decidedById: actor.id,
      decidedAt: now,
      decisionNote: parsed.data.note ?? null,
      resultNote: decline ? EXECUTING_MARK : null,
    },
  });
  if (claim.count === 0) {
    const fresh = await prisma.ownershipTransferRequest.findUnique({ where: { id: row.id } });
    if (fresh && fresh.status === target) {
      const [view] = await toViews([fresh]);
      return { ok: true, status: 200, body: { request: view } };
    }
    return fail(409, "Решение уже принято", "NOT_PENDING");
  }

  void closeLeadPushNotification(actor.id, pushTag(row.id)).catch(() => {});
  const entity = row.kind === "PROPERTY" ? "Property" : "Client";
  const targetId = row.propertyId ?? row.clientId ?? "";
  const finish = async (status: RequestRow["status"], resultNote: string | null) => {
    const updated = await prisma.ownershipTransferRequest.update({ where: { id: row.id }, data: { status, resultNote } });
    const reviewers = await reviewerAgents();
    publishTransferChanged([...reviewers.map((r) => r.id), row.requestedById], row.id);
    const [view] = await toViews([updated]);
    return view;
  };
  const notifyRop = (title: string, body: string) =>
    void sendPushToAgent(row.requestedById, {
      kind: "oversight",
      title,
      body,
      url: row.propertyId ? `/properties/${row.propertyId}` : "/clients",
      tag: `transfer-result-${row.id}`,
    }).catch(() => {});

  if (!decline) {
    logAgentAudit(actor.id, "TRANSFER_REVIEW_CONFIRMED", entity, targetId, { requestId: row.id, requestedById: row.requestedById } as Prisma.InputJsonValue);
    const view = await finish("CONFIRMED", null);
    return { ok: true, status: 200, body: { request: view } };
  }

  let done: ExecuteResult;
  try {
    done = await executeReturn({
      kind: row.kind,
      targetId,
      toAgentId: row.fromAgentId,
      reason: `Директор отклонил передачу${parsed.data.note ? `: ${parsed.data.note}` : ""}`,
      actorId: actor.id,
      actorRole: actor.role,
      expectedFromAgentId: row.toAgentId,
    });
  } catch (err) {
    console.error("[transfer-review] возврат после отклонения упал:", err);
    done = { ok: false, status: 500, error: "Не удалось вернуть карточку, попробуйте позже" };
  }
  if (!done.ok) {
    logAgentAudit(actor.id, "TRANSFER_REVIEW_FAILED", entity, targetId, { requestId: row.id, error: done.error } as Prisma.InputJsonValue);
    const view = await finish("FAILED", done.error);
    notifyRop("⚠️ Передачу отклонили, вернуть не удалось", `${view.targetTitle}: ${done.error}.`);
    return fail(done.status, `Вернуть не удалось: ${done.error}`, "RETURN_FAILED");
  }
  logAgentAudit(actor.id, "TRANSFER_REVIEW_DECLINED", entity, targetId, {
    requestId: row.id,
    requestedById: row.requestedById,
    returnedToAgentId: row.fromAgentId,
    note: parsed.data.note ?? null,
  } as Prisma.InputJsonValue);
  const view = await finish("DECLINED", null);
  notifyRop(
    "❌ Директор отклонил передачу",
    `${view.targetTitle} возвращён(а) ${view.fromAgent?.fullName ?? "прежнему хозяину"}.${parsed.data.note ? ` Комментарий: ${parsed.data.note}` : ""}`
  );
  return { ok: true, status: 200, body: { request: view } };
}

/** Ждущие решения (окно директора). Не директору — пусто: у агентов и РОП никаких окон. */
export async function listPendingTransferReviews(actor: TransferReviewer): Promise<TransferRequestView[]> {
  if (!isTransferReviewer(actor.role)) return [];
  const rows = await prisma.ownershipTransferRequest.findMany({
    where: { status: "PENDING" },
    orderBy: { createdAt: "asc" },
    take: 30,
  });
  return toViews(rows);
}

/** Мои передачи и их исходы: РОП видит свои, директор — все. */
export async function listOutgoingTransferRequests(actor: TransferReviewer): Promise<TransferRequestView[]> {
  const rows = await prisma.ownershipTransferRequest.findMany({
    where: isTransferReviewer(actor.role) ? {} : { requestedById: actor.id },
    orderBy: { createdAt: "desc" },
    take: 50,
  });
  return toViews(rows);
}

/** Тик: отклонённые, но не доведённые до конца (падение процесса между захватом и возвратом) → FAILED. */
export async function runTransferRequestTick(now = new Date()): Promise<{ stuck: number }> {
  const stuck = await prisma.ownershipTransferRequest.findMany({
    where: { status: "DECLINED", resultNote: EXECUTING_MARK, decidedAt: { lte: new Date(now.getTime() - 5 * 60_000) } },
    take: 100,
  });
  let n = 0;
  for (const row of stuck) {
    const claim = await prisma.ownershipTransferRequest.updateMany({
      where: { id: row.id, status: "DECLINED", resultNote: EXECUTING_MARK },
      data: { status: "FAILED", resultNote: "Возврат не завершился — проверьте карточку" },
    });
    if (claim.count) {
      n += 1;
      publishTransferChanged([row.requestedById], row.id);
    }
  }
  return { stuck: n };
}
