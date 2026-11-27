import { Router } from "express";
import { cleanupRequestSchema, CLEANUP_TARGET_LABELS } from "@royal-home/shared";
import { requireAuth, requirePermission } from "../auth/middleware.js";
import { logAudit } from "../lib/audit.js";
import { countCleanup, runManualCleanup, type CleanupActor } from "../lib/dataCleanup.js";

/**
 * Кнопки «Очистить» (владелец 28.11.2026): уведомления, оповещения директору, журнал ошибок.
 * Только директор/админ (право settings.manage). Удаление безвозвратное, поэтому экран сначала спрашивает
 * число строк (GET /preview), а удаляет только после подтверждения (POST /run). Каждая чистка — в AuditLog.
 */
export const dataCleanupRouter = Router();

dataCleanupRouter.use(requireAuth, requirePermission("settings.manage"));

function actorOf(req: { agent?: { id: string; role?: string | null } }): CleanupActor {
  return { id: req.agent!.id, role: req.agent!.role };
}

/** Сколько строк будет удалено — для окна подтверждения. */
dataCleanupRouter.get("/preview", async (req, res) => {
  const parsed = cleanupRequestSchema.safeParse(req.query);
  if (!parsed.success) return res.status(400).json({ error: "Неверные параметры очистки", details: parsed.error.flatten() });
  const { target, mode, scope } = parsed.data;
  const count = await countCleanup(target, mode, scope, actorOf(req));
  res.json({ count });
});

dataCleanupRouter.post("/run", async (req, res) => {
  const parsed = cleanupRequestSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "Неверные параметры очистки", details: parsed.error.flatten() });
  const { target, mode, scope } = parsed.data;
  const count = await runManualCleanup(target, mode, scope, actorOf(req));
  logAudit(req, "CLEANUP", CLEANUP_TARGET_LABELS[target], null, { target, mode, scope: target === "notifications" ? scope : "all", count });
  res.json({ ok: true, count });
});
