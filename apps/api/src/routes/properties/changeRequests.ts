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
  PROPERTY_CHANGE_STATUSES,
  createPropertyChangeRequestSchema,
  decidePropertyChangeRequestSchema,
  rejectPropertyChangeRequestSchema,
} from "@royal-home/shared";
import { prisma } from "../../db.js";
import { can, requireAuth, requirePermission } from "../../auth/middleware.js";
import { CHANGE_REQUEST_INCLUDE, toChangeRequestDto } from "../../lib/propertyChangeRequests.js";
import { cancelPropertyChangeRequest, createPropertyChangeRequest } from "../../lib/propertyChangeRequestService.js";
import { rejectPropertyChangeRequest } from "../../lib/managerRequestDecisions.js";
import { canManageProperty } from "./shared.js";
import { applyOwnChangeRequestNow, approvePropertyChangeRequest } from "./changeRequestExecutor.js";
import { canApplyChangeDirectly } from "../../lib/propertyAccess.js";

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
    // Тело отказа — lib/managerRequestDecisions.ts: тем же путём отклоняет и Шабнам (режим директора).
    const outcome = await rejectPropertyChangeRequest({
      requestId: req.params.rid,
      actorId: req.agent!.id,
      note: parsed.data.note,
    });
    if (!outcome.ok) return res.status(outcome.status).json({ error: outcome.error });
    res.json({ request: outcome.request, message: outcome.message });
  }
);

/** POST /properties/change-requests/:rid/cancel — отзывает автор, пока заявка ждёт решения. */
changeRequestsRouter.post("/change-requests/:rid/cancel", requireAuth, async (req, res) => {
  const result = await cancelPropertyChangeRequest({ requestId: req.params.rid, actorId: req.agent!.id });
  if (!result.ok) return res.status(result.status).json({ error: result.error });
  res.json({ request: result.request, message: "Заявка отозвана" });
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
    // СВОЁ — СРАЗУ (владелец 15.11.2026: «без неё можно менять любые свои данные»): цена, данные карточки
    // и перемонтаж своего объекта принимаются автором тем же исполнителем, что «Принять» директора;
    // чужой объект и «убрать из соцсетей» / «Другое» остаются заявкой. Правило одно с Шабнам.
    const actor = { agentId: req.agent!.id, role: req.agent!.role, can: (permission: Parameters<typeof can>[1]) => can(req, permission) };
    const property = await prisma.property.findUnique({
      where: { id: req.params.id },
      select: { status: true, assignedAgentId: true, intakeAgentId: true, createdById: true },
    });
    const direct =
      property !== null &&
      canApplyChangeDirectly(actor, property, parsed.data.kind, {
        removeFromSocial: parsed.data.kind === "REMAKE_VIDEO" && parsed.data.payload.removeFromSocial,
      });
    // Сама подача заявки (проверки по виду, замок, журнал, уведомление руководству) —
    // lib/propertyChangeRequestService.ts: её же зовёт ИИ-помощник. Для «своё сразу» пуш директору не ставится.
    const result = await createPropertyChangeRequest({
      propertyId: req.params.id,
      actor,
      body: parsed.data,
      applyDirectly: direct,
    });
    if (!result.ok) return res.status(result.status).json({ error: result.error });

    if (direct) {
      const applied = await applyOwnChangeRequestNow(result.request.id, req.agent!.id);
      if (!applied.ok) return res.status(applied.status).json({ error: applied.error });
      return res.status(201).json({ request: applied.request, applied: applied.request.status === "APPROVED", message: applied.message });
    }
    res.status(201).json({ request: result.request });
  }
);

