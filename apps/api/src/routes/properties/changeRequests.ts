/**
 * ЗАЯВКИ АГЕНТА НА ИЗМЕНЕНИЕ ОПУБЛИКОВАННОГО ОБЪЕКТА (07.10.2026, решение владельца) —
 * зеркало routes/properties/deleteRequests.ts, тот же устройство и тот же круг решающих:
 * заявку подаёт агент (`properties.requestChange` + он ведёт объект), решает тот, у кого
 * `properties.delete` (директор/админ) — «кто удаляет, тот и судит».
 *
 * Агент по-прежнему не правит карточку после публикации: он нажимает готовую кнопку
 * («Цена изменилась», «Перемонтировать ролик»…), руководство нажимает «Принять», и CRM сама
 * делает то, что умеет через API сетей; остаток руками — задачей человеку
 * (changeRequestExecutor.ts). Договор тел и ответов — packages/shared/src/propertyChangeRequest.ts.
 *
 * ⚠️ ПОРЯДОК РЕГИСТРАЦИИ: роутер обязан подключаться ДО listRouter (см. index.ts) — у него
 * статичный путь `GET /change-requests`, который иначе съест `GET /:id`.
 */
import { Router } from "express";
import { z } from "zod";
import {
  PROPERTY_CHANGE_KIND_LABELS,
  PROPERTY_CHANGE_STATUSES,
  createPropertyChangeRequestSchema,
  decidePropertyChangeRequestSchema,
  rejectPropertyChangeRequestSchema,
} from "@royal-home/shared";
import type { Prisma } from "../../generated/prisma/client.js";
import { prisma } from "../../db.js";
import { can, requireAuth, requirePermission } from "../../auth/middleware.js";
import { logAudit } from "../../lib/audit.js";
import { enqueueDirectorAlert } from "../../lib/directorAlertQueue.js";
import { findAgentsWithPermission } from "../../lib/recipients.js";
import { sendPushToAgent, closeLeadPushNotifications } from "../../push.js";
import { publishRequestUpdated } from "../../lib/livePublish.js";
import { withPropertyLock } from "../../lib/videoHandoff.js";
import {
  CHANGE_REQUEST_INCLUDE,
  isPublishedForChangeRequest,
  parseCardPatch,
  summarizeChangeRequest,
  toChangeRequestDto,
} from "../../lib/propertyChangeRequests.js";
import { canManageProperty } from "./shared.js";
import { approvePropertyChangeRequest } from "./changeRequestExecutor.js";

export const changeRequestsRouter = Router();

const listQuerySchema = z.object({
  status: z.enum(PROPERTY_CHANGE_STATUSES).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
  cursor: z.string().min(1).max(64).optional(),
});

/** Не больше 100 своих заявок на объект в карточке: предел выборки обязателен. */
const PER_PROPERTY_LIMIT = 100;

/**
 * GET /properties/change-requests — очередь руководства. По умолчанию только PENDING
 * (список дел, а не журнал). Курсорная выдача: `nextCursor` — id последней строки.
 */
changeRequestsRouter.get("/change-requests", requireAuth, requirePermission("properties.delete"), async (req, res) => {
  const parsed = listQuerySchema.safeParse(req.query);
  if (!parsed.success) return res.status(400).json({ error: "Неверный запрос" });
  const { status = "PENDING", limit, cursor } = parsed.data;

  const rows = await prisma.propertyChangeRequest.findMany({
    where: { status },
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    take: limit + 1,
    ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
    include: CHANGE_REQUEST_INCLUDE,
  });
  const page = rows.slice(0, limit);
  res.json({
    items: page.map(toChangeRequestDto),
    nextCursor: rows.length > limit ? page[page.length - 1].id : null,
  });
});

/** POST /properties/change-requests/:rid/approve — «Принять»: захват, выполнение, итог. */
changeRequestsRouter.post(
  "/change-requests/:rid/approve",
  requireAuth,
  requirePermission("properties.delete"),
  async (req, res) => {
    const parsed = decidePropertyChangeRequestSchema.safeParse(req.body ?? {});
    if (!parsed.success) return res.status(400).json({ error: parsed.error.issues[0]?.message ?? "Неверные данные" });

    const outcome = await approvePropertyChangeRequest({
      requestId: req.params.rid,
      actorId: req.agent!.id,
      note: parsed.data.note?.trim() || null,
    });
    if (!outcome.ok) return res.status(outcome.status).json({ error: outcome.error });
    res.json({ request: outcome.request, message: outcome.message });
  }
);

/** POST /properties/change-requests/:rid/reject — отказ, причина обязательна (агент иначе не поймёт, что делать). */
changeRequestsRouter.post(
  "/change-requests/:rid/reject",
  requireAuth,
  requirePermission("properties.delete"),
  async (req, res) => {
    const parsed = rejectPropertyChangeRequestSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: parsed.error.issues[0]?.message ?? "Напишите причину отказа" });
    }
    const request = await prisma.propertyChangeRequest.findUnique({
      where: { id: req.params.rid },
      include: { property: { select: { id: true, shortId: true, title: true, price: true, currency: true } } },
    });
    if (!request) return res.status(404).json({ error: "Заявка не найдена" });
    if (request.status !== "PENDING") return res.status(409).json({ error: "По этой заявке уже вынесено решение" });

    // Условный переход PENDING → REJECTED: проигравший гонку получает 409 (как у заявок на удаление).
    const decided = await prisma.propertyChangeRequest.updateMany({
      where: { id: request.id, status: "PENDING" },
      data: { status: "REJECTED", decidedById: req.agent!.id, decidedAt: new Date(), decisionNote: parsed.data.note },
    });
    if (decided.count === 0) return res.status(409).json({ error: "По этой заявке уже вынесено решение" });

    const summary = summarizeChangeRequest(request.kind, request.payload, request.property);
    logAudit(req, "PROPERTY_CHANGE_REQUEST_DECIDED", "Property", request.propertyId, {
      requestId: request.id,
      kind: request.kind,
      decision: "REJECTED",
      summary,
      authorId: request.authorId,
      note: parsed.data.note,
    });
    void sendPushToAgent(request.authorId, {
      title: "Заявка отклонена",
      body: `${request.property.title}: ${summary}\nПричина: ${parsed.data.note}`,
      url: `/properties/${request.property.shortId}?changeRequest=${request.id}`,
      tag: `property-change-request-${request.id}-result`,
    });
    void closeForOtherReviewers(request.id, req.agent!.id);
    publishRequestUpdated({
      requestId: request.id,
      propertyId: request.propertyId,
      agentIds: [request.authorId],
      stage: "REJECTED",
      actorId: req.agent!.id,
    });

    const row = await prisma.propertyChangeRequest.findUniqueOrThrow({
      where: { id: request.id },
      include: CHANGE_REQUEST_INCLUDE,
    });
    res.json({ request: toChangeRequestDto(row), message: "Заявка отклонена, агенту отправлена причина" });
  }
);

/** POST /properties/change-requests/:rid/cancel — отзывает автор, пока заявка ждёт решения. */
changeRequestsRouter.post("/change-requests/:rid/cancel", requireAuth, async (req, res) => {
  const request = await prisma.propertyChangeRequest.findUnique({
    where: { id: req.params.rid },
    select: { id: true, status: true, authorId: true, propertyId: true, kind: true },
  });
  if (!request) return res.status(404).json({ error: "Заявка не найдена" });
  if (request.authorId !== req.agent!.id) return res.status(403).json({ error: "Отозвать заявку может только тот, кто её подал" });
  if (request.status !== "PENDING") return res.status(409).json({ error: "Заявка уже решена — отозвать нельзя" });

  const done = await prisma.propertyChangeRequest.updateMany({
    where: { id: request.id, status: "PENDING" },
    data: { status: "CANCELLED", decidedAt: new Date(), decisionNote: "Отозвана автором" },
  });
  if (done.count === 0) return res.status(409).json({ error: "Заявка уже решена — отозвать нельзя" });

  logAudit(req, "PROPERTY_CHANGE_REQUEST_CANCELLED", "Property", request.propertyId, {
    requestId: request.id,
    kind: request.kind,
  });
  void closeForOtherReviewers(request.id, null);
  publishRequestUpdated({
    requestId: request.id,
    propertyId: request.propertyId,
    agentIds: [request.authorId],
    stage: "CANCELLED",
    actorId: req.agent!.id,
  });
  const row = await prisma.propertyChangeRequest.findUniqueOrThrow({
    where: { id: request.id },
    include: CHANGE_REQUEST_INCLUDE,
  });
  res.json({ request: toChangeRequestDto(row), message: "Заявка отозвана" });
});

/** GET /properties/:id/change-requests — заявки по объекту: автор видит свои, руководство (properties.delete) — все. */
changeRequestsRouter.get("/:id/change-requests", requireAuth, async (req, res) => {
  const property = await prisma.property.findUnique({
    where: { id: req.params.id },
    select: { id: true, assignedAgentId: true, intakeAgentId: true, createdById: true, deletedAt: true },
  });
  if (!property) return res.status(404).json({ error: "Объект не найден" });
  const reviewer = can(req, "properties.delete");
  if (!reviewer && !canManageProperty(req, property)) return res.status(403).json({ error: "Это чужой объект" });

  const rows = await prisma.propertyChangeRequest.findMany({
    where: { propertyId: property.id, ...(reviewer ? {} : { authorId: req.agent!.id }) },
    orderBy: { createdAt: "desc" },
    take: PER_PROPERTY_LIMIT,
    include: CHANGE_REQUEST_INCLUDE,
  });
  res.json({ items: rows.map(toChangeRequestDto) });
});

/**
 * POST /properties/:id/change-requests — агент подаёт заявку.
 *
 * Только по ОПУБЛИКОВАННОМУ объекту (до публикации карточку правят сами), не более одной
 * ждущей заявки на пару «объект + вид», и проверки по виду: цена должна отличаться от текущей,
 * данные — быть из набора фактов подписи, снятие — относиться к каналам, где ролик вышел.
 */
changeRequestsRouter.post(
  "/:id/change-requests",
  requireAuth,
  requirePermission("properties.requestChange"),
  async (req, res) => {
    const parsed = createPropertyChangeRequestSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: parsed.error.issues[0]?.message ?? "Неверные данные заявки" });
    }
    const body = parsed.data;

    const property = await prisma.property.findUnique({ where: { id: req.params.id } });
    if (!property || property.deletedAt) return res.status(404).json({ error: "Объект не найден" });
    if (!canManageProperty(req, property)) {
      return res.status(403).json({ error: "Заявку подаёт агент, который ведёт этот объект" });
    }
    if (!isPublishedForChangeRequest(property.status)) {
      return res.status(409).json({ error: "До публикации карточку можно править самому" });
    }

    // Проверки по виду; тело, которое ляжет в базу, — уже разобранное (для данных — только поля из набора).
    let payloadObject: object = body.payload;
    if (body.kind === "PRICE_CHANGE") {
      const currency = body.payload.currency ?? property.currency;
      if (Number(property.price) === body.payload.newPrice && property.currency === currency) {
        return res.status(400).json({ error: "Новая цена совпадает с текущей" });
      }
      if (property.status === "SOLD") {
        return res.status(409).json({ error: "Цену проданного объекта исправляет руководитель напрямую" });
      }
    } else if (body.kind === "CARD_DATA") {
      const patch = parseCardPatch(body.payload.patch, property as unknown as Record<string, unknown>);
      if (!patch.ok) return res.status(400).json({ error: patch.error });
      payloadObject = { patch: patch.patch, remake: body.payload.remake };
    } else if (body.kind === "UNPUBLISH") {
      const published = property.publishedChannels ?? [];
      if (published.length === 0) {
        return res.status(409).json({ error: "Ролик нигде не отмечен опубликованным — снимать нечего" });
      }
      const foreign = (body.payload.channels ?? []).filter((c) => !published.includes(c));
      if (foreign.length > 0) {
        return res.status(400).json({ error: `Ролик не опубликован в: ${foreign.join(", ")}` });
      }
    }

    // В базу тело ложится как JSON (undefined-поля отпадают так же, как при сериализации ответа).
    const payload = JSON.parse(JSON.stringify(payloadObject)) as Prisma.InputJsonObject;

    // Проверка «одна ждущая на пару» и создание — под замком объекта: два быстрых нажатия кнопки не дадут две заявки.
    const created = await withPropertyLock(property.id, async (tx) => {
      const existing = await tx.propertyChangeRequest.findFirst({
        where: { propertyId: property.id, kind: body.kind, status: "PENDING" },
        select: { id: true },
      });
      if (existing) return null;
      return tx.propertyChangeRequest.create({
        data: {
          propertyId: property.id,
          authorId: req.agent!.id,
          kind: body.kind,
          payload,
          comment: body.comment?.trim() || null,
        },
        include: CHANGE_REQUEST_INCLUDE,
      });
    });
    if (!created) return res.status(409).json({ error: "Такая заявка уже отправлена" });

    const summary = summarizeChangeRequest(body.kind, payload, property);
    logAudit(req, "PROPERTY_CHANGE_REQUEST", "Property", property.id, {
      requestId: created.id,
      kind: body.kind,
      summary,
      shortId: property.shortId,
      title: property.title,
      comment: created.comment,
    });

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
      excludeAgentId: req.agent!.id,
    });
    publishRequestUpdated({
      requestId: created.id,
      propertyId: property.id,
      agentIds: [req.agent!.id],
      stage: "PENDING",
      actorId: req.agent!.id,
    });

    res.status(201).json({ request: toChangeRequestDto(created) });
  }
);

/** Гасит уведомление о заявке у руководителей, которые её не решали (зеркало заявок на удаление). */
async function closeForOtherReviewers(requestId: string, exceptAgentId: string | null): Promise<void> {
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
