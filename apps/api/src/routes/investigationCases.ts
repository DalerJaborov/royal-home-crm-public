import { Router } from "express";
import { z } from "zod";
import { loadInvestigationRecommendation } from "../lib/investigationRecommendation.js";
import { investigationCasesQuerySchema, investigationDecisionSchema, investigationCaseConfigSchema, investigationCaseConfigUpdateSchema } from "@royal-home/shared";
import { prisma } from "../db.js";
import { can, requireAuth, requirePermission } from "../auth/middleware.js";
import { clientNamePhoneSafe, phoneSafeText } from "../lib/clientPhone.js";
import { requireInvestigations } from "../auth/investigations.js";
import { decideInvestigation, InvestigationConflict } from "../lib/investigationCases.js";
import { evaluateInvestigationRecurrence } from "../lib/investigationRecurrence.js";
import { sellerControlPreview } from "../lib/sellerControlPreview.js";
import { sellerControlRouter } from "./sellerControl.js";
import { previewBuyerShowingCandidates } from "../lib/buyerShowingCandidates.js";
import { previewManualContactOnly } from "../lib/manualContactPreview.js";
import { previewNamedAssignments } from "../lib/namedAssignmentPreview.js";
import { previewWorkflowAgentCounts } from "../lib/workflowAgentPreview.js";
import { weeklyOperationalPreviewQuerySchema } from "@royal-home/shared";
import { previewWeeklyOperations } from "../lib/weeklyOperationalPreview.js";
import { previewAgencyLabelCoincidences } from "../lib/agencyLabelPreview.js";
import { investigationSeveritySchema } from "@royal-home/shared";
import { setInvestigationSeverity } from "../lib/investigationSeverity.js";

export const investigationCasesRouter = Router();
investigationCasesRouter.use(requireAuth, requireInvestigations, requirePermission("clients.securityReview"));
investigationCasesRouter.use("/seller-control", sellerControlRouter);
const include = { subjectAgent: { select: { id: true, fullName: true } }, _count: { select: { evidence: true, decisions: true } } } as const;
const idSchema = z.string().uuid();

investigationCasesRouter.get("/agency-label-preview", async (req, res) => {
  res.json(presentEvidencePayload(await previewAgencyLabelCoincidences(), can(req, "clients.viewPhone")));
});

investigationCasesRouter.get("/weekly-operational-preview", async (req, res) => {
  const query = weeklyOperationalPreviewQuerySchema.safeParse(req.query);
  if (!query.success) return res.status(400).json({ error: "Неверные параметры сводки" });
  res.json(presentEvidencePayload(await previewWeeklyOperations(query.data.kind, query.data.page), can(req, "clients.viewPhone")));
});

investigationCasesRouter.post("/:id/severity", async (req, res) => {
  const id = idSchema.safeParse(req.params.id), body = investigationSeveritySchema.safeParse(req.body);
  if (!id.success || !body.success) return res.status(400).json({ error: "Проверьте уровень и отдельное подтверждение C4" });
  try { res.json({ decision: await setInvestigationSeverity({ ...body.data, caseId: id.data, actorId: req.agent!.id }) }); }
  catch (error) { if (error instanceof InvestigationConflict) return res.status(409).json({ error: error.message }); throw error; }
});

investigationCasesRouter.get("/buyer-showing-candidates", async (req, res) => {
  res.json({ mode: "PREVIEW", items: presentEvidencePayload(await previewBuyerShowingCandidates(), can(req, "clients.viewPhone")) });
});

investigationCasesRouter.get("/workflow-observations", async (req, res) => {
  const active = await prisma.workflowCheckpoint.findUnique({ where: { key: "client-workflow-observations-v1" }, select: { key: true } });
  if (!active) return res.json({ mode: "PREVIEW", coverage: "NOT_ACTIVATED", items: [] });
  const rows = await prisma.clientWorkflowObservation.findMany({ where: { executionMode: "PREVIEW" }, orderBy: { createdAt: "desc" }, take: 100 });
  res.json({ mode: "PREVIEW", coverage: "FUTURE_SOURCES_ONLY", items: presentEvidencePayload(rows, can(req, "clients.viewPhone")) });
});

investigationCasesRouter.get("/manual-contact-preview", async (req, res) => {
  const query = investigationCasesQuerySchema.safeParse(req.query);
  if (!query.success) return res.status(400).json({ error: "Неверные параметры" });
  res.json(await previewManualContactOnly(query.data.page));
});
investigationCasesRouter.get("/workflow-agent-preview", async (req, res) => { res.json(presentEvidencePayload(await previewWorkflowAgentCounts(), can(req, "clients.viewPhone"))); });
investigationCasesRouter.get("/named-assignment-preview", async (req, res) => {
  res.json(presentEvidencePayload(await previewNamedAssignments(), can(req, "clients.viewPhone")));
});

investigationCasesRouter.get("/seller-control-preview", async (req, res) => {
  const parsed = investigationCasesQuerySchema.safeParse(req.query);
  if (!parsed.success) return res.status(400).json({ error: "Неверные параметры" });
  try {
    const preview = await sellerControlPreview(parsed.data.page);
    res.json({ ...preview, items: preview.items.map(item => ({ ...item, name: clientNamePhoneSafe(item.name, can(req, "clients.viewPhone")) })) });
  }
  catch { res.status(503).json({ error: "Данные контроля временно недоступны", mode: "PREVIEW", evaluation: "DATA_UNAVAILABLE" }); }
});
function presentEvidencePayload(value: unknown, canSeePhone: boolean): unknown {
  if (value instanceof Date) return value.toISOString();
  if (typeof value === "string") return phoneSafeText(value, canSeePhone);
  if (Array.isArray(value)) return value.map(item => presentEvidencePayload(item, canSeePhone));
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, presentEvidencePayload(item, canSeePhone)]));
  return value;
}

investigationCasesRouter.get("/automation-preview", async (req, res) => {
  const [buyers, sellers] = await Promise.all([
    prisma.postShowingCall.findMany({ where: { previewOnly: true }, take: 25, orderBy: { createdAt: "desc" },
      select: { id: true, scheduledFor: true, client: { select: { fullName: true } } } }),
    prisma.sellerProbeCall.findMany({ where: { previewOnly: true }, take: 25, orderBy: { createdAt: "desc" },
      select: { id: true, scheduledFor: true, seller: { select: { fullName: true } } } }),
  ]);
  res.json({ mode: "PREVIEW", items: [
    ...buyers.map(row => ({ id: row.id, kind: "BUYER", name: clientNamePhoneSafe(row.client.fullName, can(req, "clients.viewPhone")), scheduledFor: row.scheduledFor })),
    ...sellers.map(row => ({ id: row.id, kind: "SELLER", name: clientNamePhoneSafe(row.seller.fullName, can(req, "clients.viewPhone")), scheduledFor: row.scheduledFor })),
  ] });
});

investigationCasesRouter.get("/config", async (_req, res) => {
  const settings = await prisma.settings.findUnique({ where: { id: "singleton" }, select: { investigationCaseConfig: true } });
  const parsed = investigationCaseConfigSchema.safeParse(settings?.investigationCaseConfig ?? {});
  res.json({ config: parsed.success ? parsed.data : null, mode: "preview" });
});
investigationCasesRouter.put("/config", async (req, res) => {
  const parsed = investigationCaseConfigUpdateSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "Укажите положительные целые пороги и период" });
  const configured = investigationCaseConfigSchema.safeParse(parsed.data.config);
  const config = configured.success ? configured.data : {};
  await prisma.settings.upsert({ where: { id: "singleton" }, create: { id: "singleton", investigationCaseConfig: config }, update: { investigationCaseConfig: config } });
  res.json({ config: configured.success ? configured.data : null, mode: "preview" });
});

investigationCasesRouter.get("/", async (req, res) => {
  const parsed = investigationCasesQuerySchema.safeParse(req.query);
  if (!parsed.success) return res.status(400).json({ error: "Неверные параметры" });
  const { page, status } = parsed.data;
  const where = status ? { status } : {};
  const [items, total] = await Promise.all([
    prisma.investigationCase.findMany({ where, include, orderBy: [{ lastSignalAt: "desc" }, { id: "desc" }], skip: (page - 1) * 25, take: 25 }),
    prisma.investigationCase.count({ where }),
  ]);
  res.json({ items, total, page, pageSize: 25, mode: "preview" });
});

// Descriptive counts only. No statistical verdict without an explicitly configured sample policy.
investigationCasesRouter.get("/recurrence", async (_req, res) => {
  try {
    const settings = await prisma.settings.findUniqueOrThrow({ where: { id: "singleton" }, select: { investigationCaseConfig: true } });
    const parsed = investigationCaseConfigSchema.safeParse(settings.investigationCaseConfig);
    const config = parsed.success ? parsed.data : null;
    const since = new Date(Date.now() - (config?.windowDays ?? 30) * 86400000);
    const rows = await prisma.investigationCase.findMany({ where: { lastSignalAt: { gte: since } }, take: 10001,
      select: { id: true, subjectAgentId: true, subjectAgent: { select: { fullName: true } }, status: true, evidence: { select: { independenceKey: true } } } });
    const truncated = rows.length > 10000;
    const names = new Map(rows.map(row => [row.subjectAgentId, row.subjectAgent?.fullName]));
    const groups = truncated ? [] : evaluateInvestigationRecurrence(config, rows).map(row => ({ ...row, agentName: names.get(row.subjectAgentId) ?? "Сотрудник" }));
    const clearedCases = await prisma.investigationDecision.groupBy({ by: ["caseId"], where: { action: "CLEARED", createdAt: { gte: since } } });
    res.json({ since, config, groups, clearedCases: clearedCases.length,
      evaluation: truncated ? "INCOMPLETE_DATA" : !config ? "NOT_CONFIGURED" : rows.length ? "PREVIEW" : "INSUFFICIENT_SAMPLE",
      dataAvailability: "AVAILABLE", providerCoverage: "UNKNOWN", sampleBasis: "RECORDED_CASES_ONLY", mode: "preview" });
  } catch {
    res.status(503).json({ error: "Данные проверки временно недоступны", evaluation: "DATA_UNAVAILABLE", mode: "preview" });
  }
});

investigationCasesRouter.get("/:id", async (req, res) => {
  const id = idSchema.safeParse(req.params.id);
  if (!id.success) return res.status(400).json({ error: "Неверный идентификатор" });
  const row = await prisma.investigationCase.findUnique({ where: { id: id.data }, include: {
    ...include, evidence: { orderBy: { occurredAt: "asc" } }, decisions: { orderBy: { createdAt: "asc" } },
  } });
  if (!row) return res.status(404).json({ error: "Дело не найдено" });
  const canSeePhone = can(req, "clients.viewPhone");
  res.json({ ...row, recommendation: await loadInvestigationRecommendation(row),
    evidence: row.evidence.map(item => ({ ...item, summary: phoneSafeText(item.summary, canSeePhone), payload: presentEvidencePayload(item.payload, canSeePhone) })),
    decisions: row.decisions.map(item => ({ ...item, note: phoneSafeText(item.note, canSeePhone) })),
    independentSources: new Set(row.evidence.map(e => e.independenceKey)).size,
    sourceGrouping: "PROVENANCE_GROUPS_NOT_CORROBORATION", mode: "preview" });
});

investigationCasesRouter.post("/:id/decisions", async (req, res) => {
  const id = idSchema.safeParse(req.params.id), parsed = investigationDecisionSchema.safeParse(req.body);
  if (!id.success || !parsed.success) return res.status(400).json({ error: "Укажите решение и пояснение" });
  try {
    const decision = await decideInvestigation({ ...parsed.data, caseId: id.data, actorId: req.agent!.id });
    res.json({ decision, mode: "preview" });
  } catch (error) {
    if (error instanceof InvestigationConflict) return res.status(409).json({ error: error.message });
    throw error;
  }
});
