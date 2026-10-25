import { Router } from "express";
import { z } from "zod";
import { requireAuth, requirePermission } from "../auth/middleware.js";
import { requireInvestigations } from "../auth/investigations.js";
import { manualDataCorrectionSchema } from "@royal-home/shared";
import { applyManualCorrection, ManualCorrectionConflict, previewManualCorrection } from "../lib/manualDataCorrection.js";
import { prisma } from "../db.js";

export const manualDataCorrectionsRouter = Router();
manualDataCorrectionsRouter.use(requireAuth, requireInvestigations, requirePermission("settings.manage"), requirePermission("clients.viewPhone"));
function prepare(persist: boolean): import("express").RequestHandler {
  return async (req, res) => {
    const parsed = manualDataCorrectionSchema.safeParse({ ...req.body, actorId: req.agent!.id });
    if (!parsed.success) return res.status(400).json({ error: "Некорректный план ручного исправления" });
    try { return res.json(await previewManualCorrection(parsed.data, persist)); }
    catch (error) {
      if (error instanceof ManualCorrectionConflict) return res.status(409).json({ error: error.message });
      return res.status(503).json({ error: "Подготовка исправления недоступна" });
    }
  };
}
manualDataCorrectionsRouter.post("/preview", prepare(false));
manualDataCorrectionsRouter.post("/plans", prepare(true));
manualDataCorrectionsRouter.get("/:id/review", async (req, res) => {
  if (!z.string().uuid().safeParse(req.params.id).success) return res.status(400).json({ error: "Некорректный план" });
  const plan = await prisma.manualDataCorrection.findFirst({ where: { id: req.params.id, actorId: req.agent!.id },
    select: { id: true, status: true, planHash: true, reason: true, operation: true, targets: true, impact: true } });
  if (!plan) return res.status(404).json({ error: "План не найден" });
  return res.json(plan);
});
manualDataCorrectionsRouter.get("/:id", async (req, res) => {
  if (!z.string().uuid().safeParse(req.params.id).success) return res.status(400).json({ error: "Некорректный план" });
  const plan = await prisma.manualDataCorrection.findFirst({ where: { id: req.params.id, actorId: req.agent!.id },
    select: { id: true, status: true, appliedAt: true, planHash: true, result: true, impact: true } });
  if (!plan) return res.status(404).json({ error: "План не найден" });
  return res.json(plan);
});
manualDataCorrectionsRouter.post("/:id/apply", async (req, res) => {
  if (process.env.MANUAL_DATA_CORRECTIONS_LIVE !== "explicitly-approved") {
    return res.status(409).json({ error: "Применение ручных исправлений выключено. Доступен только план." });
  }
  const parsed = z.object({ planHash: z.string().regex(/^[a-f0-9]{64}$/), impactReviewed: z.literal(true) }).strict().safeParse(req.body);
  if (!z.string().uuid().safeParse(req.params.id).success || !parsed.success) return res.status(400).json({ error: "Укажите проверенный план" });
  try { return res.json(await applyManualCorrection({ planId: req.params.id, actorId: req.agent!.id, ...parsed.data })); }
  catch (error) {
    if (error instanceof ManualCorrectionConflict) return res.status(409).json({ error: error.message });
    return res.status(503).json({ error: "Исправление не выполнено; проверьте состояние плана перед повтором" });
  }
});
