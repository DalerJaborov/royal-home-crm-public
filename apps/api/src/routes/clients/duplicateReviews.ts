/**
 * ПРОВЕРКА НА ДУБЛЬ ПРИ РАЗДАЧЕ — ПОДТВЕРДИТЬ/ОТКЛОНИТЬ (раздел L, 03.09.2026, план
 * вечерней сессии §L). Устройство — сознательный слепок routes/clients/reactivationOffers.ts:
 * там агент решает за СВОЁ предложение, здесь — за СВОЙ вопрос «это ваш клиент?»,
 * оба состояния лежат прямо на карточке (см. схему), решает адресат.
 *
 * ⚠️ ПОРЯДОК РЕГИСТРАЦИИ: статичные GET/POST здесь обязаны матчиться ДО GET /:id
 * (card.ts) — тот же приём, что у /reactivation-offers и /duplicates (см. index.ts).
 */
import { Router } from "express";
import { prisma } from "../../db.js";
import { can, requireAuth } from "../../auth/middleware.js";
import { logAudit } from "../../lib/audit.js";
import { confirmDuplicateReview, denyDuplicateReview } from "../../lib/duplicateReview.js";
import { assignHeldLead } from "../../services/leads/intake.js";
import { ClientMergeOpenDealError, ClientMergeTrashedError } from "../../lib/clientMerge.js";
import { maskPhone, presentClient } from "./shared.js";
import { clientNamePhoneSafe } from "../../lib/clientPhone.js";

export const duplicateReviewsRouter = Router();

/**
 * GET /clients/duplicate-reviews — «на слияние».
 *
 * Без ?all — «мои»: заявки, по которым СПРОСИЛИ именно этого агента (тот же
 * принцип, что у GET /reactivation-offers: решает адресат, не общая очередь).
 * ?all=1 + право clients.merge — видимый раздел для руководителя (владелец
 * просил именно так: «отдельный видимый раздел на слияние», см. план §L
 * уровень 4) — ВСЕ пары, ещё ждущие ответа, по всей компании.
 */
duplicateReviewsRouter.get("/duplicate-reviews", requireAuth, async (req, res) => {
  const wantsAll = req.query.all === "1";
  if (wantsAll && !can(req, "clients.merge")) {
    return res.status(403).json({ error: "Нет права видеть все пары — только свои (без ?all)" });
  }
  const where = wantsAll ? { duplicateReviewOfClientId: { not: null } } : { duplicateReviewAskedAgentId: req.agent!.id };

  const items = await prisma.client.findMany({
    where: { ...where, deletedAt: null },
    orderBy: { duplicateReviewAskedAt: "desc" },
    take: 100,
    select: {
      id: true,
      shortId: true,
      fullName: true,
      phone: true,
      kind: true,
      duplicateReviewAskedAt: true,
      duplicateReviewDueAt: true,
      duplicateReviewMatchedBy: true,
      duplicateReviewOfClient: {
        select: { id: true, shortId: true, fullName: true, phone: true, assignedAgent: { select: { fullName: true } } },
      },
    },
  });

  const canSeePhone = can(req, "clients.viewPhone");
  res.json({
    items: items.map((c) => ({
      ...c,
      // Имя — тем же правом, что номер: у карточек незнакомых звонивших номер лежит
      // в самом имени («Входящий +992…», аудит Codex 04.10.2026, ACCESS-01).
      fullName: clientNamePhoneSafe(c.fullName, canSeePhone),
      phone: canSeePhone ? c.phone : maskPhone(c.phone),
      duplicateReviewOfClient: c.duplicateReviewOfClient && {
        ...c.duplicateReviewOfClient,
        fullName: clientNamePhoneSafe(c.duplicateReviewOfClient.fullName, canSeePhone),
        phone: canSeePhone ? c.duplicateReviewOfClient.phone : maskPhone(c.duplicateReviewOfClient.phone),
      },
    })),
  });
});

/** Проверка вместе с гарантией, что решает адресат (либо руководитель — override). */
async function loadOwnReview(clientId: string, agentId: string, allowOverride: boolean) {
  const client = await prisma.client.findUnique({ where: { id: clientId } });
  if (!client || client.deletedAt) return { ok: false as const, status: 404 as const, error: "Клиент не найден" };
  if (!client.duplicateReviewOfClientId || !client.duplicateReviewAskedAgentId) {
    return { ok: false as const, status: 409 as const, error: "По этой карточке нет открытой проверки на дубль" };
  }
  if (client.duplicateReviewAskedAgentId !== agentId && !allowOverride) {
    return { ok: false as const, status: 403 as const, error: "Этот вопрос адресован другому агенту" };
  }
  return { ok: true as const, client };
}

/**
 * POST /clients/:id/duplicate-review/confirm — «да, мой клиент»: карточки
 * сливаются (см. lib/clientMerge.ts), придержанная раздача НЕ продолжается —
 * склейка НЕ считается новым принятым лидом (владелец, явное условие §L).
 */
duplicateReviewsRouter.post("/:id/duplicate-review/confirm", requireAuth, async (req, res) => {
  const outcome = await loadOwnReview(req.params.id, req.agent!.id, can(req, "clients.merge"));
  if (!outcome.ok) return res.status(outcome.status).json({ error: outcome.error });

  let merged;
  try {
    merged = await confirmDuplicateReview(req.params.id, req.agent!.id);
  } catch (err) {
    // Карточку, к которой стоит проверка, отправили в Корзину (B2, 02.10.2026):
    // склейка увела бы живую заявку в Корзину вслед за ней.
    if (err instanceof ClientMergeTrashedError) return res.status(409).json({ error: err.message });
    // У дубля идёт сделка у другого агента — склейка ждёт её закрытия (решение владельца 02.10.2026).
    if (err instanceof ClientMergeOpenDealError) return res.status(409).json({ error: err.message });
    throw err;
  }
  if (!merged) return res.status(404).json({ error: "Клиент не найден (гонка с удалением)" });

  logAudit(req, "DUPLICATE_REVIEW_CONFIRM", "Client", merged.id, { pendingClientId: req.params.id });
  res.json({ ok: true, message: "Карточки объединены", client: presentClient(merged, can(req, "clients.viewPhone"), can(req, "clients.viewOrigin"), req.agent?.role) });
});

/**
 * POST /clients/:id/duplicate-review/deny — «нет, разные люди»: придержка
 * снимается, лид уходит в обычную раздачу по очереди (services/leads/intake.ts::assignHeldLead).
 */
duplicateReviewsRouter.post("/:id/duplicate-review/deny", requireAuth, async (req, res) => {
  const outcome = await loadOwnReview(req.params.id, req.agent!.id, can(req, "clients.merge"));
  if (!outcome.ok) return res.status(outcome.status).json({ error: outcome.error });

  await denyDuplicateReview(req.params.id, req.agent!.id);
  await assignHeldLead(req.params.id);

  logAudit(req, "DUPLICATE_REVIEW_DENY", "Client", req.params.id, {});
  res.json({ ok: true, message: "Отмечено: разные люди — заявка передана в обычную раздачу" });
});
