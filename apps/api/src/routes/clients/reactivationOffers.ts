/**
 * РЕАКТИВАЦИЯ К ПРЕЖНЕМУ АГЕНТУ — ПРИНЯТЬ/ОТКЛОНИТЬ (разбор 31.08.2026, п.12).
 *
 * Клиент, ушедший в Неактивные или в Корзину, написал снова — services/leads/intake.ts
 * (resumeExistingChannelLead) не назначает его прежнему агенту молча, а ставит
 * Client.reactivationOfferedToAgentId/At: карточка «предложена» и ждёт решения ТОГО
 * ЖЕ агента, который вёл её раньше (владелец: полный флоу с этим он когда-то отложил
 * «ещё продумываем», теперь вернулся к решению строить).
 *
 * Устройство — НЕ копия ClientDeleteRequest (routes/clients/deleteRequests.ts):
 * там решение выносит РУКОВОДСТВО по чужой заявке, здесь решает СОБСТВЕННИК
 * предложения — сам агент, поэтому отдельная таблица избыточна, состояние лежит
 * прямо на карточке двумя полями (тот же приём, что у acceptedAt/escalatedAt).
 *
 * ⚠️ ПОРЯДОК РЕГИСТРАЦИИ: статичный GET /reactivation-offers обязан матчиться ДО
 * GET /:id (card.ts) — тот же приём, что у /delete-requests (см. index.ts).
 */
import { Router } from "express";
import { prisma } from "../../db.js";
import { requireAuth } from "../../auth/middleware.js";
import { logAudit } from "../../lib/audit.js";
import { maskPhone } from "./shared.js";
import { clientNamePhoneSafe, maskPhonesInFreeText } from "../../lib/clientPhone.js";
import { acceptReactivationOffer, loadOwnOffer, releaseReactivationOffer } from "../../lib/reactivationOffers.js";

export const reactivationOffersRouter = Router();

/**
 * GET /clients/reactivation-offers — «мои» предложения, ждущие решения.
 *
 * Только СВОИ (reactivationOfferedToAgentId = я): предложение — не общая очередь,
 * решает конкретно тот, кому оно адресовано, руководитель тут ни при чём (в
 * отличие от delete-requests). Предел выборки — стандарт проекта для любого роута,
 * возвращающего массив.
 */
reactivationOffersRouter.get("/reactivation-offers", requireAuth, async (req, res) => {
  const items = await prisma.client.findMany({
    where: { reactivationOfferedToAgentId: req.agent!.id, deletedAt: null },
    orderBy: { reactivationOfferedAt: "desc" },
    take: 100,
    select: {
      id: true,
      shortId: true,
      fullName: true,
      phone: true,
      kind: true,
      reactivationOfferedAt: true,
      requirementsNotes: true,
    },
  });
  res.json({
    // До принятия карточка не отдаёт контакты (находка №158): поле phone — маска,
    // а свободный текст пожеланий и имя тоже могут нести номер — закрываем и их,
    // безусловно, как phone (права clients.viewPhone здесь не спрашиваем: карточка
    // ещё не принята, решать «брать или нет» агент должен без номера).
    items: items.map((c) => ({
      ...c,
      phone: maskPhone(c.phone),
      fullName: clientNamePhoneSafe(c.fullName, false),
      requirementsNotes: c.requirementsNotes === null ? null : maskPhonesInFreeText(c.requirementsNotes),
    })),
  });
});

/**
 * POST /clients/:id/reactivation-offer/accept — агент забирает клиента себе.
 * Логика (transaction + контроль портфеля) — acceptReactivationOffer
 * (lib/reactivationOffers.ts), общая с авто-принятием по факту звонка в кроне.
 */
reactivationOffersRouter.post("/:id/reactivation-offer/accept", requireAuth, async (req, res) => {
  const outcome = await acceptReactivationOffer(req.params.id, req.agent!.id);
  if (!outcome.ok) return res.status(outcome.status).json({ error: outcome.error });

  logAudit(req, "REACTIVATION_ACCEPT", "Client", outcome.client.id, {
    shortId: outcome.client.shortId,
    fullName: outcome.client.fullName,
  });

  res.json({ ok: true, message: "Клиент снова у вас в работе" });
});

/**
 * POST /clients/:id/reactivation-offer/decline — агент отказывается, карточка
 * уходит в обычную раздачу по очереди. Снятие (transaction/уведомления) —
 * releaseReactivationOffer, общая с TTL-кроном и снятием при заморозке/увольнении
 * (lib/reactivationOffers.ts) — раньше эта логика жила только здесь.
 */
reactivationOffersRouter.post("/:id/reactivation-offer/decline", requireAuth, async (req, res) => {
  const outcome = await loadOwnOffer(req.params.id, req.agent!.id);
  if (!outcome.ok) return res.status(outcome.status).json({ error: outcome.error });
  const { client } = outcome;

  const { nextAgentId } = await releaseReactivationOffer(client, req.agent!.id, "declined");

  logAudit(req, "REACTIVATION_DECLINE", "Client", client.id, {
    shortId: client.shortId,
    fullName: client.fullName,
    reassignedTo: nextAgentId,
  });

  res.json({ ok: true, message: nextAgentId ? "Клиент передан другому агенту" : "Клиент ждёт ручного назначения" });
});
