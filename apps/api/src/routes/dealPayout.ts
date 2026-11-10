import { Router } from "express";
import { prisma } from "../db.js";
import { can, requireAuth } from "../auth/middleware.js";
import { getDealPayout } from "../lib/dealDocumentsDb.js";
import { markDealPayoutFor } from "../lib/dealWrites.js";

/**
 * Факт выплаты комиссии агенту-риелтору (Пачка 14, 11.09.2026, POST /deals/:id/payout).
 *
 * Отдельный файл от routes/deals.ts (брифинг требует не трогать общий файл больше
 * необходимого — его правит несколько пачек параллельно, см. Пачка 8). Колонки
 * `realtorPayoutAt`/`realtorPayoutById`/`realtorPayoutNote` читаются/пишутся через
 * lib/dealDocumentsDb.ts ($queryRaw/$executeRaw) — сгенерированный в этом worktree
 * Prisma Client их не знает, prisma generate запрещён (см. докстринг там).
 *
 * Право — `finance.manage` ИЛИ `deals.setCommission` (как в задании), сделка
 * обязана быть COMPLETED (нет смысла выплачивать за незакрытую сделку), и
 * выплата идемпотентна: повторный вызов на уже выплаченной сделке — 409, а не
 * тихая перезапись даты/автора.
 */
export const dealPayoutRouter = Router();

dealPayoutRouter.use(requireAuth);

/** Текущий статус выплаты — экрану «Финансы»/карточке сделки нечем иначе узнать
 *  realtorPayoutAt: основной GET /deals не знает этих колонок (см. докстринг
 *  выше про lib/dealDocumentsDb.ts). Владение — своя сделка либо deals.viewAll,
 *  тем же принципом, что у dealDocumentsRouter. */
dealPayoutRouter.get("/:id/payout", async (req, res) => {
  const deal = await prisma.deal.findUnique({ where: { id: req.params.id }, select: { id: true, agentId: true, stage: true } });
  if (!deal) return res.status(404).json({ error: "Сделка не найдена" });
  if (!can(req, "deals.viewAll") && deal.agentId !== req.agent!.id) {
    return res.status(403).json({ error: "Недостаточно прав" });
  }
  const payout = await getDealPayout(deal.id);
  res.json({
    stage: deal.stage,
    realtorPayoutAt: payout?.realtorPayoutAt ?? null,
    realtorPayoutById: payout?.realtorPayoutById ?? null,
    realtorPayoutNote: payout?.realtorPayoutNote ?? null,
  });
});

dealPayoutRouter.post("/:id/payout", async (req, res) => {
  // Тело — одна дверь с ИИ-помощницей (lib/dealWrites.ts, markDealPayoutFor).
  const outcome = await markDealPayoutFor(req, req.params.id, req.body);
  if (!outcome.ok) return res.status(outcome.status).json(outcome.body);
  res.json(outcome.payout);
});
