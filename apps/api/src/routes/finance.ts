import { Router } from "express";
import { z } from "zod";
import { commissionForecastSchema } from "@royal-home/shared";
import { requireAuth, requirePermission } from "../auth/middleware.js";
import { buildCommissionForecast, currentDushanbeMonth } from "../lib/financeForecast.js";
import { describeError } from "../lib/describeError.js";
import { logSystemError } from "../lib/systemError.js";

/**
 * ФИНАНСЫ — расчёты поверх денег, которые не являются списком расходов.
 *
 * Расходы живут в routes/expenses.ts и смонтированы отдельно (/api/v1/expenses);
 * сюда идёт то, что расходами не является, — прогноз комиссии к концу месяца.
 * Право то же, что у блока «Деньги» и раздела «Финансы»: finance.view.
 */
export const financeRouter = Router();

financeRouter.use(requireAuth, requirePermission("finance.view"));

const forecastQuerySchema = z.object({
  /** «2026-09». Месяц по Душанбе; без параметра — текущий. */
  month: z
    .string()
    .regex(/^\d{4}-\d{2}$/, "Месяц указывается как ГГГГ-ММ")
    .optional(),
});

financeRouter.get("/forecast", async (req, res) => {
  const parsed = forecastQuerySchema.safeParse(req.query);
  if (!parsed.success) {
    res.status(400).json({ error: "Неверный месяц", details: parsed.error.flatten().fieldErrors });
    return;
  }
  try {
    const forecast = await buildCommissionForecast(parsed.data.month ?? currentDushanbeMonth());
    // Форма ответа проверяется той же схемой, что читает клиент: расчёт большой,
    // и молча отдать поле не того типа здесь проще, чем кажется.
    res.json(commissionForecastSchema.parse(forecast));
  } catch (err) {
    void logSystemError("api", `Прогноз комиссии не посчитан: ${describeError(err)}`);
    res.status(500).json({ error: "Не удалось посчитать прогноз" });
  }
});
