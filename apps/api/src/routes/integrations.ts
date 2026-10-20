import { Router } from "express";
import { prisma } from "../db.js";
import { requireAuth, requirePermission } from "../auth/middleware.js";

export const integrationsRouter = Router();

/**
 * Список внешних каналов со статусом — экран `/integrations` (перенос
 * мобильного макета 14.09.2026, шаг 5). Читает СНИМОК ночной самопроверки
 * (`IntegrationHealthSnapshot`, пишет cron.ts после каждого прогона
 * `lib/integrationHealth.ts::runIntegrationHealthChecks()`), а не гоняет
 * проверки заново на каждое открытие экрана: живые проверки бьют по
 * Gemini/Meta Graph/R2 и дублируют алерты, которые уже шлёт ночной прогон.
 *
 * Снимок может быть пуст (например, до первого ночного тика после выката) —
 * тогда список пуст и `checkedAt` отсутствует; фронт обязан показать честное
 * «нет данных», а не молчаливый пустой список без объяснения.
 */
integrationsRouter.get("/", requireAuth, requirePermission("auditLog.view"), async (_req, res) => {
  const rows = await prisma.integrationHealthSnapshot.findMany({ orderBy: { name: "asc" } });
  res.json({
    channels: rows.map((r) => ({ name: r.name, ok: r.ok, detail: r.detail, checkedAt: r.checkedAt })),
  });
});
