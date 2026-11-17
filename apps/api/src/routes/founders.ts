import { Router, type Response } from "express";
import { requireAuth, requirePermission } from "../auth/middleware.js";
import { logAudit } from "../lib/audit.js";
import {
  createContribution, createFounder, deleteContribution, deleteFounder, founderTotals, FounderCommandError, listContributions,
  listFounders, restoreContribution, restoreFounder, updateContribution, updateFounder,
} from "../lib/founderContributions.js";

/**
 * Учредители и их взносы (17.11.2026) — раздел Деньги → Учредители.
 * Читать — право «Финансы» (finance.view), записывать — finance.manage, как расходы.
 */
export const foundersRouter = Router();
foundersRouter.use(requireAuth, requirePermission("finance.view"));
const write = requirePermission("finance.manage");

function failed(res: Response, err: unknown): boolean {
  if (!(err instanceof FounderCommandError)) return false;
  res.status(err.status).json(err.body);
  return true;
}

foundersRouter.get("/", async (req, res) => {
  res.json(await listFounders({ includeDeleted: req.query.includeDeleted === "1" || req.query.includeDeleted === "true" }));
});

foundersRouter.get("/totals", async (req, res) => {
  try {
    res.json(await founderTotals(String(req.query.month ?? "")));
  } catch (err) { if (!failed(res, err)) throw err; }
});

foundersRouter.get("/contributions", async (req, res) => {
  try {
    res.json(await listContributions(req.query));
  } catch (err) { if (!failed(res, err)) throw err; }
});

foundersRouter.post("/contributions", write, async (req, res) => {
  try {
    const key = req.get("Idempotency-Key");
    const requestKey = key && /^[A-Za-z0-9:_-]{8,120}$/.test(key) ? `${req.agent!.id}:${key}` : undefined;
    const row = await createContribution(req.body, { agentId: req.agent!.id, requestKey });
    logAudit(req, "FOUNDER_CONTRIBUTION_CREATE", "FounderContribution", row.id, { founderId: row.founderId, amount: row.amount, currency: row.currency, date: row.date });
    res.status(201).json(row);
  } catch (err) { if (!failed(res, err)) throw err; }
});

foundersRouter.patch("/contributions/:id", write, async (req, res) => {
  try {
    const row = await updateContribution(req.params.id, req.body);
    logAudit(req, "UPDATE", "FounderContribution", row.id, { changed: Object.keys(req.body ?? {}) });
    res.json(row);
  } catch (err) { if (!failed(res, err)) throw err; }
});

foundersRouter.delete("/contributions/:id", write, async (req, res) => {
  try {
    const row = await deleteContribution(req.params.id);
    logAudit(req, "DELETE", "FounderContribution", row.id, { founderId: row.founderId, amount: row.amount.toString() });
    res.status(204).end();
  } catch (err) { if (!failed(res, err)) throw err; }
});

foundersRouter.patch("/contributions/:id/restore", write, async (req, res) => {
  try {
    const row = await restoreContribution(req.params.id);
    logAudit(req, "RESTORE", "FounderContribution", row.id, {});
    res.json(row);
  } catch (err) { if (!failed(res, err)) throw err; }
});

foundersRouter.post("/", write, async (req, res) => {
  try {
    const row = await createFounder(req.body);
    logAudit(req, "FOUNDER_CREATE", "Founder", row.id, { name: row.name });
    res.status(201).json(row);
  } catch (err) { if (!failed(res, err)) throw err; }
});

foundersRouter.patch("/:id", write, async (req, res) => {
  try {
    const row = await updateFounder(req.params.id, req.body);
    logAudit(req, "UPDATE", "Founder", row.id, { changed: Object.keys(req.body ?? {}) });
    res.json(row);
  } catch (err) { if (!failed(res, err)) throw err; }
});

foundersRouter.delete("/:id", write, async (req, res) => {
  try {
    const row = await deleteFounder(req.params.id);
    logAudit(req, "DELETE", "Founder", row.id, { name: row.name });
    res.json(row);
  } catch (err) { if (!failed(res, err)) throw err; }
});

foundersRouter.patch("/:id/restore", write, async (req, res) => {
  try {
    const row = await restoreFounder(req.params.id);
    logAudit(req, "RESTORE", "Founder", row.id, { name: row.name });
    res.json(row);
  } catch (err) { if (!failed(res, err)) throw err; }
});
