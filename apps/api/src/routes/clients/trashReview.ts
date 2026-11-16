/**
 * «РАЗБОР УДАЛЁННОГО КЛИЕНТА» — всё, что нужно РОПу, чтобы понять, почему карточка в Корзине и что
 * с ней сделал агент (владелец 16.11.2026): кто удалил и когда, чья она была, причина из заявки,
 * журнал действий над карточкой, хронология заметок и звонков с записями.
 *
 * Обычная карточка удалённого клиента отвечает 404 (routes/clients/card.ts), поэтому разбор — своя
 * ручка за правом «Архив». Номера не открываются: хронология идёт через ту же presentTimeline, что
 * и в карточке (маска в заметках и расшифровках по clients.viewPhone), а журнал отдаёт только
 * действие, автора и время — без содержимого meta (в записи об удалении лежит настоящий номер).
 *
 * Регистрируется ДО card.ts (см. порядок в routes/clients/index.ts): путь двухсегментный, но
 * «trash» не должен превращаться в id карточки.
 */
import { Router } from "express";
import { DELETE_REQUEST_REASON_LABELS, deleteReasonLabelsFor, type DeleteRequestReason } from "@royal-home/shared";
import { prisma } from "../../db.js";
import { can, requireAuth, requirePermission } from "../../auth/middleware.js";
import { canCallArchivedClient } from "../../lib/archiveReviewCall.js";
import { clientNamePhoneSafe, phoneSafeText } from "../../lib/clientPhone.js";
import { investigationViewerRole } from "../../auth/investigations.js";
import { visibleInteractionWhere } from "../../lib/investigationPrivacy.js";
import { presentClientTimeline, TIMELINE_INTERACTION_SELECT, timelineQuerySchema } from "./card.js";

export const trashReviewRouter = Router();

/** Сколько последних записей хронологии отдаём разом: разбор — про недавнее, остальное — в журнале. */
const REVIEW_INTERACTIONS_LIMIT = 200;
const REVIEW_AUDIT_LIMIT = 50;

/** Понятные подписи действий журнала по клиенту; незнакомое действие показываем нейтрально. */
const AUDIT_LABELS: Record<string, string> = {
  CLIENT_CREATE: "Создал карточку",
  UPDATE: "Изменил карточку",
  LEAD_ACCEPT: "Принял лида",
  LEAD_DECLINE: "Отказался от лида",
  CLIENT_AGENT_CHANGE: "Передал другому агенту",
  CLIENT_REFUSE: "Завершил без сделки",
  CLIENT_DEFER: "Отложил",
  CLIENT_DEFERRED_RETURN: "Вернул из отложенных",
  CLIENT_ACTIVATE: "Сделал активным",
  CLIENT_MERGE: "Объединил с дублем",
  DELETE_REQUEST: "Попросил удалить",
  DELETE_REQUEST_REJECT: "Отклонил просьбу об удалении",
  TRASH: "Удалил в Корзину",
  RESTORE: "Восстановил из Корзины",
  ARCHIVE_REVIEW_CALL: "Позвонил из Корзины (разбор)",
};

/**
 * «Показать более ранние» в шторке разбора: тот же курсор (createdAt, id), что у ленты карточки
 * (GET /clients/:id/timeline), но для карточки из Корзины, которая обычной ручке закрыта.
 */
trashReviewRouter.get("/trash/:id/review/timeline", requireAuth, requirePermission("archive.view"), async (req, res) => {
  const parsed = timelineQuerySchema.safeParse(req.query);
  if (!parsed.success) return res.status(400).json({ error: "Неверные параметры", details: parsed.error.flatten() });
  const { before, beforeId, type, limit } = parsed.data;
  if ((before && !beforeId) || (!before && beforeId)) {
    return res.status(400).json({ error: "Курсор задаётся парой before и beforeId" });
  }
  const client = await prisma.client.findFirst({
    where: { id: req.params.id, deletedAt: { not: null } },
    select: { id: true, assignedAgentId: true },
  });
  if (!client) return res.status(404).json({ error: "Клиент не найден в Корзине" });
  const baseWhere = { ...visibleInteractionWhere(investigationViewerRole(req)), clientId: client.id, ...(type ? { type } : {}) };
  const where =
    before && beforeId
      ? { ...baseWhere, OR: [{ createdAt: { lt: before } }, { createdAt: before, id: { lt: beforeId } }] }
      : baseWhere;
  const [rows, total] = await Promise.all([
    prisma.interaction.findMany({
      where,
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      take: limit + 1,
      select: TIMELINE_INTERACTION_SELECT,
    }),
    prisma.interaction.count({ where: baseWhere }),
  ]);
  const hasMore = rows.length > limit;
  const page = hasMore ? rows.slice(0, limit) : rows;
  res.json({ items: await presentClientTimeline(req, client.assignedAgentId, page), total, hasMore });
});

trashReviewRouter.get("/trash/:id/review", requireAuth, requirePermission("archive.view"), async (req, res) => {
  const client = await prisma.client.findFirst({
    where: { id: req.params.id, deletedAt: { not: null } },
    select: {
      id: true,
      shortId: true,
      fullName: true,
      kind: true,
      status: true,
      createdAt: true,
      deletedAt: true,
      deletedById: true,
      deletedBy: { select: { id: true, fullName: true } },
      assignedAgentId: true,
      assignedAgent: { select: { id: true, fullName: true } },
      // Ушёл в общую очередь перед удалением — прежний хозяин остаётся здесь.
      lastAgent: { select: { id: true, fullName: true } },
    },
  });
  if (!client) return res.status(404).json({ error: "Клиент не найден в Корзине" });

  const interactionWhere = { ...visibleInteractionWhere(investigationViewerRole(req)), clientId: client.id };
  const [request, audit, rows, total, manualTrash] = await Promise.all([
    // Причина — из одобренной заявки; отклонённая не причина удаления.
    prisma.clientDeleteRequest.findFirst({
      where: { clientId: client.id, status: "APPROVED" },
      orderBy: { createdAt: "desc" },
      select: {
        reason: true,
        comment: true,
        status: true,
        createdAt: true,
        decidedAt: true,
        decisionNote: true,
        requestedBy: { select: { id: true, fullName: true } },
        decidedBy: { select: { id: true, fullName: true } },
      },
    }),
    // Только действие, автор и время: в meta записей об удалении лежит настоящий номер клиента.
    prisma.auditLog.findMany({
      where: { entityType: "Client", entityId: client.id },
      orderBy: { createdAt: "desc" },
      take: REVIEW_AUDIT_LIMIT,
      select: { id: true, action: true, agentName: true, createdAt: true },
    }),
    prisma.interaction.findMany({
      where: interactionWhere,
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      take: REVIEW_INTERACTIONS_LIMIT + 1,
      select: { ...TIMELINE_INTERACTION_SELECT },
    }),
    prisma.interaction.count({ where: interactionWhere }),
    // Ручное удаление оставляет запись TRASH от того же сотрудника; ночная уборка — нет
    // (она подписывается первым админом, lib/lostInactiveTrashSweep.ts).
    client.deletedById
      ? prisma.auditLog.count({ where: { entityType: "Client", entityId: client.id, action: "TRASH", agentId: client.deletedById } })
      : Promise.resolve(0),
  ]);
  const deletedAutomatically = client.deletedById === null || manualTrash === 0;

  const hasMore = rows.length > REVIEW_INTERACTIONS_LIMIT;
  const page = hasMore ? rows.slice(0, REVIEW_INTERACTIONS_LIMIT) : rows;
  const labels = deleteReasonLabelsFor(client.kind);
  const phonesAllowed = can(req, "clients.viewPhone");
  res.json({
    client: {
      id: client.id,
      shortId: client.shortId,
      // Имя старых карточек бывает «Входящий +992…» — маска как в списке Корзины.
      fullName: clientNamePhoneSafe(client.fullName, phonesAllowed),
      kind: client.kind,
      status: client.status,
      createdAt: client.createdAt,
      deletedAt: client.deletedAt,
      // null и нет deletedBy — удалила автоматика (уборка потерянных/неактивных), а не человек.
      deletedBy: deletedAutomatically ? null : client.deletedBy,
      deletedAutomatically,
      owner: client.assignedAgent ?? client.lastAgent,
    },
    deleteRequest: request
      ? {
          reason: request.reason,
          reasonLabel:
            labels[request.reason as DeleteRequestReason] ??
            DELETE_REQUEST_REASON_LABELS[request.reason as DeleteRequestReason] ??
            request.reason,
          comment: request.comment ? phoneSafeText(request.comment, phonesAllowed) : null,
          status: request.status,
          requestedBy: request.requestedBy,
          createdAt: request.createdAt,
          decidedBy: request.decidedBy,
          decidedAt: request.decidedAt,
          decisionNote: request.decisionNote ? phoneSafeText(request.decisionNote, phonesAllowed) : null,
        }
      : null,
    audit: audit.map((a) => ({
      id: a.id,
      action: a.action,
      label: AUDIT_LABELS[a.action] ?? "Действие в карточке",
      agentName: a.agentName,
      createdAt: a.createdAt,
    })),
    interactions: await presentClientTimeline(req, client.assignedAgentId, page),
    interactionsTotal: total,
    hasMore,
    canCall: canCallArchivedClient({ can: (p) => can(req, p) }),
  });
});
