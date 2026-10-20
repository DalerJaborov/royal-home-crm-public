import { Router } from "express";
import { z } from "zod";
import { can, requireAuth, scopeDealsToOwnAgent } from "../auth/middleware.js";
import { logAudit } from "../lib/audit.js";
import { annulDeal, DealAnnulError } from "../lib/dealAnnul.js";
import { publishDealUpdated } from "../lib/livePublish.js";
import { sendPushToAgent } from "../push.js";

/**
 * POST /deals/:id/annul — «Аннулировать» закрытую сделку (глубокая проверка
 * 02.10.2026, C10). Правило и последствия — lib/dealAnnul.ts.
 *
 * Право — deals.complete, то же, что одобряет закрытие и возвращает отменённую
 * сделку в работу (routes/deals.ts, canCompleteDeal): аннулирование — обратная
 * сторона того же денежного решения руководства. Причина обязательна — она
 * уходит в хронологию клиента, журнал действий и пуш агенту.
 */
export const dealAnnulRouter = Router();

const annulSchema = z.object({
  reason: z.string().trim().min(3, "Укажите причину").max(500),
});

dealAnnulRouter.post("/:id/annul", requireAuth, async (req, res) => {
  if (!can(req, "deals.complete")) {
    return res.status(403).json({ error: "Аннулировать сделку может только руководитель" });
  }
  const parsed = annulSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: "Укажите причину аннулирования", details: parsed.error.flatten() });
  }

  try {
    const result = await annulDeal({
      dealId: req.params.id,
      actorId: req.agent!.id,
      reason: parsed.data.reason,
      ownAgentId: scopeDealsToOwnAgent(req),
    });

    logAudit(req, "DEAL_ANNUL", "Deal", result.deal.id, {
      reason: parsed.data.reason,
      clientId: result.deal.clientId,
      propertyId: result.deal.propertyId,
      propertyReturnedToSale: result.propertyReturnedToSale,
    });
    publishDealUpdated({
      dealId: result.deal.id,
      clientId: result.deal.clientId,
      agentId: result.deal.agentId,
      stage: result.deal.stage,
      actorId: req.agent!.id,
    });
    if (req.agent!.id !== result.deal.agentId) {
      sendPushToAgent(result.deal.agentId, {
        title: "Сделка аннулирована",
        body: `${result.clientName} — причина: ${parsed.data.reason}`,
        url: "/deals",
        tag: `deal-${result.deal.id}`,
      }).catch((err) => console.error("[push] аннулирование сделки:", err));
    }

    res.json({ id: result.deal.id, stage: result.deal.stage, propertyReturnedToSale: result.propertyReturnedToSale });
  } catch (err) {
    if (err instanceof DealAnnulError) return res.status(err.status).json({ error: err.message });
    throw err;
  }
});
