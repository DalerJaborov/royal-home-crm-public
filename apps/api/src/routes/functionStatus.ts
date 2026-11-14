import { Router } from "express";
import { canViewFunctionStatus, functionStatusResponseSchema } from "@royal-home/shared";
import { requireAuth } from "../auth/middleware.js";
import { investigationViewerRole } from "../auth/investigations.js";
import { loadFunctionStatus } from "../lib/functionStatus.js";

/**
 * «Состояние функций» (14.11.2026): какие скрытые рубильники CRM включены, какие работают только
 * «для проверки», какие выключены и почему. Только чтение, только директор и администратор:
 * экран показывает имена серверных переменных окружения (значения — никогда).
 */
export const functionStatusRouter = Router();

functionStatusRouter.use(requireAuth);

functionStatusRouter.get("/", async (req, res, next) => {
  try {
    if (!canViewFunctionStatus(req.agent?.role)) return res.status(403).json({ error: "Недостаточно прав" });
    const body = await loadFunctionStatus(investigationViewerRole(req));
    // Ответ проходит ту же схему, которой пользуется экран: расхождение ловится здесь, а не у директора.
    return res.json(functionStatusResponseSchema.parse(body));
  } catch (err) {
    return next(err);
  }
});
