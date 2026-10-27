import { Router } from "express";
import { z } from "zod";
import { somonMonitorStateSchema, somonRecipientsSchema } from "@royal-home/shared";
import { requireAuth, requirePermission } from "../auth/middleware.js";
import { requireElevation } from "../lib/stepUp.js";
import { prisma } from "../db.js";
import { replaceSomonRecipients, SomonRecipientError } from "../lib/somonLeads/recipients.js";
import { logAudit } from "../lib/audit.js";
import { somonKeyFingerprint } from "../lib/somonLeads/contactIdentity.js";

export const settingsSomonRouter = Router();
settingsSomonRouter.use(requireAuth, requirePermission("settings.manage"));
settingsSomonRouter.get("/status", async (_req, res, next) => {
  try {
    const state = await prisma.somonMonitor.findUnique({ where: { id: "singleton" } });
    const [pending, uncertain, review] = await Promise.all([
      prisma.somonSeenAdvert.count({ where: { status: "PENDING", baseline: false } }),
      prisma.somonDelivery.count({ where: { OR: [{ status: "UNKNOWN" }, { status: "SENDING", updatedAt: { lt: new Date(Date.now() - 120000) } }] } }),
      prisma.somonDelivery.findMany({ where: { OR: [{ status: "UNKNOWN" }, { status: "SENDING", updatedAt: { lt: new Date(Date.now() - 120000) } }] }, orderBy: { updatedAt: "desc" }, take: 20 }),
    ]);
    const [seen, agents] = await Promise.all([
      prisma.somonSeenAdvert.findMany({ where: { advertId: { in: review.map(x => x.advertId) } }, select: { advertId: true, slug: true } }),
      prisma.agent.findMany({ where: { id: { in: review.map(x => x.agentId) } }, select: { id: true, fullName: true } }),
    ]);
    let identityReady = false;
    try { identityReady = !!state?.contactKeyFingerprint && state.contactKeyFingerprint === somonKeyFingerprint(); } catch { /* unavailable */ }
    res.json({ enabled: state?.enabled ?? false, sourceStopped: state?.sourceStopped ?? false, identityReady, baselineDone: !!state?.baselineAt, baselineNextPage: state?.baselineNextPage ?? 1, baselineLastPage: state?.baselineLastPage ?? null, pending, uncertain, review: review.map(x => ({ advertId: x.advertId, agentName: agents.find(a => a.id === x.agentId)?.fullName ?? "Сотрудник недоступен", status: x.status, updatedAt: x.updatedAt, sourceUrl: (() => { const slug = seen.find(s => s.advertId === x.advertId)?.slug; return slug ? `https://somon.tj/adv/${slug}/` : null; })() })) });
  } catch (error) { next(error); }
});
settingsSomonRouter.put("/state", requireElevation, async (req, res, next) => {
  const parsed = somonMonitorStateSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "Некорректное состояние" });
  try {
    const result = await prisma.$transaction(async tx => {
      await tx.$queryRaw`SELECT 1 FROM pg_advisory_xact_lock(hashtext('somon-owner-delivery'))`;
      const state = await tx.somonMonitor.findUnique({ where: { id: "singleton" } });
      let fingerprint: string | undefined;
      if (parsed.data.enabled) {
        if (state?.sourceStopped) return "source_stopped" as const;
        try { fingerprint = somonKeyFingerprint(); } catch { return "identity_unavailable" as const; }
        if (state?.contactKeyFingerprint && state.contactKeyFingerprint !== fingerprint) return "identity_unavailable" as const;
        const recipients = await tx.somonRecipient.findMany({ where: { enabled: true }, select: { agentId: true } });
        const count = await tx.agent.count({ where: { id: { in: recipients.map(x => x.agentId) }, isActive: true, role: "AGENT", telegramChatId: { not: null } } });
        if (!count) return "no_linked_agents" as const;
      }
      await tx.somonMonitor.upsert({ where: { id: "singleton" }, create: { id: "singleton", enabled: parsed.data.enabled, contactKeyFingerprint: fingerprint }, update: { enabled: parsed.data.enabled, ...(fingerprint ? { contactKeyFingerprint: fingerprint } : {}) } });
      return "ok" as const;
    }, { timeout: 35000 });
    if (result !== "ok") return res.status(409).json({ error: result === "no_linked_agents" ? "Выберите хотя бы одного агента с привязанным Telegram" : result === "identity_unavailable" ? "Недоступна проверка повторных контактов; требуется техническая проверка" : "Источник остановлен после ошибок или отказа; проверьте причину перед возобновлением", code: result });
    logAudit(req, parsed.data.enabled ? "SOMON_MONITOR_ENABLED" : "SOMON_MONITOR_DISABLED", "SomonMonitor", "singleton");
    return res.json({ ok: true });
  } catch (error) { return next(error); }
});
settingsSomonRouter.post("/review/:advertId/resolve", requireElevation, async (req, res, next) => {
  const parsed = z.object({ advertId: z.string().regex(/^\d{1,20}$/) }).safeParse(req.params);
  if (!parsed.success) return res.status(400).json({ error: "Некорректный ID объявления" });
  try {
    const count = await prisma.$transaction(async tx => {
      await tx.$queryRaw`SELECT 1 FROM pg_advisory_xact_lock(hashtext('somon-owner-delivery'))`;
      const result = await tx.somonDelivery.updateMany({ where: { advertId: parsed.data.advertId, OR: [{ status: "UNKNOWN" }, { status: "SENDING", updatedAt: { lt: new Date(Date.now() - 120000) } }] }, data: { status: "REVIEWED" } });
      if (result.count) await tx.somonSeenAdvert.updateMany({ where: { advertId: parsed.data.advertId }, data: { slug: null, status: "REVIEWED" } });
      return result.count;
    }, { timeout: 35000 });
    if (!count) return res.status(409).json({ error: "Запись уже проверена или отправка ещё идёт" });
    logAudit(req, "SOMON_DELIVERY_REVIEWED", "SomonDelivery", parsed.data.advertId);
    return res.json({ ok: true });
  } catch (error) { return next(error); }
});
settingsSomonRouter.post("/source/recover", requireElevation, async (req, res, next) => {
  if (!z.object({ checked: z.literal(true) }).strict().safeParse(req.body).success) return res.status(400).json({ error: "Подтвердите проверку причины остановки" });
  try {
    const recovered = await prisma.$transaction(async tx => {
      await tx.$queryRaw`SELECT 1 FROM pg_advisory_xact_lock(hashtext('somon-source-budget'))`;
      const state = await tx.somonMonitor.findUnique({ where: { id: "singleton" } });
      if (!state?.sourceStopped || (state.requestLeaseUntil && state.requestLeaseUntil > new Date())) return false;
      const blockedUntil = new Date(Math.max(state.blockedUntil?.getTime() ?? 0, Date.now() + 120000));
      await tx.somonMonitor.update({ where: { id: "singleton" }, data: { sourceStopped: false, sourceFailures: 0, sourceLastFailureAt: null, requestLeaseToken: null, requestLeaseUntil: null, blockedUntil } });
      return true;
    });
    if (!recovered) return res.status(409).json({ error: "Источник не остановлен или запрос ещё выполняется" });
    logAudit(req, "SOMON_SOURCE_RECOVERED", "SomonMonitor", "singleton");
    return res.json({ ok: true });
  } catch (error) { return next(error); }
});
settingsSomonRouter.get("/recipients", async (_req, res, next) => {
  try {
    const [agents, selected] = await Promise.all([
      prisma.agent.findMany({ where: { role: "AGENT", isActive: true }, select: { id: true, fullName: true, telegramChatId: true }, orderBy: { fullName: "asc" } }),
      prisma.somonRecipient.findMany({ orderBy: { position: "asc" }, select: { agentId: true, enabled: true } }),
    ]);
    res.json({ agents: agents.map(a => ({ id: a.id, fullName: a.fullName, telegramLinked: !!a.telegramChatId, deliveryBlocked: selected.some(s => s.agentId === a.id && !s.enabled) })), selected: selected.filter(a => a.enabled).map(a => a.agentId) });
  } catch (error) { next(error); }
});
settingsSomonRouter.post("/recipients/:agentId/unblock", requireElevation, async (req, res, next) => {
  const parsed = z.object({ agentId: z.string().min(1).max(128) }).safeParse(req.params);
  if (!parsed.success || !z.object({ checked: z.literal(true) }).strict().safeParse(req.body).success) return res.status(400).json({ error: "Подтвердите проверку чата" });
  try {
    const count = await prisma.$transaction(async tx => {
      await tx.$queryRaw`SELECT 1 FROM pg_advisory_xact_lock(hashtext('somon-owner-delivery'))`;
      const agent = await tx.agent.findFirst({ where: { id: parsed.data.agentId, role: "AGENT", isActive: true, telegramChatId: { not: null } }, select: { id: true } });
      if (!agent) return 0;
      return (await tx.somonRecipient.updateMany({ where: { agentId: agent.id, enabled: false }, data: { enabled: true } })).count;
    }, { timeout: 35000 });
    if (!count) return res.status(409).json({ error: "Получатель недоступен или уже включён" });
    logAudit(req, "SOMON_RECIPIENT_UNBLOCKED", "SomonMonitor", "singleton");
    return res.json({ ok: true });
  } catch (error) { return next(error); }
});
settingsSomonRouter.put("/recipients", requireElevation, async (req, res, next) => {
  const parsed = somonRecipientsSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "Некорректный список сотрудников" });
  try {
    await replaceSomonRecipients(parsed.data.agentIds);
    logAudit(req, "SOMON_RECIPIENTS_UPDATED", "SomonMonitor", "singleton", { count: parsed.data.agentIds.length });
    return res.json({ ok: true });
  } catch (error) {
    if (error instanceof SomonRecipientError) return res.status(400).json({ error: "Выберите действующих агентов" });
    return next(error);
  }
});
