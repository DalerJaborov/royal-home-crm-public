/**
 * ЗАЯВКА АГЕНТА НА ИЗМЕНЕНИЕ ОПУБЛИКОВАННОГО ОБЪЕКТА — СОЗДАНИЕ И ОТЗЫВ
 * (31.10.2026, П3 «prop», правило «одно правило — одно место»).
 *
 * Тела `POST /properties/:id/change-requests` и `POST /properties/change-requests/
 * :rid/cancel` раньше сидели прямо в обработчиках `routes/properties/
 * changeRequests.ts`. ИИ-помощнику (ai/assistant/tools/propertyTools.ts) нужно то
 * же самое от имени сотрудника без HTTP-запроса, и писать вторую копию условий
 * («только по опубликованному», «цена должна отличаться», «одна ждущая на пару»)
 * значило бы получить два правила, которые разойдутся. Теперь REST и помощник
 * зовут ЭТИ функции; поведение REST не менялось.
 *
 * Условность записи: `expect` — состояние объекта, которое видел человек в
 * превью. Проверяется под замком объекта в той же транзакции, что и создание
 * заявки: цену/статус успели поменять — `STALE` вместо заявки по устаревшим
 * «было → станет». REST `expect` не передаёт.
 */
import {
  PROPERTY_CHANGE_KIND_LABELS,
  type CreatePropertyChangeRequestInput,
  type PermissionId,
  type PropertyChangeRequestDto,
} from "@royal-home/shared";
import type { Prisma } from "../generated/prisma/client.js";
import { prisma, type TxClient } from "../db.js";
import { logAgentAudit } from "./audit.js";
import { enqueueDirectorAlert } from "./directorAlertQueue.js";
import { findAgentsWithPermission } from "./recipients.js";
import { publishRequestUpdated } from "./livePublish.js";
import { withPropertyLock } from "./videoHandoff.js";
import { canManagePropertyAs } from "./propertyAccess.js";
import {
  CHANGE_REQUEST_INCLUDE,
  PRICE_UNDO_GUARD,
  readPriceUndoGuard,
  type AssistantPriceUndoLink,
  isPublishedForChangeRequest,
  parseCardPatch,
  summarizeChangeRequest,
  toChangeRequestDto,
} from "./propertyChangeRequests.js";
import { closeLeadPushNotifications } from "../push.js";
import { toCents } from "./money.js";
import { ASSISTANT_PRICE_UNDO_JOB, appliedPriceUndoResult } from "./assistantPriceUndoJournal.js";

export interface ChangeRequestActor {
  agentId: string;
  can: (permission: PermissionId) => boolean;
}

export type ChangeRequestFailure = {
  ok: false;
  status: 400 | 403 | 404 | 409 | 410;
  error: string;
  /** Для помощника: состояние изменилось после превью (отличить от «уже отправлена»). */
  code?: "STALE" | "DUPLICATE" | "UNDO_WINDOW_PASSED" | "UNDO_UNCERTAIN";
};

export type CreateChangeRequestResult =
  | { ok: true; request: PropertyChangeRequestDto }
  | ChangeRequestFailure;

/** Что человек видел в превью: любое расхождение с базой под замком — STALE. */
export interface ChangeRequestExpectation {
  /** Сумма в сотых (`toCents`), как лежит в базе. */
  priceCents: number;
  currency: string;
  status: string;
  propertyVersion?: number;
}

type PropertyRow = Prisma.PropertyGetPayload<Record<string, never>>;

/**
 * ПРОВЕРКИ ЗАЯВКИ БЕЗ ЗАПИСИ: чьё это дело, опубликован ли объект, допустим ли вид.
 * Порядок ответов — как у REST-обработчика: 403 (не ваш объект) → 409 (до публикации
 * правят сами) → проверки вида (400/409). Зовёт и подача заявки, и превью помощника
 * («вам это недоступно» раньше карточки подтверждения), поэтому правило одно.
 * Возвращает тело, которое ляжет в базу (для данных — только разобранные поля).
 */
export function checkPropertyChangeRequest(
  property: PropertyRow,
  actor: ChangeRequestActor,
  body: CreatePropertyChangeRequestInput
): { ok: true; payloadObject: object } | ChangeRequestFailure {
  if (!canManagePropertyAs(actor, property)) {
    return { ok: false, status: 403, error: "Заявку подаёт агент, который ведёт этот объект" };
  }
  if (!isPublishedForChangeRequest(property.status)) {
    return { ok: false, status: 409, error: "До публикации карточку можно править самому" };
  }

  // Проверки по виду; тело, которое ляжет в базу, — уже разобранное (для данных — только поля из набора).
  let payloadObject: object = body.payload;
  if (body.kind === "PRICE_CHANGE") {
    const currency = body.payload.currency ?? property.currency;
    if (Number(property.price) === body.payload.newPrice && property.currency === currency) {
      return { ok: false, status: 400, error: "Новая цена совпадает с текущей" };
    }
    if (property.status === "SOLD") {
      return { ok: false, status: 409, error: "Цену проданного объекта исправляет руководитель напрямую" };
    }
  } else if (body.kind === "CARD_DATA") {
    const patch = parseCardPatch(body.payload.patch, property as unknown as Record<string, unknown>);
    if (!patch.ok) return { ok: false, status: 400, error: patch.error };
    payloadObject = { patch: patch.patch, remake: body.payload.remake };
  } else if (body.kind === "UNPUBLISH") {
    const published = property.publishedChannels ?? [];
    if (published.length === 0) {
      return { ok: false, status: 409, error: "Ролик нигде не отмечен опубликованным — снимать нечего" };
    }
    const foreign = (body.payload.channels ?? []).filter((c) => !published.includes(c));
    if (foreign.length > 0) {
      return { ok: false, status: 400, error: `Ролик не опубликован в: ${foreign.join(", ")}` };
    }
  }
  return { ok: true, payloadObject };
}

/**
 * Подаёт заявку. 404 (нет/удалён) → проверки `checkPropertyChangeRequest` →
 * 409 «такая заявка уже отправлена» (под замком объекта).
 */
export async function createPropertyChangeRequest(input: {
  propertyId: string;
  actor: ChangeRequestActor;
  body: CreatePropertyChangeRequestInput;
  expect?: ChangeRequestExpectation & { guardPriceUndo?: true };
  assistantUndo?: AssistantPriceUndoLink & { now: Date; undoUntil: Date };
  /** Куда записать в журнал источник: REST ничего не добавляет. */
  auditSource?: Record<string, unknown>;
}): Promise<CreateChangeRequestResult> {
  const { actor, body, assistantUndo } = input;

  const property = await prisma.property.findUnique({ where: { id: input.propertyId } });
  if (!property || property.deletedAt) return { ok: false, status: 404, error: "Объект не найден" };
  const checked = checkPropertyChangeRequest(property, actor, body);
  if (!checked.ok && !assistantUndo) return checked;
  const payloadObject = checked.ok ? checked.payloadObject : body.payload;

  // В базу тело ложится как JSON (undefined-поля отпадают так же, как при сериализации ответа).
  const payload = JSON.parse(JSON.stringify(payloadObject)) as Prisma.InputJsonObject;

  // Проверка «одна ждущая на пару» и создание — под замком объекта: два быстрых нажатия кнопки не дадут две заявки.
  const created = await withPropertyLock(input.propertyId, async (tx) => {
    if (assistantUndo) {
      const existing = await tx.propertyChangeRequest.findUnique({
        where: { id: assistantUndo.actionId },
        include: CHANGE_REQUEST_INCLUDE,
      });
      if (existing) {
        if (existing.propertyId === property.id && existing.authorId === actor.agentId &&
          existing.kind === "PRICE_CHANGE" && readPriceUndoGuard(existing.payload)?.assistant?.actionId === assistantUndo.actionId) {
          return existing;
        }
        return "UNDO_UNCERTAIN" as const;
      }
      const action = await tx.assistantAction.findUnique({ where: { id: assistantUndo.actionId } });
      const applied = appliedPriceUndoResult(action?.result);
      if (!action || action.agentId !== actor.agentId || action.tool !== "change_property_price" ||
        action.status !== "EXECUTED" || action.undoClaimedAt || !applied ||
        (action.snapshotAfter as { propertyId?: string } | null)?.propertyId !== property.id) {
        return "UNDO_UNCERTAIN" as const;
      }
      if (assistantUndo.undoUntil <= assistantUndo.now) return "UNDO_WINDOW_PASSED" as const;
      if (body.kind !== "PRICE_CHANGE" || !input.expect?.guardPriceUndo) return "UNDO_UNCERTAIN" as const;
      const source = await tx.propertyChangeRequest.findUnique({
        where: { id: applied.requestId },
        select: { propertyId: true, authorId: true, kind: true, status: true, result: true },
      });
      if (source?.propertyId !== property.id || source.authorId !== actor.agentId || source.kind !== "PRICE_CHANGE" ||
        (source.status !== "APPROVED" && source.status !== "FAILED")) return "UNDO_UNCERTAIN" as const;
      if (applied.propertyVersion === undefined) {
        const recorded = (source.result as { applied?: unknown } | null)?.applied;
        if (!Array.isArray(recorded) || !recorded.some((item) => typeof item === "string" && item.startsWith("Цена в карточке: "))) {
          return "UNDO_UNCERTAIN" as const;
        }
      }
    }
    let requestPayload = payload;
    if (input.expect) {
      const fresh = await tx.property.findUnique({
        where: { id: property.id },
        select: { price: true, currency: true, status: true, deletedAt: true, version: true },
      });
      if (
        !fresh ||
        fresh.deletedAt ||
        toCents(fresh.price) !== input.expect.priceCents ||
        fresh.currency !== input.expect.currency ||
        fresh.status !== input.expect.status ||
        (input.expect.propertyVersion !== undefined && fresh.version !== input.expect.propertyVersion)
      ) {
        return "STALE" as const;
      }
      if (body.kind === "PRICE_CHANGE" && input.expect.guardPriceUndo) {
        requestPayload = {
          ...payload,
          [PRICE_UNDO_GUARD]: {
            priceCents: input.expect.priceCents,
            currency: fresh.currency,
            status: fresh.status,
            version: fresh.version,
            ...(assistantUndo ? { assistant: { actionId: assistantUndo.actionId, channel: assistantUndo.channel } } : {}),
          },
        };
      }
    }
    if (!checked.ok) return checked;
    const existing = await tx.propertyChangeRequest.findFirst({
      where: { propertyId: property.id, kind: body.kind, status: "PENDING" },
      select: { id: true },
    });
    if (existing) return null;
    const request = await tx.propertyChangeRequest.create({
      data: {
        ...(assistantUndo ? { id: assistantUndo.actionId } : {}),
        propertyId: property.id,
        authorId: actor.agentId,
        kind: body.kind,
        payload: requestPayload,
        comment: body.comment?.trim() || null,
      },
      include: CHANGE_REQUEST_INCLUDE,
    });
    if (assistantUndo) {
      const claimed = await tx.assistantAction.updateMany({
        where: { id: assistantUndo.actionId, agentId: actor.agentId, status: "EXECUTED", undoClaimedAt: null },
        data: { undoClaimedAt: assistantUndo.now },
      });
      if (!claimed.count) throw new Error("Assistant price undo claim changed while staging");
      await tx.backgroundJob.create({
        data: {
          type: ASSISTANT_PRICE_UNDO_JOB,
          payload: { requestId: request.id },
          dedupeKey: `${ASSISTANT_PRICE_UNDO_JOB}:${request.id}`,
          maxAttempts: 8,
        },
      });
      await tx.auditLog.create({
        data: {
          action: "PROPERTY_CHANGE_REQUEST",
          entityType: "Property",
          entityId: property.id,
          agentId: actor.agentId,
          agentName: request.author.fullName,
          meta: {
            requestId: request.id, kind: body.kind, summary: summarizeChangeRequest(body.kind, payload, property),
            shortId: property.shortId, title: property.title, comment: request.comment, ...input.auditSource,
          } as Prisma.InputJsonValue,
        },
      });
    }
    return request;
  });
  if (created === "UNDO_UNCERTAIN") {
    return { ok: false, status: 409, code: "UNDO_UNCERTAIN", error: "Не удалось подтвердить результат прежнего отката. Проверьте журнал цены в CRM." };
  }
  if (created === "UNDO_WINDOW_PASSED") {
    return { ok: false, status: 410, code: "UNDO_WINDOW_PASSED", error: "Время на отмену вышло" };
  }
  if (created === "STALE") {
    return { ok: false, status: 409, code: "STALE", error: "Объект изменился после показа превью — проверьте ещё раз" };
  }
  if (!created) return { ok: false, status: 409, code: "DUPLICATE", error: "Такая заявка уже отправлена" };
  if ("ok" in created) return created;
  if (assistantUndo) return { ok: true, request: toChangeRequestDto(created) };

  const summary = summarizeChangeRequest(body.kind, payload, property);
  logAgentAudit(actor.agentId, "PROPERTY_CHANGE_REQUEST", "Property", property.id, {
    requestId: created.id,
    kind: body.kind,
    summary,
    shortId: property.shortId,
    title: property.title,
    comment: created.comment,
    ...(input.auditSource ?? {}),
  } as Prisma.InputJsonValue);

  // Кому решать — тем и сообщаем, по праву, а не по роли. Часы алармов (07.09.2026): заявка уже
  // в очереди, откладывается только пуш о ней.
  void enqueueDirectorAlert({
    title: `📝 ${PROPERTY_CHANGE_KIND_LABELS[body.kind]}: объект №${property.shortId}`,
    body: `${created.author.fullName}: ${summary}`,
    url: `/properties/${property.shortId}?changeRequest=${created.id}`,
    kind: "property-change-request",
    level: "APPROVAL",
    tag: `property-change-request-${created.id}`,
    recipientPermission: "properties.delete",
    excludeAgentId: actor.agentId,
  });
  publishRequestUpdated({
    requestId: created.id,
    propertyId: property.id,
    agentIds: [actor.agentId],
    stage: "PENDING",
    actorId: actor.agentId,
  });

  return { ok: true, request: toChangeRequestDto(created) };
}

/** Гасит уведомление о заявке у руководителей, которые её не решали (зеркало заявок на удаление). */
export async function closeForOtherReviewers(requestId: string, exceptAgentId: string | null): Promise<void> {
  try {
    const recipients = await findAgentsWithPermission("properties.delete");
    await closeLeadPushNotifications(
      recipients
        .filter((id) => id !== exceptAgentId)
        .map((agentId) => ({ agentId, tag: `property-change-request-${requestId}` }))
    );
  } catch (err) {
    console.error("[push] закрытие заявки на изменение у остальных согласующих:", err);
  }
}

type CancelChangeRequestFailure = { ok: false; status: 403 | 404 | 409; error: string };
export type CancelChangeRequestResult = { ok: true; request: PropertyChangeRequestDto } | CancelChangeRequestFailure;

interface CancelChangeRequestInput {
  requestId: string;
  actorId: string;
  note?: string;
  auditSource?: Record<string, unknown>;
}

async function cancelPropertyChangeRequestRow(db: TxClient, input: CancelChangeRequestInput, propertyId?: string) {
  const request = await db.propertyChangeRequest.findUnique({
    where: { id: input.requestId },
    select: { id: true, status: true, authorId: true, propertyId: true, kind: true },
  });
  if (!request || (propertyId && request.propertyId !== propertyId)) {
    return { ok: false, status: 404, error: "Заявка не найдена" } satisfies CancelChangeRequestFailure;
  }
  if (request.authorId !== input.actorId) {
    return { ok: false, status: 403, error: "Отозвать заявку может только тот, кто её подал" } satisfies CancelChangeRequestFailure;
  }
  const alreadyDecided = { ok: false, status: 409, error: "Заявка уже решена — отозвать нельзя" } satisfies CancelChangeRequestFailure;
  if (request.status !== "PENDING") return alreadyDecided;

  const done = await db.propertyChangeRequest.updateMany({
    where: { id: request.id, authorId: input.actorId, status: "PENDING" },
    data: { status: "CANCELLED", decidedAt: new Date(), decisionNote: input.note ?? "Отозвана автором" },
  });
  if (done.count === 0) return alreadyDecided;
  const meta = {
    requestId: request.id,
    kind: request.kind,
    ...(input.auditSource ?? {}),
  } as Prisma.InputJsonValue;
  const afterCommit = () => {
    void closeForOtherReviewers(request.id, null);
    publishRequestUpdated({
      requestId: request.id,
      propertyId: request.propertyId,
      agentIds: [request.authorId],
      stage: "CANCELLED",
      actorId: input.actorId,
    });
  };
  return { ok: true as const, request, meta, afterCommit };
}

/** Автор отзывает свою заявку: условный переход PENDING → CANCELLED. */
export async function cancelPropertyChangeRequest(input: CancelChangeRequestInput): Promise<CancelChangeRequestResult> {
  const cancelled = await cancelPropertyChangeRequestRow(prisma, input);
  if (!cancelled.ok) return cancelled;
  logAgentAudit(input.actorId, "PROPERTY_CHANGE_REQUEST_CANCELLED", "Property", cancelled.request.propertyId, cancelled.meta);
  cancelled.afterCommit();
  const row = await prisma.propertyChangeRequest.findUniqueOrThrow({
    where: { id: cancelled.request.id },
    include: CHANGE_REQUEST_INCLUDE,
  });
  return { ok: true, request: toChangeRequestDto(row) };
}

/** Pending assistant undo already holds the object lock and owns the transaction. */
export async function cancelPropertyChangeRequestInTransaction(tx: TxClient, input: CancelChangeRequestInput & { propertyId: string }) {
  const cancelled = await cancelPropertyChangeRequestRow(tx, input, input.propertyId);
  if (!cancelled.ok) return cancelled;
  const agent = await tx.agent.findUnique({ where: { id: input.actorId }, select: { fullName: true } });
  await tx.auditLog.create({
    data: {
      action: "PROPERTY_CHANGE_REQUEST_CANCELLED",
      entityType: "Property",
      entityId: cancelled.request.propertyId,
      agentId: input.actorId,
      agentName: agent?.fullName ?? "Неизвестно",
      meta: cancelled.meta,
    },
  });
  return { ok: true as const, afterCommit: cancelled.afterCommit };
}
