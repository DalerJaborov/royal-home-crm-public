import { Router } from "express";
import { requireAuth } from "../auth/middleware.js";
import { annulDealFor } from "../lib/dealWrites.js";

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

dealAnnulRouter.post("/:id/annul", requireAuth, async (req, res) => {
  // Тело — одна дверь с ИИ-помощницей (lib/dealWrites.ts, annulDealFor).
  const outcome = await annulDealFor(req, req.params.id, req.body);
  if (!outcome.ok) return res.status(outcome.status).json(outcome.body);
  res.json(outcome.result);
});
