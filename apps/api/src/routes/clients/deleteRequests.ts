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
import { can, requireAuth, requirePermission } from "../../auth/middleware.js";
import { logAudit } from "../../lib/audit.js";
import { findAgentsWithPermission } from "../../lib/recipients.js";
import { sendPushToAgent, closeLeadPushNotifications } from "../../push.js";
import { trashClient } from "../../lib/trashClient.js";
import { maskPhone } from "./shared.js";
import { clientNamePhoneSafe, phoneSafeText } from "../../lib/clientPhone.js";
import { enqueueDirectorAlert } from "../../lib/directorAlertQueue.js";

import { publishRequestUpdated } from "../../lib/livePublish.js";

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

    const request = await prisma.clientDeleteRequest.create({
      data: {
        clientId: client.id,
        requestedById: req.agent!.id,
        reason: parsed.data.reason,
        comment: parsed.data.comment?.trim() || null,
        commentVoiceUrl: parsed.data.voiceNoteUrl ?? null,
        commentVoiceTranscript: parsed.data.voiceNoteTranscript ?? null,
      },
    });

    logAudit(req, "DELETE_REQUEST", "Client", client.id, {
      requestId: request.id,
      reason: parsed.data.reason,
      shortId: client.shortId,
      fullName: client.fullName,
    });

    // Кому решать — тем и сообщаем, по праву, а не по роли (lib/recipients.ts).
    // Часы алармов (владелец 07.09.2026): заявка уже в очереди Архива, ждёт
    // решения в любом случае — откладывается только пуш о ней.
    const author = await prisma.agent.findUnique({ where: { id: req.agent!.id }, select: { fullName: true } });
    void enqueueDirectorAlert({
      title: "🗑️ Заявка на удаление клиента",
      body: `${author?.fullName ?? "Агент"}: ${client.fullName} — ${reasonLabel(parsed.data.reason, client.kind)}`,
      url: "/archive",
      kind: "oversight",
      // Первый уровень владельца: пока заявка не решена, агент стоит и ждёт
      // (см. NOTIFICATION_LEVELS в @royal-home/shared).
      level: "APPROVAL",
      tag: `delete-request-${request.id}`,
      recipientPermission: "clients.delete",
    });

    publishRequestUpdated({
      requestId: request.id,
      clientId: client.id,
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

/** Заявка вместе с клиентом — общий пролог решений. */
async function loadPendingRequest(id: string) {
  return prisma.clientDeleteRequest.findUnique({
    where: { id },
    include: {
      client: { select: { id: true, shortId: true, fullName: true, kind: true, deletedAt: true } },
    },
  });
}

/**
 * Заявку решил один из тех, у кого есть `clients.delete` — у ОСТАЛЬНЫХ
 * согласующих «🗑️ Заявка на удаление» по ней без этого висела бы в шторке
 * вечно (найдено 07.09.2026, тот же класс, что и `lead-escalated-*`: рассылка
 * всем согласующим сразу, закрытие — только заявителю через замену того же
 * тега). Кража тут невозможна — оба маршрута защищены 409-гейтом по
 * `status !== "PENDING"` — это чистка мусорного уведомления.
 */
export async function closeDeleteRequestForOtherReviewers(requestId: string): Promise<void> {
  const recipients = await findAgentsWithPermission("clients.delete");
  await closeLeadPushNotifications(recipients.map((id) => ({ agentId: id, tag: `delete-request-${requestId}` })));
}

/**
 * POST /clients/delete-requests/:id/approve — руководство соглашается.
 *
 * Удаление идёт ровно тем же путём, что прямое DELETE /clients/:id — общей
 * функцией trashClient (проверка активной сделки, deletedAt, гашение требований
 * и просьб о звонке). Своя копия этой логики здесь однажды забыла бы погасить
 * требования, и по удалённому клиенту снова всплывали бы окна (баг 27.08.2026).
 */
deleteRequestsRouter.post(
  "/delete-requests/:id/approve",
  requireAuth,
  requirePermission("clients.delete"),
  async (req, res) => {
    const parsed = clientDeleteRequestApproveSchema.safeParse(req.body ?? {});
    if (!parsed.success) return res.status(400).json({ error: "Неверные данные" });

    const request = await loadPendingRequest(req.params.id);
    if (!request) return res.status(404).json({ error: "Заявка не найдена" });
    if (request.status !== "PENDING") {
      return res.status(409).json({ error: "По этой заявке уже вынесено решение" });
    }

    /**
     * КАРТОЧКА УЖЕ В КОРЗИНЕ — ЗАЯВКА ИСПОЛНЕНА, А НЕ СЛОМАНА (07.09.2026).
     *
     * Живой случай: агент отправил Продавца №0127 на удаление, админ к этому
     * моменту удалил карточку сам. trashClient честно отвечал 404 «Клиент не
     * найден», заявка оставалась PENDING и висела в Корзине красной строкой,
     * которую нечем было разобрать: «Удалить в корзину» упиралась в тот же отказ,
     * «Отклонить» соврала бы агенту — он просил удалить, и карточка удалена.
     *
     * Новые такие заявки закрывает сам trashClient (см. его конец), это ветка для
     * уже повисших. Проверяем deletedAt, а не текст ошибки: 404 у trashClient
     * означает и «нет вовсе», и «уже в Корзине», а это разные исходы.
     */
    const alreadyTrashed = !!request.client.deletedAt;

    /**
     * РЕШЕНИЕ БЕРЁТСЯ АТОМАРНО, ДО УДАЛЕНИЯ (аудит 04.10.2026, CRM-06). Раньше заявка
     * читалась как PENDING, карточка уходила в Корзину (необратимо), и только потом шла
     * безусловная запись «APPROVED»: параллельный «отклонить» давал клиента в Корзине
     * при заявке REJECTED. Теперь заявку занимает условный переход PENDING → APPROVED;
     * проигравший получает 409 и ничего не удаляет. Отказ trashClient (активная сделка
     * и т. п.) возвращает заявку в PENDING: она остаётся на столе руководства.
     */
    const claimed = await prisma.clientDeleteRequest.updateMany({
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
      prisma.clientDeleteRequest.updateMany({
        where: { id: request.id, status: "APPROVED", decidedById: req.agent!.id },
        data: { status: "PENDING", decidedById: null, decidedAt: null, decisionNote: null },
      });

    let result: Awaited<ReturnType<typeof trashClient>> | null = null;
    if (!alreadyTrashed) {
      try {
        result = await trashClient(request.clientId, req.agent!.id);
      } catch (err) {
        await releaseClaim().catch(() => undefined);
        throw err;
      }
      if (!result.ok) {
        // Заявку НЕ закрываем: активная сделка — временное препятствие, руководство
        // вернётся к ней после отмены сделки, и заводить заявку заново незачем.
        await releaseClaim();
        return res.status(result.status).json({ error: result.error });
      }
    }

    // Записи об удалении нет, когда удалять было уже нечего: карточка уехала в
    // Корзину раньше и своей записью в журнале уже отмечена.
    if (result?.ok) {
      logAudit(req, "TRASH", "Client", result.client.id, {
        shortId: result.client.shortId,
        fullName: result.client.fullName,
        phone: result.client.phone,
        kind: result.client.kind,
        deleteRequestId: request.id,
      });
    }

    // Пуш «удалено по вашей заявке» убран (владелец 17.09.2026): карточка уже
    // пропала у агента из списка в момент подачи заявки (см. routes/clients/list.ts) —
    // уведомление об одобрении сообщало бы о том, что он не видит и так, лишнее.
    // Отклонение — другое дело, там push остаётся: карточка возвращается в
    // список, и без объяснения агент не поймёт, почему.
    void closeDeleteRequestForOtherReviewers(request.id).catch((err) =>
      console.error("[push] закрытие заявки на удаление у остальных согласующих:", err)
    );

    publishRequestUpdated({
      requestId: request.id,
      clientId: request.clientId,
      agentIds: [request.requestedById],
      stage: "APPROVED",
      actorId: req.agent!.id,
    });

    res.json({
      ok: true,
      message: alreadyTrashed
        ? "Карточка уже была в Корзине — заявка закрыта, агенту отправлено уведомление"
        : "Клиент удалён в Корзину, агенту отправлено уведомление",
    });
  }
);

/**
 * POST /clients/delete-requests/:id/reject — руководство отказывает.
 *
 * Причина ОБЯЗАТЕЛЬНА (проверяется схемой): «отклонено» без объяснения агенту
 * ничего не говорит — он либо заведёт такую же заявку завтра, либо перестанет
 * заводить их вовсе, и база снова зарастёт пустышками.
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

    const request = await loadPendingRequest(req.params.id);
    if (!request) return res.status(404).json({ error: "Заявка не найдена" });
    if (request.status !== "PENDING") {
      return res.status(409).json({ error: "По этой заявке уже вынесено решение" });
    }

    // Условный переход PENDING → REJECTED (CRM-06): параллельное «одобрить» уже могло
    // удалить карточку и закрыть заявку, безусловная запись переписала бы его решение.
    const decided = await prisma.clientDeleteRequest.updateMany({
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

    logAudit(req, "DELETE_REQUEST_REJECT", "Client", request.clientId, {
      requestId: request.id,
      shortId: request.client.shortId,
      fullName: request.client.fullName,
      decisionNote: parsed.data.decisionNote,
    });

    void sendPushToAgent(request.requestedById, {
      title: "Заявка на удаление отклонена",
      body: `${request.client.fullName}: ${parsed.data.decisionNote}`,
      url: `/clients/${request.client.shortId}`,
      tag: `delete-request-${request.id}`,
    });
    void closeDeleteRequestForOtherReviewers(request.id).catch((err) =>
      console.error("[push] закрытие заявки на удаление у остальных согласующих:", err)
    );

    publishRequestUpdated({
      requestId: request.id,
      clientId: request.clientId,
      agentIds: [request.requestedById],
      stage: "REJECTED",
      actorId: req.agent!.id,
    });

    res.json({ ok: true, message: "Заявка отклонена, агенту отправлено объяснение" });
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
  const isHolder = client.assignedAgentId === req.agent!.id || client.lastAgentId === req.agent!.id;
  if (!isHolder && !can(req, "clients.viewAll")) {
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
