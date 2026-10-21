import { Router } from "express";
import { z } from "zod";
import { instagramAppBindingInputSchema } from "@royal-home/shared";
import { requireAuth, requirePermission } from "../auth/middleware.js";
import { requireElevation } from "../lib/stepUp.js";
import { bindInstagramAppForAccount, readInstagramAppBindingStatus } from "../lib/instagramAppBinding.js";
import { InstagramAppBindingError } from "../lib/instagramAppBindingProof.js";

export const settingsInstagramAppBindingRouter = Router();
settingsInstagramAppBindingRouter.use(requireAuth, requirePermission("settings.manage"));
const paramsSchema = z.object({ id: z.string().uuid() });
const message = "Не удалось настроить подписанта. Обновите состояние подключения и проверьте аккаунт и подписки.";
settingsInstagramAppBindingRouter.get("/:id/instagram-app-binding", async (req, res, next) => {
  const parsed = paramsSchema.safeParse(req.params);
  if (!parsed.success) return res.status(400).json({ error: "Некорректный идентификатор аккаунта" });
  try { res.json(await readInstagramAppBindingStatus(parsed.data.id)); }
  catch (error) { if (error instanceof InstagramAppBindingError) return res.status(error.status).json({ error: message, code: error.code }); next(error); }
});
settingsInstagramAppBindingRouter.post("/:id/instagram-app-binding", requireElevation, async (req, res, next) => {
  const params = paramsSchema.safeParse(req.params), body = instagramAppBindingInputSchema.safeParse(req.body);
  if (!params.success || !body.success) return res.status(400).json({ error: "Некорректные данные привязки приложения" });
  try { res.json(await bindInstagramAppForAccount(req.agent!.id, params.data.id, body.data)); }
  catch (error) { if (error instanceof InstagramAppBindingError) return res.status(error.status).json({ error: message, code: error.code }); next(error); }
});
