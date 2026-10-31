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
import { prisma } from "../db.js";
import { logAgentAudit } from "./audit.js";
import { enqueueDirectorAlert } from "./directorAlertQueue.js";
import { findAgentsWithPermission } from "./recipients.js";
import { publishRequestUpdated } from "./livePublish.js";
import { withPropertyLock } from "./videoHandoff.js";
import { canManagePropertyAs } from "./propertyAccess.js";
import {
  CHANGE_REQUEST_INCLUDE,
  isPublishedForChangeRequest,
  parseCardPatch,
  summarizeChangeRequest,
  toChangeRequestDto,
} from "./propertyChangeRequests.js";
import { closeLeadPushNotifications } from "../push.js";
import { toCents } from "./money.js";

export interface ChangeRequestActor {
  agentId: string;
  can: (permission: PermissionId) => boolean;
}

export type ChangeRequestFailure = {
  ok: false;
  status: 400 | 403 | 404 | 409;
  error: string;
  /** Для помощника: состояние изменилось после превью (отличить от «уже отправлена»). */
  code?: "STALE" | "DUPLICATE";
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
  expect?: ChangeRequestExpectation;
  /** Куда записать в журнал источник: REST ничего не добавляет. */
  auditSource?: Record<string, unknown>;
}): Promise<CreateChangeRequestResult> {
  const { actor, body } = input;

  const property = await prisma.property.findUnique({ where: { id: input.propertyId } });
  if (!property || property.deletedAt) return { ok: false, status: 404, error: "Объект не найден" };
  const checked = checkPropertyChangeRequest(property, actor, body);
  if (!checked.ok) return checked;
  const payloadObject = checked.payloadObject;

  // В базу тело ложится как JSON (undefined-поля отпадают так же, как при сериализации ответа).
  const payload = JSON.parse(JSON.stringify(payloadObject)) as Prisma.InputJsonObject;

  // Проверка «одна ждущая на пару» и создание — под замком объекта: два быстрых нажатия кнопки не дадут две заявки.
  const created = await withPropertyLock(input.propertyId, async (tx) => {
    if (input.expect) {
      const fresh = await tx.property.findUnique({
        where: { id: property.id },
        select: { price: true, currency: true, status: true, deletedAt: true },
      });
      if (
        !fresh ||
        fresh.deletedAt ||
        toCents(fresh.price) !== input.expect.priceCents ||
        fresh.currency !== input.expect.currency ||
        fresh.status !== input.expect.status
      ) {
        return "STALE" as const;
      }
    }
    const existing = await tx.propertyChangeRequest.findFirst({
      where: { propertyId: property.id, kind: body.kind, status: "PENDING" },
      select: { id: true },
    });
    if (existing) return null;
    return tx.propertyChangeRequest.create({
      data: {
        propertyId: property.id,
        authorId: actor.agentId,
        kind: body.kind,
        payload,
        comment: body.comment?.trim() || null,
      },
      include: CHANGE_REQUEST_INCLUDE,
    });
  });
  if (created === "STALE") {
    return { ok: false, status: 409, code: "STALE", error: "Объект изменился после показа превью — проверьте ещё раз" };
  }
  if (!created) return { ok: false, status: 409, code: "DUPLICATE", error: "Такая заявка уже отправлена" };

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

export type CancelChangeRequestResult =
  | { ok: true; request: PropertyChangeRequestDto }
  | { ok: false; status: 403 | 404 | 409; error: string };

/**
 * Автор отзывает свою заявку, пока она ждёт решения. Условный переход
 * PENDING → CANCELLED: проигравший гонку с «Принять» получает 409.
 */
export async function cancelPropertyChangeRequest(input: {
  requestId: string;
  actorId: string;
  note?: string;
  auditSource?: Record<string, unknown>;
}): Promise<CancelChangeRequestResult> {
  const request = await prisma.propertyChangeRequest.findUnique({
    where: { id: input.requestId },
    select: { id: true, status: true, authorId: true, propertyId: true, kind: true },
  });
  if (!request) return { ok: false, status: 404, error: "Заявка не найдена" };
  if (request.authorId !== input.actorId) {
    return { ok: false, status: 403, error: "Отозвать заявку может только тот, кто её подал" };
  }
  if (request.status !== "PENDING") return { ok: false, status: 409, error: "Заявка уже решена — отозвать нельзя" };

  const done = await prisma.propertyChangeRequest.updateMany({
    where: { id: request.id, status: "PENDING" },
    data: { status: "CANCELLED", decidedAt: new Date(), decisionNote: input.note ?? "Отозвана автором" },
  });
  if (done.count === 0) return { ok: false, status: 409, error: "Заявка уже решена — отозвать нельзя" };

  logAgentAudit(input.actorId, "PROPERTY_CHANGE_REQUEST_CANCELLED", "Property", request.propertyId, {
    requestId: request.id,
    kind: request.kind,
    ...(input.auditSource ?? {}),
  } as Prisma.InputJsonValue);
  void closeForOtherReviewers(request.id, null);
  publishRequestUpdated({
    requestId: request.id,
    propertyId: request.propertyId,
    agentIds: [request.authorId],
    stage: "CANCELLED",
    actorId: input.actorId,
  });
  const row = await prisma.propertyChangeRequest.findUniqueOrThrow({
    where: { id: request.id },
    include: CHANGE_REQUEST_INCLUDE,
  });
  return { ok: true, request: toChangeRequestDto(row) };
}
