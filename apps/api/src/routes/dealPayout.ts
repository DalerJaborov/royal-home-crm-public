import { Router } from "express";
import { dealPayoutSchema } from "@royal-home/shared";
import { prisma } from "../db.js";
import { can, requireAuth } from "../auth/middleware.js";
import { sendPushToAgent } from "../push.js";
import { logAudit } from "../lib/audit.js";
import { getDealPayout, setDealPayout } from "../lib/dealDocumentsDb.js";

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
  if (!can(req, "finance.manage") && !can(req, "deals.setCommission")) {
    return res.status(403).json({ error: "Недостаточно прав" });
  }

  const parsed = dealPayoutSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: "Неверные данные", details: parsed.error.flatten() });
  }

  const deal = await prisma.deal.findUnique({
    where: { id: req.params.id },
    select: { id: true, agentId: true, stage: true, client: { select: { fullName: true } } },
  });
  if (!deal) return res.status(404).json({ error: "Сделка не найдена" });
  if (deal.stage !== "COMPLETED") {
    return res.status(409).json({ error: "Выплата фиксируется только по закрытой сделке" });
  }

  const payout = await getDealPayout(deal.id);
  if (payout?.realtorPayoutAt) {
    return res.status(409).json({ error: "Комиссия по этой сделке уже отмечена выплаченной" });
  }

  const realtorPayoutAt = await setDealPayout(deal.id, req.agent!.id, parsed.data.note ?? null);
  // Проверка выше — быстрый путь; здесь ловим гонку: второй из двух одновременных
  // запросов уже ничего не записал, либо сделку аннулировали между проверкой стадии
  // и записью (условие stage/annulledAt в самом UPDATE).
  if (!realtorPayoutAt) {
    return res.status(409).json({ error: "Выплата не записана: комиссия уже отмечена выплаченной или сделка больше не закрыта" });
  }

  logAudit(req, "DEAL_PAYOUT", "Deal", deal.id, { note: parsed.data.note ?? null });

  if (req.agent!.id !== deal.agentId) {
    sendPushToAgent(deal.agentId, {
      title: "Комиссия выплачена",
      body: `${deal.client.fullName} — комиссия по сделке отмечена выплаченной`,
      url: "/deals",
      tag: `deal-payout-${deal.id}`,
    }).catch((err) => console.error("[push] выплата комиссии:", err));
  }

  res.json({
    id: deal.id,
    realtorPayoutAt,
    realtorPayoutById: req.agent!.id,
    realtorPayoutNote: parsed.data.note ?? null,
  });
});
