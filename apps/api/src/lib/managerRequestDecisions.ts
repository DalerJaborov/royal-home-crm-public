import type { PropertyDeleteRequestReason } from "@royal-home/shared";
import { prisma } from "../db.js";
import { closeLeadPushNotifications, sendPushToAgent } from "../push.js";
import { logAgentAudit } from "./audit.js";
import { publishPropertyUpdated, publishRequestUpdated } from "./livePublish.js";
import { CHANGE_REQUEST_INCLUDE, summarizeChangeRequest, toChangeRequestDto } from "./propertyChangeRequests.js";
import { closeForOtherReviewers } from "./propertyChangeRequestService.js";
import { findAgentsWithPermission } from "./recipients.js";
import { applySellerRefusal } from "./sellerRefusalReview.js";
import { trashClient } from "./trashClient.js";
import { trashProperty } from "./trashProperty.js";

/**
 * РЕШЕНИЯ РУКОВОДСТВА ПО ЗАЯВКАМ — ОДНА ДВЕРЬ ДЛЯ ЭКРАНА И ШАБНАМ (17.11.2026,
 * «режим директора»).
 *
 * Тела «Отклонить заявку на изменение» и «Одобрить / Отклонить заявку на удаление»
 * (объекта и клиента) жили прямо в обработчиках маршрутов. Теперь их зовут и экран
 * (routes/properties/changeRequests.ts, routes/properties/deleteRequests.ts,
 * routes/clients/deleteRequests.ts), и помощница (ai/assistant/tools/directorTools.ts):
 * поведение одно — тот же условный захват PENDING → решение, тот же журнал, те же
 * уведомления. «Принять» заявку на изменение — уже общая функция
 * `approvePropertyChangeRequest` (routes/properties/changeRequestExecutor.ts), сюда не
 * переносилась.
 *
 * Право решает вызывающий (маршрут — requirePermission, помощница — свежие права
 * нажавшего): здесь его НЕ проверяют, чтобы правило не раздвоилось.
 * Тексты ответов — дословно те, что раньше отдавал маршрут.
 */

export type RequestDecisionOutcome =
  | { ok: true; message: string; alreadyTrashed?: boolean }
  | { ok: false; status: number; error: string };

const ALREADY_DECIDED = "По этой заявке уже вынесено решение";

// ───────────────────────────── заявки на изменение объекта ─────────────────────────────

/** «Отклонить» заявку на изменение: причина обязательна (проверяет схема на входе). */
export async function rejectPropertyChangeRequest(input: {
  requestId: string;
  actorId: string;
  note: string;
}): Promise<
  | { ok: true; message: string; request: ReturnType<typeof toChangeRequestDto> }
  | { ok: false; status: number; error: string }
> {
  const request = await prisma.propertyChangeRequest.findUnique({
    where: { id: input.requestId },
    include: { property: { select: { id: true, shortId: true, title: true, price: true, currency: true } } },
  });
  if (!request) return { ok: false, status: 404, error: "Заявка не найдена" };
  if (request.status !== "PENDING") return { ok: false, status: 409, error: ALREADY_DECIDED };

  // Условный переход PENDING → REJECTED: проигравший гонку получает 409 (как у заявок на удаление).
  const decided = await prisma.propertyChangeRequest.updateMany({
    where: { id: request.id, status: "PENDING" },
    data: { status: "REJECTED", decidedById: input.actorId, decidedAt: new Date(), decisionNote: input.note },
  });
  if (decided.count === 0) return { ok: false, status: 409, error: ALREADY_DECIDED };

  const summary = summarizeChangeRequest(request.kind, request.payload, request.property);
  logAgentAudit(input.actorId, "PROPERTY_CHANGE_REQUEST_DECIDED", "Property", request.propertyId, {
    requestId: request.id,
    kind: request.kind,
    decision: "REJECTED",
    summary,
    authorId: request.authorId,
    note: input.note,
  });
  void sendPushToAgent(request.authorId, {
    title: "Заявка отклонена",
    body: `${request.property.title}: ${summary}\nПричина: ${input.note}`,
    url: `/properties/${request.property.shortId}?changeRequest=${request.id}`,
    tag: `property-change-request-${request.id}-result`,
  });
  void closeForOtherReviewers(request.id, input.actorId);
  publishRequestUpdated({
    requestId: request.id,
    propertyId: request.propertyId,
    agentIds: [request.authorId],
    stage: "REJECTED",
    actorId: input.actorId,
  });

  const row = await prisma.propertyChangeRequest.findUniqueOrThrow({
    where: { id: request.id },
    include: CHANGE_REQUEST_INCLUDE,
  });
  return { ok: true, request: toChangeRequestDto(row), message: "Заявка отклонена, агенту отправлена причина" };
}

// ───────────────────────────── заявки на удаление объекта ─────────────────────────────

function loadPendingPropertyDeleteRequest(id: string) {
  return prisma.propertyDeleteRequest.findUnique({
    where: { id },
    include: { property: { select: { id: true, shortId: true, title: true, deletedAt: true } } },
  });
}

/**
 * Заявку решил один из тех, у кого `properties.delete`, — у остальных согласующих
 * уведомление о ней гасится (иначе висело бы в шторке вечно). Кража невозможна
 * (409-гейт по статусу), это чистка мусорного уведомления.
 */
async function closePropertyDeleteRequestForOtherReviewers(requestId: string): Promise<void> {
  const recipients = await findAgentsWithPermission("properties.delete");
  await closeLeadPushNotifications(recipients.map((id) => ({ agentId: id, tag: `property-delete-request-${requestId}` })));
}

/**
 * «Одобрить» заявку на удаление объекта. Удаление — тем же путём, что прямое
 * DELETE /properties/:id (trashProperty: проверка сделок, снятие с сайта, deletedAt).
 * Решение берётся атомарно ДО удаления; отказ trashProperty возвращает заявку в PENDING.
 */
export async function approvePropertyDeleteRequest(input: {
  requestId: string;
  actorId: string;
  decisionNote: string | null;
}): Promise<RequestDecisionOutcome> {
  const request = await loadPendingPropertyDeleteRequest(input.requestId);
  if (!request) return { ok: false, status: 404, error: "Заявка не найдена" };
  if (request.status !== "PENDING") return { ok: false, status: 409, error: ALREADY_DECIDED };

  // Объект уже в Корзине — заявка исполнена, а не сломана (07.09.2026): закрываем её.
  const alreadyTrashed = !!request.property.deletedAt;

  const claimed = await prisma.propertyDeleteRequest.updateMany({
    where: { id: request.id, status: "PENDING" },
    data: { status: "APPROVED", decidedById: input.actorId, decidedAt: new Date(), decisionNote: input.decisionNote },
  });
  if (claimed.count === 0) return { ok: false, status: 409, error: ALREADY_DECIDED };
  const releaseClaim = () =>
    prisma.propertyDeleteRequest.updateMany({
      where: { id: request.id, status: "APPROVED", decidedById: input.actorId },
      data: { status: "PENDING", decidedById: null, decidedAt: null, decisionNote: null },
    });

  let result: Awaited<ReturnType<typeof trashProperty>> | null = null;
  if (!alreadyTrashed) {
    try {
      result = await trashProperty(request.propertyId, input.actorId, {
        removalReason: request.reason as PropertyDeleteRequestReason,
        removalComment: request.comment ?? undefined,
        requestId: request.id,
      });
    } catch (err) {
      await releaseClaim().catch(() => undefined);
      throw err;
    }
    if (!result.ok) {
      // Активная сделка — временное препятствие: заявка остаётся на столе руководства.
      await releaseClaim();
      return { ok: false, status: result.status, error: result.error };
    }
  }

  if (result?.ok) {
    logAgentAudit(input.actorId, "TRASH", "Property", result.property.id, {
      shortId: result.property.shortId,
      title: result.property.title,
      publishedOnSite: result.property.publishedOnSite,
      deleteRequestId: request.id,
    });
  }

  // Сторона продавца: остановить счётчик тишины, причину «продан в обход» — в СБ (09.09.2026).
  void applySellerRefusal({
    propertyId: request.propertyId,
    reason: request.reason,
    comment: request.comment,
    requestedById: request.requestedById,
  }).catch((err) => console.error("[заявка] сторона продавца:", err instanceof Error ? err.message : err));

  void closePropertyDeleteRequestForOtherReviewers(request.id).catch((err) =>
    console.error("[push] закрытие заявки на удаление объекта у остальных согласующих:", err)
  );

  publishRequestUpdated({
    requestId: request.id,
    propertyId: request.propertyId,
    agentIds: [request.requestedById],
    stage: "APPROVED",
    actorId: input.actorId,
  });
  publishPropertyUpdated({ propertyId: request.propertyId, actorId: input.actorId, stage: "TRASHED" });

  return {
    ok: true,
    alreadyTrashed,
    message: alreadyTrashed ? "Объект уже был в Корзине — заявка закрыта" : "Объект удалён в Корзину",
  };
}

/** «Отклонить» заявку на удаление объекта: причина обязательна, агенту — уведомление с ней. */
export async function rejectPropertyDeleteRequest(input: {
  requestId: string;
  actorId: string;
  decisionNote: string;
}): Promise<RequestDecisionOutcome> {
  const request = await loadPendingPropertyDeleteRequest(input.requestId);
  if (!request) return { ok: false, status: 404, error: "Заявка не найдена" };
  if (request.status !== "PENDING") return { ok: false, status: 409, error: ALREADY_DECIDED };

  const decided = await prisma.propertyDeleteRequest.updateMany({
    where: { id: request.id, status: "PENDING" },
    data: { status: "REJECTED", decidedById: input.actorId, decidedAt: new Date(), decisionNote: input.decisionNote },
  });
  if (decided.count === 0) return { ok: false, status: 409, error: ALREADY_DECIDED };

  logAgentAudit(input.actorId, "DELETE_REQUEST_REJECT", "Property", request.propertyId, {
    requestId: request.id,
    shortId: request.property.shortId,
    title: request.property.title,
    decisionNote: input.decisionNote,
  });

  void sendPushToAgent(request.requestedById, {
    title: "Заявка на удаление отклонена",
    body: `${request.property.title}: ${input.decisionNote}`,
    url: `/properties/${request.property.shortId}`,
    tag: `property-delete-request-${request.id}`,
  });
  void closePropertyDeleteRequestForOtherReviewers(request.id).catch((err) =>
    console.error("[push] закрытие заявки на удаление объекта у остальных согласующих:", err)
  );

  publishRequestUpdated({
    requestId: request.id,
    propertyId: request.propertyId,
    agentIds: [request.requestedById],
    stage: "REJECTED",
    actorId: input.actorId,
  });

  return { ok: true, message: "Заявка отклонена, агенту отправлено объяснение" };
}

// ───────────────────────────── заявки на удаление клиента ─────────────────────────────

function loadPendingClientDeleteRequest(id: string) {
  return prisma.clientDeleteRequest.findUnique({
    where: { id },
    include: { client: { select: { id: true, shortId: true, fullName: true, kind: true, deletedAt: true } } },
  });
}

/** Зеркало closePropertyDeleteRequestForOtherReviewers для клиентов (право `clients.delete`). */
export async function closeClientDeleteRequestForOtherReviewers(requestId: string): Promise<void> {
  const recipients = await findAgentsWithPermission("clients.delete");
  await closeLeadPushNotifications(recipients.map((id) => ({ agentId: id, tag: `delete-request-${requestId}` })));
}

/**
 * «Одобрить» заявку на удаление клиента — тем же путём, что прямое DELETE /clients/:id
 * (trashClient). Решение берётся атомарно ДО удаления (CRM-06); отказ trashClient
 * возвращает заявку в PENDING.
 */
export async function approveClientDeleteRequest(input: {
  requestId: string;
  actorId: string;
  decisionNote: string | null;
}): Promise<RequestDecisionOutcome> {
  const request = await loadPendingClientDeleteRequest(input.requestId);
  if (!request) return { ok: false, status: 404, error: "Заявка не найдена" };
  if (request.status !== "PENDING") return { ok: false, status: 409, error: ALREADY_DECIDED };

  // Карточка уже в Корзине — заявка исполнена, а не сломана (07.09.2026): закрываем её.
  const alreadyTrashed = !!request.client.deletedAt;

  const claimed = await prisma.clientDeleteRequest.updateMany({
    where: { id: request.id, status: "PENDING" },
    data: { status: "APPROVED", decidedById: input.actorId, decidedAt: new Date(), decisionNote: input.decisionNote },
  });
  if (claimed.count === 0) return { ok: false, status: 409, error: ALREADY_DECIDED };
  const releaseClaim = () =>
    prisma.clientDeleteRequest.updateMany({
      where: { id: request.id, status: "APPROVED", decidedById: input.actorId },
      data: { status: "PENDING", decidedById: null, decidedAt: null, decisionNote: null },
    });

  let result: Awaited<ReturnType<typeof trashClient>> | null = null;
  if (!alreadyTrashed) {
    try {
      result = await trashClient(request.clientId, input.actorId);
    } catch (err) {
      await releaseClaim().catch(() => undefined);
      throw err;
    }
    if (!result.ok) {
      await releaseClaim();
      return { ok: false, status: result.status, error: result.error };
    }
  }

  if (result?.ok) {
    logAgentAudit(input.actorId, "TRASH", "Client", result.client.id, {
      shortId: result.client.shortId,
      fullName: result.client.fullName,
      phone: result.client.phone,
      kind: result.client.kind,
      deleteRequestId: request.id,
    });
  }

  void closeClientDeleteRequestForOtherReviewers(request.id).catch((err) =>
    console.error("[push] закрытие заявки на удаление у остальных согласующих:", err)
  );

  publishRequestUpdated({
    requestId: request.id,
    clientId: request.clientId,
    agentIds: [request.requestedById],
    stage: "APPROVED",
    actorId: input.actorId,
  });

  return {
    ok: true,
    alreadyTrashed,
    message: alreadyTrashed
      ? "Карточка уже была в Корзине — заявка закрыта, агенту отправлено уведомление"
      : "Клиент удалён в Корзину, агенту отправлено уведомление",
  };
}

/** «Отклонить» заявку на удаление клиента: причина обязательна, карточка возвращается агенту в список. */
export async function rejectClientDeleteRequest(input: {
  requestId: string;
  actorId: string;
  decisionNote: string;
}): Promise<RequestDecisionOutcome> {
  const request = await loadPendingClientDeleteRequest(input.requestId);
  if (!request) return { ok: false, status: 404, error: "Заявка не найдена" };
  if (request.status !== "PENDING") return { ok: false, status: 409, error: ALREADY_DECIDED };

  const decided = await prisma.clientDeleteRequest.updateMany({
    where: { id: request.id, status: "PENDING" },
    data: { status: "REJECTED", decidedById: input.actorId, decidedAt: new Date(), decisionNote: input.decisionNote },
  });
  if (decided.count === 0) return { ok: false, status: 409, error: ALREADY_DECIDED };

  logAgentAudit(input.actorId, "DELETE_REQUEST_REJECT", "Client", request.clientId, {
    requestId: request.id,
    shortId: request.client.shortId,
    fullName: request.client.fullName,
    decisionNote: input.decisionNote,
  });

  void sendPushToAgent(request.requestedById, {
    title: "Заявка на удаление отклонена",
    body: `${request.client.fullName}: ${input.decisionNote}`,
    url: `/clients/${request.client.shortId}`,
    tag: `delete-request-${request.id}`,
  });
  void closeClientDeleteRequestForOtherReviewers(request.id).catch((err) =>
    console.error("[push] закрытие заявки на удаление у остальных согласующих:", err)
  );

  publishRequestUpdated({
    requestId: request.id,
    clientId: request.clientId,
    agentIds: [request.requestedById],
    stage: "REJECTED",
    actorId: input.actorId,
  });

  return { ok: true, message: "Заявка отклонена, агенту отправлено объяснение" };
}
