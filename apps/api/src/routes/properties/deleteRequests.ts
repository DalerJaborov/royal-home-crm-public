/**
 * ЗАЯВКИ АГЕНТА НА УДАЛЕНИЕ ОБЪЕКТА (31.08.2026) — зеркало
 * routes/clients/deleteRequests.ts, то же устройство и то же решение
 * владельца, распространённое на карточки объектов: агент фиксирует повод,
 * руководство выносит решение, обе стороны узнают об этом уведомлением.
 * Удаление НИКОГДА не происходит по заявке само — только когда человек с
 * правом `properties.delete` нажал «Одобрить».
 *
 * ⚠️ ПОРЯДОК РЕГИСТРАЦИИ: этот роутер обязан подключаться ДО listRouter — у
 * него статичный путь `GET /delete-requests`, который иначе съест `GET /:id`
 * (см. комментарий в index.ts).
 */
import { Router } from "express";
import { canViewInvestigations } from "@royal-home/shared";
import {
  PROPERTY_DELETE_REQUEST_REASON_LABELS,
  DELETE_REQUEST_STATUSES,
  propertyDeleteRequestApproveSchema,
  propertyDeleteRequestRejectSchema,
  propertyDeleteRequestSchema,
  type PropertyDeleteRequestReason,
} from "@royal-home/shared";
import { z } from "zod";
import { prisma } from "../../db.js";
import { buildPropertyDeleteDossiers, presentPropertyDeleteDossier } from "../../lib/propertyDeleteDossier.js";
import { requireAuth, requirePermission, can } from "../../auth/middleware.js";
import { logAudit } from "../../lib/audit.js";
import { canManageProperty } from "./shared.js";
import { enqueueDirectorAlert } from "../../lib/directorAlertQueue.js";
import { approvePropertyDeleteRequest, rejectPropertyDeleteRequest } from "../../lib/managerRequestDecisions.js";

import { publishRequestUpdated } from "../../lib/livePublish.js";

export const deleteRequestsRouter = Router();

const listQuerySchema = z.object({
  status: z.enum(DELETE_REQUEST_STATUSES).optional(),
});

function reasonLabel(reason: string): string {
  return PROPERTY_DELETE_REQUEST_REASON_LABELS[reason as PropertyDeleteRequestReason] ?? reason;
}

/**
 * GET /properties/delete-requests — очередь для руководства.
 *
 * По умолчанию только PENDING: экран «Заявки на удаление» в Архиве — это список
 * дел, а не журнал (решённые видны в Корзине и в истории действий). Предел
 * выборки обязателен по стандарту проекта: заявки копятся, а листать их никто не
 * будет — 200 самых свежих закрывают любую реальную очередь.
 */
deleteRequestsRouter.get(
  "/delete-requests",
  requireAuth,
  requirePermission("properties.delete"),
  async (req, res) => {
    const parsed = listQuerySchema.safeParse(req.query);
    if (!parsed.success) return res.status(400).json({ error: "Неверный запрос" });
    const status = parsed.data.status ?? "PENDING";

    const items = await prisma.propertyDeleteRequest.findMany({
      where: { status },
      orderBy: { createdAt: "desc" },
      take: 200,
      include: {
        requestedBy: { select: { id: true, fullName: true } },
        decidedBy: { select: { id: true, fullName: true } },
        property: {
          select: {
            id: true,
            shortId: true,
            title: true,
            price: true,
            currency: true,
            status: true,
            deletedAt: true,
            assignedAgent: { select: { id: true, fullName: true } },
          },
        },
      },
    });

    // ДОСЬЕ РЯДОМ С КНОПКОЙ «ОДОБРИТЬ» (16.09.2026) — всё, что система знает про
    // объект, чтобы решение принималось не по одной причине, написанной агентом
    // (см. lib/propertyDeleteDossier.ts: там же дословная тревога владельца).
    // Считается ПАЧКОЙ на весь список: по запросу на строку это были бы сотни
    // обращений к базе.
    const seesDossier = canViewInvestigations(req.agent?.role) && can(req, "clients.securityReview");
    const dossiers = seesDossier ? await buildPropertyDeleteDossiers(items.map((r) => r.property.id)) : new Map();

    res.json({
      items: items.map((r) => ({
        id: r.id,
        status: r.status,
        reason: r.reason,
        reasonLabel: reasonLabel(r.reason),
        comment: r.comment,
        commentVoiceUrl: r.commentVoiceUrl,
        commentVoiceTranscript: r.commentVoiceTranscript,
        createdAt: r.createdAt,
        decidedAt: r.decidedAt,
        decisionNote: r.decisionNote,
        requestedBy: r.requestedBy,
        decidedBy: r.decidedBy,
        property: r.property,
        ...(seesDossier ? { dossier: presentPropertyDeleteDossier(dossiers.get(r.property.id), can(req, "clients.viewPhone")) } : {}),
      })),
    });
  }
);

/**
 * GET /properties/:id/delete-request — есть ли по карточке заявка, ждущая решения.
 *
 * Нужен самой карточке: кнопку «Направить на удаление» нельзя ни гасить в серый,
 * ни показывать как ни в чём не бывало — вместо неё встаёт видимая строка «заявка
 * отправлена, ждёт решения» (правило проекта: причина недоступности — текстом
 * рядом, а не подсказкой при наведении).
 */
deleteRequestsRouter.get("/:id/delete-request", requireAuth, async (req, res) => {
  const property = await prisma.property.findUnique({
    where: { id: req.params.id },
    select: { id: true, assignedAgentId: true, intakeAgentId: true, createdById: true },
  });
  if (!property) return res.status(404).json({ error: "Объект не найден" });
  if (!canManageProperty(req, property)) {
    return res.status(403).json({ error: "Это чужой объект" });
  }

  const pending = await prisma.propertyDeleteRequest.findFirst({
    where: { propertyId: property.id, status: "PENDING" },
    orderBy: { createdAt: "desc" },
    include: { requestedBy: { select: { id: true, fullName: true } } },
  });

  res.json({
    request: pending
      ? {
          id: pending.id,
          status: pending.status,
          reason: pending.reason,
          reasonLabel: reasonLabel(pending.reason),
          comment: pending.comment,
          commentVoiceUrl: pending.commentVoiceUrl,
          commentVoiceTranscript: pending.commentVoiceTranscript,
          createdAt: pending.createdAt,
          requestedBy: pending.requestedBy,
        }
      : null,
  });
});

/**
 * POST /properties/:id/delete-request — агент просит удалить карточку.
 *
 * Объект агент обязан вести сам (риелтор по сделке, интейкер или создатель
 * карточки — тот же круг, что решает canManageProperty; руководство с правом
 * `properties.viewAll` тоже может завести заявку). Вторая заявка по тому же
 * объекту не заводится: очередь руководства не должна наполняться повторами
 * одного и того же повода.
 */
deleteRequestsRouter.post(
  "/:id/delete-request",
  requireAuth,
  requirePermission("properties.requestDelete"),
  async (req, res) => {
    const parsed = propertyDeleteRequestSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: parsed.error.issues[0]?.message ?? "Неверные данные" });
    }

    const property = await prisma.property.findUnique({
      where: { id: req.params.id },
      select: {
        id: true,
        shortId: true,
        title: true,
        assignedAgentId: true,
        intakeAgentId: true,
        createdById: true,
        deletedAt: true,
      },
    });
    if (!property || property.deletedAt) return res.status(404).json({ error: "Объект не найден" });
    if (!canManageProperty(req, property)) {
      return res.status(403).json({ error: "Заявку заводит агент, который ведёт этот объект" });
    }

    const existing = await prisma.propertyDeleteRequest.findFirst({
      where: { propertyId: property.id, status: "PENDING" },
      select: { id: true, createdAt: true },
    });
    if (existing) {
      return res.status(409).json({ error: "По этому объекту уже есть заявка — она ждёт решения руководства" });
    }

    const request = await prisma.propertyDeleteRequest.create({
      data: {
        propertyId: property.id,
        requestedById: req.agent!.id,
        reason: parsed.data.reason,
        comment: parsed.data.comment?.trim() || null,
        commentVoiceUrl: parsed.data.voiceNoteUrl ?? null,
        commentVoiceTranscript: parsed.data.voiceNoteTranscript ?? null,
      },
    });

    logAudit(req, "DELETE_REQUEST", "Property", property.id, {
      requestId: request.id,
      reason: parsed.data.reason,
      shortId: property.shortId,
      title: property.title,
    });

    // Кому решать — тем и сообщаем, по праву, а не по роли (lib/recipients.ts).
    // Часы алармов (владелец 07.09.2026): заявка уже в очереди Архива, ждёт
    // решения в любом случае — откладывается только пуш о ней.
    const author = await prisma.agent.findUnique({ where: { id: req.agent!.id }, select: { fullName: true } });
    void enqueueDirectorAlert({
      title: "🗑️ Заявка на удаление объекта",
      body: `${author?.fullName ?? "Агент"}: ${property.title} — ${reasonLabel(parsed.data.reason)}`,
      url: "/archive",
      kind: "oversight",
      tag: `property-delete-request-${request.id}`,
      recipientPermission: "properties.delete",
    });

    publishRequestUpdated({
      requestId: request.id,
      propertyId: property.id,
      agentIds: [req.agent!.id],
      stage: "PENDING",
      actorId: req.agent!.id,
    });

    res.status(201).json({
      ok: true,
      id: request.id,
      message: "Заявка отправлена — карточку удалит директор или админ, если согласится",
    });
  }
);

/**
 * POST /properties/delete-requests/:id/approve — руководство соглашается.
 *
 * Тело решения — lib/managerRequestDecisions.ts (17.11.2026): тем же путём одобряет
 * и Шабнам в режиме директора. Удаление идёт общей функцией trashProperty —
 * тем же путём, что прямое DELETE /properties/:id.
 */
deleteRequestsRouter.post(
  "/delete-requests/:id/approve",
  requireAuth,
  requirePermission("properties.delete"),
  async (req, res) => {
    const parsed = propertyDeleteRequestApproveSchema.safeParse(req.body ?? {});
    if (!parsed.success) return res.status(400).json({ error: "Неверные данные" });

    const outcome = await approvePropertyDeleteRequest({
      requestId: req.params.id,
      actorId: req.agent!.id,
      decisionNote: parsed.data.decisionNote?.trim() || null,
    });
    if (!outcome.ok) return res.status(outcome.status).json({ error: outcome.error });
    res.json({ ok: true, message: outcome.message });
  }
);

/**
 * POST /properties/delete-requests/:id/reject — руководство отказывает.
 *
 * Причина ОБЯЗАТЕЛЬНА (проверяется схемой): «отклонено» без объяснения агенту
 * ничего не говорит — он либо заведёт такую же заявку завтра, либо перестанет
 * заводить их вовсе. Тело — lib/managerRequestDecisions.ts.
 */
deleteRequestsRouter.post(
  "/delete-requests/:id/reject",
  requireAuth,
  requirePermission("properties.delete"),
  async (req, res) => {
    const parsed = propertyDeleteRequestRejectSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: parsed.error.issues[0]?.message ?? "Напишите, почему заявка отклонена" });
    }

    const outcome = await rejectPropertyDeleteRequest({
      requestId: req.params.id,
      actorId: req.agent!.id,
      decisionNote: parsed.data.decisionNote,
    });
    if (!outcome.ok) return res.status(outcome.status).json({ error: outcome.error });
    res.json({ ok: true, message: outcome.message });
  }
);
