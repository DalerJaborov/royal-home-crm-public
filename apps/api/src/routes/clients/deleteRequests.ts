import { investigationViewerRole } from "../../auth/investigations.js";
/**
 * ЗАЯВКИ АГЕНТА НА УДАЛЕНИЕ КЛИЕНТА (решение владельца 30.08.2026).
 *
 * Дословно: «дать агентам возможность направить клиента на удаление на моё
 * рассмотрение. И мне — возможность удалять клиента (добавлять в корзину): в
 * базе запрос нереальный или пустышка».
 *
 * Устройство повторяет уже работающую очередь службы безопасности
 * (routes/security.ts): сотрудник фиксирует повод, руководство выносит решение,
 * обе стороны узнают об этом уведомлением. Удаление НИКОГДА не происходит по
 * заявке само — только когда человек с правом `clients.delete` нажал «Одобрить».
 *
 * ⚠️ ПОРЯДОК РЕГИСТРАЦИИ: этот роутер обязан подключаться ДО cardRouter — у него
 * статичный путь `GET /delete-requests`, который иначе съест `GET /:id`
 * (см. комментарий в index.ts).
 */
import { Router } from "express";
import { publicClientProjection } from "../../lib/investigationPrivacy.js";
import {
  clientDeleteRequestApproveSchema,
  clientDeleteRequestRejectSchema,
  clientDeleteRequestSchema,
  DELETE_REQUEST_REASON_LABELS,
  DELETE_REQUEST_STATUSES,
  deleteReasonLabelsFor,
  type DeleteRequestReason,
} from "@royal-home/shared";
import { z } from "zod";
import { prisma } from "../../db.js";
import { can, requireAuth, requirePermission, scopeToOwnAgent } from "../../auth/middleware.js";
import { decideClientCardAccess } from "../../lib/clientCardAccess.js";
import { logAudit } from "../../lib/audit.js";
import { maskPhone } from "./shared.js";
import { clientNamePhoneSafe, phoneSafeText } from "../../lib/clientPhone.js";
import { enqueueDirectorAlert } from "../../lib/directorAlertQueue.js";
import { fileClientDeleteRequest } from "../../lib/clientDeleteRequest.js";
import { approveClientDeleteRequest, rejectClientDeleteRequest } from "../../lib/managerRequestDecisions.js";

export const deleteRequestsRouter = Router();

const listQuerySchema = z.object({
  status: z.enum(DELETE_REQUEST_STATUSES).optional(),
});

/** Подпись причины для чтения в очереди — с учётом типа карточки (у продавца и
 *  покупателя формулировки разные, см. schemas.ts). */
function reasonLabel(reason: string, kind: string | null | undefined): string {
  const labels = deleteReasonLabelsFor((kind as "BUYER" | "SELLER" | "OTHER" | undefined) ?? undefined);
  return labels[reason as DeleteRequestReason] ?? DELETE_REQUEST_REASON_LABELS[reason as DeleteRequestReason] ?? reason;
}

/**
 * GET /clients/delete-requests — очередь для руководства.
 *
 * По умолчанию только PENDING: экран «Заявки на удаление» в Архиве — это список
 * дел, а не журнал (решённые видны в Корзине и в истории действий). Предел
 * выборки обязателен по стандарту проекта: заявки копятся, а листать их никто не
 * будет — 200 самых свежих закрывают любую реальную очередь.
 */
deleteRequestsRouter.get(
  "/delete-requests",
  requireAuth,
  requirePermission("clients.delete"),
  async (req, res) => {
    const parsed = listQuerySchema.safeParse(req.query);
    if (!parsed.success) return res.status(400).json({ error: "Неверный запрос" });
    const status = parsed.data.status ?? "PENDING";

    const items = await prisma.clientDeleteRequest.findMany({
      where: { status },
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
            kind: true,
            status: true,
            deletedAt: true,
            assignedAgent: { select: { id: true, fullName: true } },
            // Подсказка руководителю (владелец 07.09.2026, разбор алармов):
            // если агент недавно спрашивал у этого клиента номер телефона, а
            // теперь просит его удалить — это ровно комбинация, из-за которой
            // завели весь lib/agentOffCrmAlarm.ts. Решение по заявке всё равно
            // за человеком, это только видимый факт, не блокировка.
            phoneAskFlaggedAt: true,
          },
        },
      },
    });

    const showPhone = can(req, "clients.viewPhone");
    res.json({
      items: items.map((r) => ({
        id: r.id,
        status: r.status,
        reason: r.reason,
        reasonLabel: reasonLabel(r.reason, r.client.kind),
        // Комментарий, расшифровка голосовой заметки и заметка решения — свободный
        // текст, куда номер клиента попадает словами; имя карточки несёт его само
        // («Входящий +992…»). Всё это закрыто тем же правом, что поле phone
        // (аудит Codex 04.10.2026, ACCESS-01).
        comment: phoneSafeText(r.comment, showPhone),
        commentVoiceUrl: r.commentVoiceUrl,
        commentVoiceTranscript: phoneSafeText(r.commentVoiceTranscript, showPhone),
        createdAt: r.createdAt,
        decidedAt: r.decidedAt,
        decisionNote: phoneSafeText(r.decisionNote, showPhone),
        requestedBy: r.requestedBy,
        decidedBy: r.decidedBy,
        client: {
          ...publicClientProjection(r.client, investigationViewerRole(req)),
          fullName: clientNamePhoneSafe(r.client.fullName, showPhone),
          phone: showPhone ? r.client.phone : maskPhone(r.client.phone),
        },
      })),
    });
  }
);

/**
 * GET /clients/:id/delete-request — есть ли по карточке заявка, ждущая решения.
 *
 * Нужен самой карточке: кнопку «Направить на удаление» нельзя ни гасить в серый,
 * ни показывать как ни в чём не бывало — вместо неё встаёт видимая строка «заявка
 * отправлена, ждёт решения» (правило проекта: причина недоступности — текстом
 * рядом, а не подсказкой при наведении). Отдельным запросом, а не полем карточки:
 * presentClient — общий ответ на десяток экранов, и тащить туда поле ради одной
 * кнопки значило бы утяжелить их все.
 */
deleteRequestsRouter.get("/:id/delete-request", requireAuth, async (req, res) => {
  const client = await prisma.client.findUnique({
    where: { id: req.params.id },
    select: { id: true, assignedAgentId: true, kind: true },
  });
  if (!client) return res.status(404).json({ error: "Клиент не найден" });
  if (client.assignedAgentId !== req.agent!.id && !can(req, "clients.viewAll")) {
    return res.status(403).json({ error: "Это чужая карточка" });
  }

  const pending = await prisma.clientDeleteRequest.findFirst({
    where: { clientId: client.id, status: "PENDING" },
    orderBy: { createdAt: "desc" },
    include: { requestedBy: { select: { id: true, fullName: true } } },
  });

  res.json({
    request: pending
      ? {
          id: pending.id,
          status: pending.status,
          reason: pending.reason,
          reasonLabel: reasonLabel(pending.reason, client.kind),
          comment: phoneSafeText(pending.comment, can(req, "clients.viewPhone")),
          commentVoiceUrl: pending.commentVoiceUrl,
          commentVoiceTranscript: phoneSafeText(pending.commentVoiceTranscript, can(req, "clients.viewPhone")),
          createdAt: pending.createdAt,
          requestedBy: pending.requestedBy,
        }
      : null,
  });
});

/**
 * POST /clients/:id/delete-request — агент просит удалить карточку.
 *
 * Карточку агент обязан вести сам (или иметь право видеть чужие — руководство
 * тоже может завести заявку, например разбирая базу вместе с агентом). Вторая
 * заявка по тому же клиенту не заводится: очередь руководства не должна
 * наполняться повторами одного и того же повода.
 */
deleteRequestsRouter.post(
  "/:id/delete-request",
  requireAuth,
  requirePermission("clients.requestDelete"),
  async (req, res) => {
    const parsed = clientDeleteRequestSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: parsed.error.issues[0]?.message ?? "Неверные данные" });
    }

    const client = await prisma.client.findUnique({
      where: { id: req.params.id },
      select: { id: true, shortId: true, fullName: true, kind: true, assignedAgentId: true, deletedAt: true },
    });
    if (!client || client.deletedAt) return res.status(404).json({ error: "Клиент не найден" });
    if (client.assignedAgentId !== req.agent!.id && !can(req, "clients.viewAll")) {
      return res.status(403).json({ error: "Заявку заводит агент, который ведёт карточку" });
    }

    const existing = await prisma.clientDeleteRequest.findFirst({
      where: { clientId: client.id, status: "PENDING" },
      select: { id: true, createdAt: true },
    });
    if (existing) {
      return res.status(409).json({ error: "По этому клиенту уже есть заявка — она ждёт решения руководства" });
    }

    // Одна дверь (lib/clientDeleteRequest.ts): ей же пользуются отказ и
    // исчерпанные передачи, когда работа по клиенту закончилась.
    const filed = await fileClientDeleteRequest({
      clientId: client.id,
      requestedById: req.agent!.id,
      reason: parsed.data.reason,
      comment: parsed.data.comment,
      voiceNoteUrl: parsed.data.voiceNoteUrl,
      voiceNoteTranscript: parsed.data.voiceNoteTranscript,
    });
    if (!filed.ok) return res.status(404).json({ error: filed.error });
    if (!filed.created) {
      return res.status(409).json({ error: "По этому клиенту уже есть заявка — она ждёт решения руководства" });
    }

    logAudit(req, "DELETE_REQUEST", "Client", client.id, {
      requestId: filed.id,
      reason: parsed.data.reason,
      shortId: client.shortId,
      fullName: client.fullName,
    });

    res.status(201).json({
      ok: true,
      id: filed.id,
      message: "Заявка отправлена — карточку удалит директор или админ, если согласится",
    });
  }
);

/**
 * POST /clients/delete-requests/:id/approve — руководство соглашается.
 *
 * Тело решения — lib/managerRequestDecisions.ts (17.11.2026): тем же путём одобряет
 * и Шабнам в режиме директора. Удаление идёт общей функцией trashClient — тем же
 * путём, что прямое DELETE /clients/:id; решение берётся атомарно ДО удаления.
 */
deleteRequestsRouter.post(
  "/delete-requests/:id/approve",
  requireAuth,
  requirePermission("clients.delete"),
  async (req, res) => {
    const parsed = clientDeleteRequestApproveSchema.safeParse(req.body ?? {});
    if (!parsed.success) return res.status(400).json({ error: "Неверные данные" });

    const outcome = await approveClientDeleteRequest({
      requestId: req.params.id,
      actorId: req.agent!.id,
      decisionNote: parsed.data.decisionNote?.trim() || null,
    });
    if (!outcome.ok) return res.status(outcome.status).json({ error: outcome.error });
    res.json({ ok: true, message: outcome.message });
  }
);

/**
 * POST /clients/delete-requests/:id/reject — руководство отказывает.
 *
 * Причина ОБЯЗАТЕЛЬНА (проверяется схемой): «отклонено» без объяснения агенту
 * ничего не говорит — он либо заведёт такую же заявку завтра, либо перестанет
 * заводить их вовсе, и база снова зарастёт пустышками. Тело — lib/managerRequestDecisions.ts.
 */
deleteRequestsRouter.post(
  "/delete-requests/:id/reject",
  requireAuth,
  requirePermission("clients.delete"),
  async (req, res) => {
    const parsed = clientDeleteRequestRejectSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: parsed.error.issues[0]?.message ?? "Напишите, почему заявка отклонена" });
    }

    const outcome = await rejectClientDeleteRequest({
      requestId: req.params.id,
      actorId: req.agent!.id,
      decisionNote: parsed.data.decisionNote,
    });
    if (!outcome.ok) return res.status(outcome.status).json({ error: outcome.error });
    res.json({ ok: true, message: outcome.message });
  }
);

/**
 * POST /clients/:id/request-restore — агент просит вернуть карточку из Корзины
 * (18.09.2026, задание В §f п.1: «зеркало clients.requestDelete»).
 *
 * УПРОЩЕНИЕ ПРОТИВ ПОЛНОГО ЗЕРКАЛА (сознательно, из-за объёма задания): у заявки
 * на удаление есть своя таблица и очередь `PENDING/APPROVED/REJECTED` — здесь
 * этого нет, только уведомление тем, у кого есть `clients.delete`, тем же
 * каналом (`enqueueDirectorAlert`), что и заявка на удаление. Держателю только
 * видна кнопка «Попросить восстановить» в «Все мои» (нет `clients.delete` —
 * восстановить сам не может), а не статус «заявка ждёт решения». Полноценная
 * очередь с историей решений — отдельная задача, если понадобится журнал.
 *
 * Заводит не только текущий держатель: карточка в Корзине могла принадлежать
 * ему и ДО удаления (assignedAgentId у trashClient не гасится) — той же
 * проверкой, что у «Все мои» (assignedAgentId ИЛИ lastAgentId).
 */
deleteRequestsRouter.post("/:id/request-restore", requireAuth, async (req, res) => {
  const client = await prisma.client.findUnique({
    where: { id: req.params.id },
    select: { id: true, shortId: true, fullName: true, kind: true, deletedAt: true, assignedAgentId: true, lastAgentId: true },
  });
  if (!client || !client.deletedAt) return res.status(404).json({ error: "Карточка не найдена в Корзине" });
  // Держатель (текущий или прежний) или тот, кто видит всех, — решает та же
  // дверь, что у карточки (lib/clientCardAccess.ts); просьба данных не отдаёт.
  if (decideClientCardAccess(scopeToOwnAgent(req), { ...client, acceptedAt: null }, false) === "denied") {
    return res.status(403).json({ error: "Попросить восстановить может только тот, кто вёл эту карточку" });
  }

  /**
   * ОДНА ПРОСЬБА НА ОДНО ПОПАДАНИЕ В КОРЗИНУ (глубокая проверка 02.10.2026, A10).
   * Тег собирался с Date.now(), и каждое нажатие ставило директорам новый аларм
   * «на решение» — десять нажатий давали десять уведомлений у каждого. Теперь
   * тег постоянный (пуш на устройстве заменяется, а не копится), а повторная
   * просьба по той же отправке в Корзину очередь не трогает.
   */
  const tag = `restore-request-${client.id}`;
  const already = await prisma.pendingDirectorAlert.findFirst({
    where: { tag, createdAt: { gte: client.deletedAt } },
    select: { id: true },
  });
  if (already) {
    return res.json({ ok: true, message: "Просьба уже отправлена — директор или админ её видит" });
  }

  const author = await prisma.agent.findUnique({ where: { id: req.agent!.id }, select: { fullName: true } });
  await enqueueDirectorAlert({
    title: "♻️ Просьба восстановить карточку",
    body: `${author?.fullName ?? "Агент"}: ${client.fullName} — из Корзины`,
    url: "/clients",
    kind: "oversight",
    level: "APPROVAL",
    tag,
    recipientPermission: "clients.delete",
  });

  res.json({ ok: true, message: "Просьба отправлена — карточку восстановит директор или админ, если согласится" });
});
