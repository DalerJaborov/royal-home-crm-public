import { Router } from "express";
import { requireAuth, requirePermission } from "../auth/middleware.js";
import { buildScenarioComparison, MIN_CONVERSATIONS_PER_SCENARIO } from "../lib/salesScenarioStats.js";

/**
 * Сравнение манер продажи бота — окно наружу для экрана Настройки → Бот.
 *
 * Отдельный роут, а не поле в GET /settings: это свёртка по всей таблице диалогов,
 * и тащить её в каждый ответ настроек значило бы платить за неё на каждом открытии
 * любого экрана Настроек. Смотрят на неё раз в несколько дней.
 *
 * Только чтение. Рубильник сравнения живёт в Settings и правится обычным
 * PATCH /settings — второго способа его переключить нет.
 */
export const botScenariosRouter = Router();

botScenariosRouter.get("/", requireAuth, requirePermission("settings.view"), async (_req, res) => {
  const comparison = await buildScenarioComparison();
  // Порог отдаём вместе с числами: интерфейс объясняет им, почему выводов пока нет,
  // и своей копии этого числа держать не должен — разойдутся.
  res.json({ ...comparison, minConversationsPerScenario: MIN_CONVERSATIONS_PER_SCENARIO });
});

