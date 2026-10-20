import { Router, type Request, type Response, type NextFunction } from "express";
import { createHash, randomUUID } from "node:crypto";
import { isUiShellEnabled, parseUiShellRollout, uiShellRolloutSchema, storedUiShellRolloutSchema } from "@royal-home/shared";
import { prisma } from "../db.js";
import { Prisma } from "../generated/prisma/client.js";
import { requireAuth, requirePermission } from "../auth/middleware.js";
import { requireElevation } from "../lib/stepUp.js";

export const uiShellRouter = Router();
// Also prevent caching authorization errors or failed config writes.
uiShellRouter.use((_req, res, next) => {
  res.setHeader("Cache-Control", "no-store");
  next();
});
uiShellRouter.use(requireAuth);

function requireShellAdministrator(req: Request, res: Response, next: NextFunction) {
  if (req.agent?.role !== "DIRECTOR" && req.agent?.role !== "ADMIN") {
    return res.status(403).json({ error: "Недостаточно прав" });
  }
  next();
}

async function storedConfig() {
  const settings = await prisma.settings.findUnique({
    where: { id: "singleton" },
    select: { uiShellRollout: true },
  });
  return settings?.uiShellRollout;
}

function versionOf(raw: unknown): string {
  const stored = storedUiShellRolloutSchema.safeParse(raw);
  return stored.success ? stored.data.revision : `legacy-${createHash("sha256").update(JSON.stringify(raw ?? null)).digest("hex")}`;
}
class ShellConflict extends Error {}
class InvalidShellAgents extends Error {
  constructor(readonly ids: string[]) { super("Invalid shell employees"); }
}

uiShellRouter.get("/", async (req, res) => {
  res.json({ enabled: isUiShellEnabled(await storedConfig(), req.agent!) });
});

uiShellRouter.get("/config", requireShellAdministrator, requirePermission("settings.manage"), async (_req, res) => {
  const raw = await storedConfig();
  const version = versionOf(raw);
  res.setHeader("ETag", `"${version}"`);
  res.json({ ...parseUiShellRollout(raw), version });
});

uiShellRouter.put("/config", requireShellAdministrator, requirePermission("settings.manage"), requireElevation, async (req, res) => {
  const parsed = uiShellRolloutSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: "Некорректные настройки оболочки", issues: parsed.error.issues });
  }
  const config = {
    ...parsed.data,
    agentIds: [...new Set(parsed.data.agentIds)],
    roles: [...new Set(parsed.data.roles)],
  };
  const expected = req.get("If-Match");
  if (!expected) return res.status(428).json({ error: "Обновите настройки перед сохранением.", code: "UI_SHELL_VERSION_REQUIRED" });
  try {
    const version = await prisma.$transaction(async (tx) => {
      const settings = await tx.settings.findUnique({ where: { id: "singleton" }, select: { uiShellRollout: true } });
      const raw = settings?.uiShellRollout;
      if (expected !== `"${versionOf(raw)}"`) throw new ShellConflict();
      if (config.agentIds.length) {
        const agents = await tx.agent.findMany({ where: { id: { in: config.agentIds }, isActive: true }, select: { id: true } });
        const knownIds = new Set(agents.map((agent) => agent.id));
        const missing = config.agentIds.filter((id) => !knownIds.has(id));
        if (missing.length) throw new InvalidShellAgents(missing);
      }
      const revision = randomUUID();
      const envelope = { revision, config };
      if (!settings) {
        // A simultaneous first writer is rejected by the singleton unique key.
        try {
          await tx.settings.create({ data: { id: "singleton", uiShellRollout: envelope } });
        } catch (error) {
          if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") throw new ShellConflict();
          throw error;
        }
      } else {
        const updated = await tx.settings.updateMany({
          where: { id: "singleton", uiShellRollout: { equals: raw == null ? Prisma.AnyNull : raw as Prisma.InputJsonValue } },
          data: { uiShellRollout: envelope },
        });
        if (updated.count !== 1) throw new ShellConflict();
      }
      const author = await tx.agent.findUnique({ where: { id: req.agent!.id }, select: { fullName: true } });
      await tx.auditLog.create({ data: {
        action: "SETTINGS_UPDATE", entityType: "Settings", entityId: "singleton", agentId: req.agent!.id,
        agentName: author?.fullName ?? "Неизвестно",
        meta: { uiShellRollout: config, before: parseUiShellRollout(raw), after: config, version: revision },
      } });
      return revision;
    });
    res.setHeader("ETag", `"${version}"`);
    res.json({ ...config, version });
  } catch (error) {
    if (error instanceof ShellConflict) {
      return res.status(409).json({ error: "Настройки уже изменены другим администратором. Обновите их и проверьте свой выбор.", code: "UI_SHELL_CONFLICT" });
    }
    if (error instanceof InvalidShellAgents) return res.status(400).json({ error: "Некоторые сотрудники не найдены или отключены. Обновите список перед сохранением.", missingAgentIds: error.ids });
    throw error;
  }
});
