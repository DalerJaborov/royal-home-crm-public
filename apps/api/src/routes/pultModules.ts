import { Router } from "express";
import { PULT_MODULES, isPultModuleId, pultModulePatchSchema, type PultModuleState } from "@royal-home/shared";
import { prisma } from "../db.js";
import { requireAuth, requirePermission } from "../auth/middleware.js";
import { requireElevation } from "../lib/stepUp.js";
import { logAudit } from "../lib/audit.js";
import { invalidatePultModuleCache } from "../lib/pultModules.js";
import { invalidateMissionControlCache } from "../lib/missionControlCache.js";

/**
 * Модули пульта директора: список с состоянием и тумблер (аудит 02.09.2026 §4).
 * Чтение — тем же правом, что и сам пульт; переключение — как любая настройка CRM:
 * settings.manage + подтверждение личности, след в AuditLog.
 */
export const pultModulesRouter = Router();

pultModulesRouter.get("/modules", requireAuth, requirePermission("dashboard.analytics"), async (_req, res) => {
  const rows = await prisma.pultModule.findMany();
  const byId = new Map(rows.map((r) => [r.id, r]));
  const editorIds = [...new Set(rows.map((r) => r.updatedById).filter((id): id is string => !!id))];
  const editors = editorIds.length
    ? await prisma.agent.findMany({ where: { id: { in: editorIds } }, select: { id: true, fullName: true } })
    : [];
  const editorById = new Map(editors.map((e) => [e.id, e]));

  const modules: PultModuleState[] = PULT_MODULES.map((m) => {
    const row = byId.get(m.id);
    const editor = row?.updatedById ? editorById.get(row.updatedById) : undefined;
    return {
      ...m,
      enabled: row?.enabled ?? true,
      updatedAt: row?.updatedAt.toISOString() ?? null,
      updatedBy: editor ?? null,
    };
  });
  res.json({ modules });
});

pultModulesRouter.patch(
  "/modules/:id",
  requireAuth,
  requirePermission("settings.manage"),
  requireElevation,
  async (req, res) => {
    const { id } = req.params;
    if (!isPultModuleId(id)) {
      return res.status(404).json({ error: "Такого модуля пульта нет" });
    }
    const parsed = pultModulePatchSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: "Ожидается { enabled: true | false }" });
    }
    const { enabled } = parsed.data;
    const row = await prisma.pultModule.upsert({
      where: { id },
      update: { enabled, updatedById: req.agent!.id },
      create: { id, enabled, updatedById: req.agent!.id },
    });
    invalidatePultModuleCache();
    // Тумблер обязан отразиться на пульте сразу, а не через минуту кэша секций.
    invalidateMissionControlCache();
    logAudit(req, "PULT_MODULE_TOGGLE", "PultModule", id, { enabled });
    res.json({ id, enabled: row.enabled, updatedAt: row.updatedAt.toISOString() });
  }
);
