/**
 * Тексты первого сообщения в WhatsApp у Meta (24.09.2026): статус проверки,
 * отправка на одобрение, кабинет WhatsApp вручную.
 *
 * Отдельным роутером, как СМС (routes/sms.ts): у текстов своё правило — их
 * состояние живёт у Meta, а не в нашей базе. Смотреть — settings.view,
 * отправлять и менять — settings.manage.
 */
import { Router } from "express";
import { z } from "zod";
import { prisma } from "../db.js";
import { requireAuth, requirePermission } from "../auth/middleware.js";
import { logAudit } from "../lib/audit.js";
import { FirstContactError, resetWaTemplateCaches, submitWaTemplates, waTemplatesOverview } from "../lib/whatsappFirstContact.js";

export const whatsappTemplatesRouter = Router();

whatsappTemplatesRouter.get("/", requireAuth, requirePermission("settings.view"), async (req, res) => {
  res.json(await waTemplatesOverview(req.query.fresh === "1"));
});

whatsappTemplatesRouter.post("/submit", requireAuth, requirePermission("settings.manage"), async (req, res) => {
  try {
    const overview = await submitWaTemplates();
    logAudit(req, "whatsapp.templates.submit", "Settings", "singleton", {});
    res.json(overview);
  } catch (err) {
    if (err instanceof FirstContactError) return res.status(err.status).json({ error: err.message });
    console.error("[whatsapp] отправка текстов в Meta:", err instanceof Error ? err.message : err);
    res.status(500).json({ error: "Не удалось отправить тексты в Meta" });
  }
});

const accountSchema = z.object({
  /** Идентификатор кабинета WhatsApp — только цифры; пусто — стереть. */
  businessAccountId: z.string().trim().regex(/^\d{0,30}$/, "Только цифры"),
});

whatsappTemplatesRouter.patch("/account", requireAuth, requirePermission("settings.manage"), async (req, res) => {
  const parsed = accountSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "Идентификатор кабинета — только цифры" });
  const value = parsed.data.businessAccountId || null;
  await prisma.settings.upsert({
    where: { id: "singleton" },
    update: { metaWaBusinessAccountId: value },
    create: { id: "singleton", metaWaBusinessAccountId: value },
  });
  resetWaTemplateCaches();
  logAudit(req, "whatsapp.templates.account", "Settings", "singleton", { businessAccountId: value });
  res.json(await waTemplatesOverview(true));
});
