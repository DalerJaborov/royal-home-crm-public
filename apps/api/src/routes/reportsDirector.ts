import { Router } from "express";
import { directorDashboardQuerySchema } from "@royal-home/shared";

/**
 * ДАШБОРД ДИРЕКТОРА (ТЗ владельца, 21.11.2026). Монтируется внутрь reportsRouter,
 * поэтому право reports.view и вход уже проверены. Заглушка: схема ответа —
 * packages/shared/src/directorDashboard.ts, расчёт идёт следующим коммитом.
 */
export const reportsDirectorRouter = Router();

reportsDirectorRouter.get("/", (req, res) => {
  const parsed = directorDashboardQuerySchema.safeParse(req.query);
  if (!parsed.success) return res.status(400).json({ error: "Некорректные параметры", details: parsed.error.flatten() });
  return res.status(501).json({ error: "Дашборд директора ещё собирается" });
});
