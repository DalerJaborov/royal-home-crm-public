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
import { buildPropertyDeleteDossiers } from "../../lib/propertyDeleteDossier.js";
import { requireAuth, requirePermission } from "../../auth/middleware.js";
import { logAudit } from "../../lib/audit.js";
import { findAgentsWithPermission } from "../../lib/recipients.js";
import { sendPushToAgent, closeLeadPushNotifications } from "../../push.js";
import { trashProperty } from "../../lib/trashProperty.js";
import { applySellerRefusal } from "../../lib/sellerRefusalReview.js";
import { canManageProperty } from "./shared.js";
import { enqueueDirectorAlert } from "../../lib/directorAlertQueue.js";

import { publishRequestUpdated, publishPropertyUpdated } from "../../lib/livePublish.js";

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
    const dossiers = await buildPropertyDeleteDossiers(items.map((r) => r.property.id));

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
        ...(canViewInvestigations(req.agent?.role) ? { dossier: dossiers.get(r.property.id) ?? null } : {}),
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

/** Заявка вместе с объектом — общий пролог решений. */
async function loadPendingRequest(id: string) {
  return prisma.propertyDeleteRequest.findUnique({
    where: { id },
    include: {
      property: { select: { id: true, shortId: true, title: true, deletedAt: true } },
    },
  });
}

/**
 * Зеркало closeDeleteRequestForOtherReviewers из routes/clients/deleteRequests.ts —
 * см. комментарий там. Кража невозможна (409-гейт по status!=="PENDING"), это
 * чистка мусорного уведомления у согласующих, которые заявку не решали.
 */
async function closeDeleteRequestForOtherReviewers(requestId: string): Promise<void> {
  const recipients = await findAgentsWithPermission("properties.delete");
  await closeLeadPushNotifications(
    recipients.map((id) => ({ agentId: id, tag: `property-delete-request-${requestId}` }))
  );
}

/**
 * POST /properties/delete-requests/:id/approve — руководство соглашается.
 *
 * Удаление идёт ровно тем же путём, что прямое DELETE /properties/:id — общей
 * функцией trashProperty (проверка сделок, снятие с сайта, deletedAt). Своя
 * копия этой логики здесь однажды забыла бы снять объект с сайта — тот же
 * урок, что и с trashClient.ts.
 */
deleteRequestsRouter.post(
  "/delete-requests/:id/approve",
  requireAuth,
  requirePermission("properties.delete"),
  async (req, res) => {
    const parsed = propertyDeleteRequestApproveSchema.safeParse(req.body ?? {});
    if (!parsed.success) return res.status(400).json({ error: "Неверные данные" });

    const request = await loadPendingRequest(req.params.id);
    if (!request) return res.status(404).json({ error: "Заявка не найдена" });
    if (request.status !== "PENDING") {
      return res.status(409).json({ error: "По этой заявке уже вынесено решение" });
    }

    /**
     * ОБЪЕКТ УЖЕ В КОРЗИНЕ — ЗАЯВКА ИСПОЛНЕНА, А НЕ СЛОМАНА (07.09.2026).
     *
     * Зеркало ветки в routes/clients/deleteRequests.ts. Новые такие заявки
     * закрывает сам trashProperties, это ветка для уже повисших. Проверяем
     * deletedAt, а не текст ошибки: 404 у trashProperties означает и «объекта нет
     * вовсе», и «уже в Корзине», а это разные исходы.
     */
    const alreadyTrashed = !!request.property.deletedAt;

    // РЕШЕНИЕ БЕРЁТСЯ АТОМАРНО, ДО УДАЛЕНИЯ (аудит 04.10.2026, CRM-06) — зеркало
    // routes/clients/deleteRequests.ts: условный переход PENDING → APPROVED, проигравший
    // получает 409 и ничего не удаляет; отказ trashProperty возвращает заявку в PENDING.
    const claimed = await prisma.propertyDeleteRequest.updateMany({
      where: { id: request.id, status: "PENDING" },
      data: {
        status: "APPROVED",
        decidedById: req.agent!.id,
        decidedAt: new Date(),
        decisionNote: parsed.data.decisionNote?.trim() || null,
      },
    });
    if (claimed.count === 0) {
      return res.status(409).json({ error: "По этой заявке уже вынесено решение" });
    }
    const releaseClaim = () =>
      prisma.propertyDeleteRequest.updateMany({
        where: { id: request.id, status: "APPROVED", decidedById: req.agent!.id },
        data: { status: "PENDING", decidedById: null, decidedAt: null, decisionNote: null },
      });

    let result: Awaited<ReturnType<typeof trashProperty>> | null = null;
    if (!alreadyTrashed) {
      try {
        result = await trashProperty(request.propertyId, req.agent!.id);
      } catch (err) {
        await releaseClaim().catch(() => undefined);
        throw err;
      }
      if (!result.ok) {
        // Заявку НЕ закрываем: активная сделка — временное препятствие, руководство
        // вернётся к ней после снятия сделки, и заводить заявку заново незачем.
        await releaseClaim();
        return res.status(result.status).json({ error: result.error });
      }
    }

    // Записи об удалении нет, когда удалять было уже нечего: объект уехал в
    // Корзину раньше и своей записью в журнале уже отмечен.
    if (result?.ok) {
      logAudit(req, "TRASH", "Property", result.property.id, {
        shortId: result.property.shortId,
        title: result.property.title,
        publishedOnSite: result.property.publishedOnSite,
        deleteRequestId: request.id,
      });
    }

    /**
     * СТОРОНА ПРОДАВЦА (владелец 09.09.2026). Объект снят — теперь надо остановить
     * по продавцу счётчик тишины и пересчитать состояние его карточки, а причину
     * «продан в обход агентства» отправить в СБ. Без первого агент, честно
     * оформивший отказ, всё равно получал через три дня «забросил клиента»; без
     * второго главный антифрод-вход оставался выключенным.
     */
    // propertyId берём из самой заявки, а не из result: с 07.09.2026 объект мог
    // уехать в Корзину раньше (alreadyTrashed выше), и тогда result === null —
    // но сторону продавца закрыть всё равно надо, заявка-то исполнена.
    void applySellerRefusal({
      propertyId: request.propertyId,
      reason: request.reason,
      comment: request.comment,
      requestedById: request.requestedById,
    }).catch((err) =>
      console.error("[заявка] сторона продавца:", err instanceof Error ? err.message : err)
    );

    // Пуш «удалено по вашей заявке» убран (владелец 17.09.2026), зеркало
    // routes/clients/deleteRequests.ts: карточка пропала у агента из списка ещё
    // в момент подачи заявки — уведомление об одобрении сообщало бы о том, что
    // он не видит и так.
    void closeDeleteRequestForOtherReviewers(request.id).catch((err) =>
      console.error("[push] закрытие заявки на удаление объекта у остальных согласующих:", err)
    );

    publishRequestUpdated({
      requestId: request.id,
      propertyId: request.propertyId,
      agentIds: [request.requestedById],
      stage: "APPROVED",
      actorId: req.agent!.id,
    });
    publishPropertyUpdated({ propertyId: request.propertyId, actorId: req.agent!.id, stage: "TRASHED" });

    res.json({
      ok: true,
      message: alreadyTrashed
        ? "Объект уже был в Корзине — заявка закрыта"
        : "Объект удалён в Корзину",
    });
  }
);

/**
 * POST /properties/delete-requests/:id/reject — руководство отказывает.
 *
 * Причина ОБЯЗАТЕЛЬНА (проверяется схемой): «отклонено» без объяснения агенту
 * ничего не говорит — он либо заведёт такую же заявку завтра, либо перестанет
 * заводить их вовсе.
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

    const request = await loadPendingRequest(req.params.id);
    if (!request) return res.status(404).json({ error: "Заявка не найдена" });
    if (request.status !== "PENDING") {
      return res.status(409).json({ error: "По этой заявке уже вынесено решение" });
    }

    // Условный переход PENDING → REJECTED (CRM-06), см. approve выше.
    const decided = await prisma.propertyDeleteRequest.updateMany({
      where: { id: request.id, status: "PENDING" },
      data: {
        status: "REJECTED",
        decidedById: req.agent!.id,
        decidedAt: new Date(),
        decisionNote: parsed.data.decisionNote,
      },
    });
    if (decided.count === 0) {
      return res.status(409).json({ error: "По этой заявке уже вынесено решение" });
    }

    logAudit(req, "DELETE_REQUEST_REJECT", "Property", request.propertyId, {
      requestId: request.id,
      shortId: request.property.shortId,
      title: request.property.title,
      decisionNote: parsed.data.decisionNote,
    });

    void sendPushToAgent(request.requestedById, {
      title: "Заявка на удаление отклонена",
      body: `${request.property.title}: ${parsed.data.decisionNote}`,
      url: `/properties/${request.property.shortId}`,
      tag: `property-delete-request-${request.id}`,
    });
    void closeDeleteRequestForOtherReviewers(request.id).catch((err) =>
      console.error("[push] закрытие заявки на удаление объекта у остальных согласующих:", err)
    );

    publishRequestUpdated({
      requestId: request.id,
      propertyId: request.propertyId,
      agentIds: [request.requestedById],
      stage: "REJECTED",
      actorId: req.agent!.id,
    });

    res.json({ ok: true, message: "Заявка отклонена, агенту отправлено объяснение" });
  }
);
