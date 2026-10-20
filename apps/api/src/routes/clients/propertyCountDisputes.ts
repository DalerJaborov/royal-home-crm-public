/**
 * ЗАЯВКА НА ПЕРЕСМОТР ЧИСЛА ОБЪЕКТОВ (владелец 06.09.2026, разбор слепых зон
 * п.3; роль добавлена 07.09.2026 — «пусть у покупателя будет тоже самое»):
 * «не агент решает сколько у клиента объектов на продажу — ИИ сам понимает
 * это из разговора и вносит. Агент может оспорить (редактировать), если ИИ
 * неправильно понял — решение с подтверждением руководителя».
 *
 * Устройство — зеркало routes/clients/deleteRequests.ts: агент называет своё
 * число и причину, решение выносит руководитель (право `clients.merge` — тот
 * же круг, что уже разбирает споры о дубликатах клиентов), обе стороны узнают
 * об этом уведомлением. Пока заявка PENDING, аларм «заявлено N, сделано M»
 * (lib/clientPropertyCountAlarm.ts) считает от числа ИИ, а не от предложенного
 * агентом — иначе агент мог бы просто занижать число, чтобы не получить аларм.
 *
 * role различает сторону: SELLER — Client.sellerDeclaredPropertyCount, BUYER —
 * Client.buyerDesiredPropertyCount. У клиента с dualIntent обе стороны
 * независимы — может быть ОДНОВРЕМЕННО своя PENDING-заявка на продавца и своя
 * на покупателя, они не мешают друг другу.
 *
 * ⚠️ ПОРЯДОК РЕГИСТРАЦИИ: статичный GET /property-count-disputes обязан
 * матчиться ДО GET /:id (card.ts) — тот же приём, что у /delete-requests
 * (см. index.ts).
 */
import { Router } from "express";
import { z } from "zod";
import {
  propertyCountDisputeApproveSchema,
  propertyCountDisputeRejectSchema,
  propertyCountDisputeSchema,
} from "@royal-home/shared";
import { prisma } from "../../db.js";
import { can, requireAuth, requirePermission } from "../../auth/middleware.js";
import { logAudit } from "../../lib/audit.js";
import { sendPushToAgent } from "../../push.js";
import { maskPhone } from "./shared.js";
import { clientNamePhoneSafe, phoneSafeText } from "../../lib/clientPhone.js";
import { enqueueDirectorAlert } from "../../lib/directorAlertQueue.js";

import { publishRequestUpdated } from "../../lib/livePublish.js";

export const propertyCountDisputesRouter = Router();

type DisputeRole = "SELLER" | "BUYER";

/** Поле карточки, которое оспаривает каждая роль — не путать друг с другом. */
const FIELD_BY_ROLE: Record<DisputeRole, { count: "sellerDeclaredPropertyCount" | "buyerDesiredPropertyCount"; at: "sellerDeclaredPropertyCountAt" | "buyerDesiredPropertyCountAt"; label: string }> = {
  SELLER: { count: "sellerDeclaredPropertyCount", at: "sellerDeclaredPropertyCountAt", label: "продажу" },
  BUYER: { count: "buyerDesiredPropertyCount", at: "buyerDesiredPropertyCountAt", label: "покупку" },
};

const disputeListQuerySchema = z.object({
  status: z.enum(["PENDING", "APPROVED", "REJECTED"]).default("PENDING"),
});

/**
 * GET /clients/property-count-disputes — очередь для руководства.
 * По умолчанию только PENDING — это список дел, а не журнал.
 */
propertyCountDisputesRouter.get(
  "/property-count-disputes",
  requireAuth,
  requirePermission("clients.merge"),
  async (req, res) => {
    // Ночная проверка, №155: status из строки запроса — только из трёх значений заявки.
    const parsedQuery = disputeListQuerySchema.safeParse(req.query);
    if (!parsedQuery.success) {
      return res.status(400).json({ error: "Неверные данные", details: parsedQuery.error.flatten() });
    }
    const { status } = parsedQuery.data;

    const items = await prisma.propertyCountDispute.findMany({
      // Ночная проверка 24.09.2026: клиент, ушедший в Корзину после подачи
      // заявки, не должен вечно висеть в очереди руководителя — фильтруем по
      // живому клиенту, а не полагаемся на то, что заявку кто-то погасит сам.
      where: { status, client: { deletedAt: null } },
      orderBy: { createdAt: "desc" },
      take: 200,
      include: {
        requestedBy: { select: { id: true, fullName: true } },
        decidedBy: { select: { id: true, fullName: true } },
        client: {
          select: {
            id: true,
            shortId: true,
            fullName: true,
            phone: true,
            sellerDeclaredPropertyCount: true,
            buyerDesiredPropertyCount: true,
          },
        },
      },
    });

    const showPhone = can(req, "clients.viewPhone");
    res.json({
      items: items.map((r) => ({
        id: r.id,
        role: r.role,
        status: r.status,
        aiCount: r.aiCount,
        proposedCount: r.proposedCount,
        // Причина агента и заметка решения — свободный текст, номер клиента попадает
        // в них словами: закрыты тем же правом, что phone (ACCESS-01, аудит 04.10.2026).
        reason: phoneSafeText(r.reason, showPhone),
        createdAt: r.createdAt,
        decidedAt: r.decidedAt,
        decisionNote: phoneSafeText(r.decisionNote, showPhone),
        requestedBy: r.requestedBy,
        decidedBy: r.decidedBy,
        // Имя — тем же правом, что номер (A11, глубокая проверка 02.10.2026).
        client: showPhone ? r.client : { ...r.client, phone: maskPhone(r.client.phone), fullName: clientNamePhoneSafe(r.client.fullName, false) },
      })),
    });
  }
);

/**
 * GET /clients/:id/property-count-dispute — есть ли по карточке заявки,
 * ждущие решения (для кнопок «Оспорить» на самой карточке). Массив, а не
 * одна заявка: у dualIntent-клиента могут одновременно висеть заявка на
 * продавца и заявка на покупателя — они друг другу не мешают.
 */
propertyCountDisputesRouter.get("/:id/property-count-dispute", requireAuth, async (req, res) => {
  const client = await prisma.client.findUnique({
    where: { id: req.params.id },
    select: { id: true, assignedAgentId: true },
  });
  if (!client) return res.status(404).json({ error: "Клиент не найден" });
  if (client.assignedAgentId !== req.agent!.id && !can(req, "clients.viewAll")) {
    return res.status(403).json({ error: "Это чужая карточка" });
  }

  const pending = await prisma.propertyCountDispute.findMany({
    where: { clientId: client.id, status: "PENDING" },
    orderBy: { createdAt: "desc" },
    include: { requestedBy: { select: { id: true, fullName: true } } },
  });

  res.json({
    requests: pending.map((p) => ({
      id: p.id,
      role: p.role,
      status: p.status,
      aiCount: p.aiCount,
      proposedCount: p.proposedCount,
      reason: phoneSafeText(p.reason, can(req, "clients.viewPhone")),
      createdAt: p.createdAt,
      requestedBy: p.requestedBy,
    })),
  });
});

/**
 * POST /clients/:id/property-count-dispute — агент предлагает своё число по
 * указанной роли (SELLER/BUYER).
 *
 * Требует, чтобы у карточки уже было число от ИИ по ЭТОЙ роли (иначе спорить
 * не с чем), и чтобы по ней не висела другая PENDING-заявка ПО ТОЙ ЖЕ РОЛИ —
 * иначе очередь руководства зарастала бы повторами. Заявка по другой роли на
 * этого же клиента не блокирует.
 */
propertyCountDisputesRouter.post("/:id/property-count-dispute", requireAuth, async (req, res) => {
  const parsed = propertyCountDisputeSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: parsed.error.issues[0]?.message ?? "Неверные данные" });
  }
  const { role } = parsed.data;
  const field = FIELD_BY_ROLE[role];

  const client = await prisma.client.findUnique({
    where: { id: req.params.id },
    select: {
      id: true,
      shortId: true,
      fullName: true,
      assignedAgentId: true,
      deletedAt: true,
      sellerDeclaredPropertyCount: true,
      buyerDesiredPropertyCount: true,
    },
  });
  if (!client || client.deletedAt) return res.status(404).json({ error: "Клиент не найден" });
  if (client.assignedAgentId !== req.agent!.id && !can(req, "clients.viewAll")) {
    return res.status(403).json({ error: "Заявку заводит агент, который ведёт карточку" });
  }
  const aiCount = client[field.count];
  if (aiCount === null) {
    return res.status(409).json({ error: `У этой карточки ещё нет числа от ИИ на ${field.label} — оспаривать нечего` });
  }

  const existing = await prisma.propertyCountDispute.findFirst({
    where: { clientId: client.id, role, status: "PENDING" },
    select: { id: true },
  });
  if (existing) {
    return res.status(409).json({ error: "По этой стороне уже есть заявка — она ждёт решения руководства" });
  }

  const dispute = await prisma.propertyCountDispute.create({
    data: {
      clientId: client.id,
      requestedById: req.agent!.id,
      role,
      aiCount,
      proposedCount: parsed.data.proposedCount,
      reason: parsed.data.reason,
    },
  });

  logAudit(req, "PROPERTY_COUNT_DISPUTE", "Client", client.id, {
    disputeId: dispute.id,
    role,
    aiCount: dispute.aiCount,
    proposedCount: dispute.proposedCount,
    shortId: client.shortId,
    fullName: client.fullName,
  });

  // Часы алармов (владелец 07.09.2026): заявка уже в очереди на рассмотрение,
  // откладывается только пуш о ней.
  void enqueueDirectorAlert({
    title: "🔢 Заявка на пересмотр числа объектов",
    body: `${client.fullName} (${field.label}) — ИИ насчитал ${dispute.aiCount}, агент предлагает ${dispute.proposedCount}`,
    url: "/clients",
    kind: "oversight",
    // Первый уровень владельца: агент не может вести карточку, пока спор о
    // числе объектов не решён.
    level: "APPROVAL",
    tag: `property-count-dispute-${dispute.id}`,
    recipientPermission: "clients.merge",
  });

  publishRequestUpdated({
    requestId: dispute.id,
    clientId: dispute.clientId,
    agentIds: [req.agent!.id],
    stage: "PENDING",
    actorId: req.agent!.id,
  });

  res.status(201).json({
    ok: true,
    id: dispute.id,
    message: "Заявка отправлена — решает руководитель, число ИИ остаётся в силе до его решения",
  });
});

/** Заявка вместе с клиентом — общий пролог решений. */
async function loadPendingDispute(id: string) {
  return prisma.propertyCountDispute.findUnique({
    where: { id },
    include: {
      client: {
        // deletedAt — ночная проверка 24.09.2026: approve/reject обязаны знать,
        // что клиент уже в Корзине, а не молча править карточку оттуда.
        select: {
          id: true,
          shortId: true,
          fullName: true,
          deletedAt: true,
          sellerDeclaredPropertyCount: true,
          buyerDesiredPropertyCount: true,
        },
      },
    },
  });
}

/**
 * POST /clients/property-count-disputes/:id/approve — руководитель соглашается
 * с числом агента: поле карточки по role (sellerDeclaredPropertyCount или
 * buyerDesiredPropertyCount) заменяется на proposedCount. Отсчёт до аларма
 * (...At) начинается заново — решение человека, а не устаревшая точка отсчёта
 * от прежнего (возможно неверного) числа.
 */
propertyCountDisputesRouter.post(
  "/property-count-disputes/:id/approve",
  requireAuth,
  requirePermission("clients.merge"),
  async (req, res) => {
    const parsed = propertyCountDisputeApproveSchema.safeParse(req.body ?? {});
    if (!parsed.success) return res.status(400).json({ error: "Неверные данные" });

    const dispute = await loadPendingDispute(req.params.id);
    if (!dispute) return res.status(404).json({ error: "Заявка не найдена" });
    // Ночная проверка 24.09.2026: клиент мог уйти в Корзину уже после подачи
    // заявки — правкой из Корзины карточку лучше не трогать вовсе.
    if (dispute.client.deletedAt) {
      return res.status(404).json({ error: "Клиент удалён в Корзину — заявка больше не актуальна" });
    }
    if (dispute.status !== "PENDING") {
      return res.status(409).json({ error: "По этой заявке уже вынесено решение" });
    }

    const role = dispute.role as DisputeRole;
    const field = FIELD_BY_ROLE[role];

    await prisma.$transaction([
      prisma.client.update({
        where: { id: dispute.clientId },
        data: {
          [field.count]: dispute.proposedCount,
          [field.at]: new Date(),
        },
      }),
      prisma.propertyCountDispute.update({
        where: { id: dispute.id },
        data: {
          status: "APPROVED",
          decidedById: req.agent!.id,
          decidedAt: new Date(),
          decisionNote: parsed.data.decisionNote?.trim() || null,
        },
      }),
    ]);

    logAudit(req, "PROPERTY_COUNT_DISPUTE_APPROVE", "Client", dispute.clientId, {
      disputeId: dispute.id,
      role,
      proposedCount: dispute.proposedCount,
    });

    void sendPushToAgent(dispute.requestedById, {
      title: "🔢 Число объектов исправлено",
      body: `${dispute.client.fullName} (${field.label}) — принято ваше число (${dispute.proposedCount})${
        parsed.data.decisionNote?.trim() ? `. ${parsed.data.decisionNote.trim()}` : ""
      }`,
      url: "/clients",
      tag: `property-count-dispute-${dispute.id}`,
    });

    publishRequestUpdated({
      requestId: dispute.id,
      clientId: dispute.clientId,
      agentIds: [dispute.requestedById],
      stage: "APPROVED",
      actorId: req.agent!.id,
    });

    res.json({ ok: true, message: "Число исправлено, агенту отправлено уведомление" });
  }
);

/**
 * POST /clients/property-count-disputes/:id/reject — руководитель не согласен,
 * число ИИ остаётся в силе. Причина обязательна — см. clientDeleteRequestRejectSchema.
 */
propertyCountDisputesRouter.post(
  "/property-count-disputes/:id/reject",
  requireAuth,
  requirePermission("clients.merge"),
  async (req, res) => {
    const parsed = propertyCountDisputeRejectSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: parsed.error.issues[0]?.message ?? "Напишите, почему заявка отклонена" });
    }

    const dispute = await loadPendingDispute(req.params.id);
    if (!dispute) return res.status(404).json({ error: "Заявка не найдена" });
    // Ночная проверка 24.09.2026: та же причина, что у approve выше.
    if (dispute.client.deletedAt) {
      return res.status(404).json({ error: "Клиент удалён в Корзину — заявка больше не актуальна" });
    }
    if (dispute.status !== "PENDING") {
      return res.status(409).json({ error: "По этой заявке уже вынесено решение" });
    }

    const field = FIELD_BY_ROLE[dispute.role as DisputeRole];

    await prisma.propertyCountDispute.update({
      where: { id: dispute.id },
      data: {
        status: "REJECTED",
        decidedById: req.agent!.id,
        decidedAt: new Date(),
        decisionNote: parsed.data.decisionNote.trim(),
      },
    });

    logAudit(req, "PROPERTY_COUNT_DISPUTE_REJECT", "Client", dispute.clientId, { disputeId: dispute.id, role: dispute.role });

    void sendPushToAgent(dispute.requestedById, {
      title: "🔢 Заявка на пересмотр числа отклонена",
      body: `${dispute.client.fullName} (${field.label}) — остаётся число ИИ (${dispute.aiCount}). ${parsed.data.decisionNote.trim()}`,
      url: "/clients",
      tag: `property-count-dispute-${dispute.id}`,
    });

    publishRequestUpdated({
      requestId: dispute.id,
      clientId: dispute.clientId,
      agentIds: [dispute.requestedById],
      stage: "REJECTED",
      actorId: req.agent!.id,
    });

    res.json({ ok: true, message: "Заявка отклонена, агенту отправлено уведомление" });
  }
);
