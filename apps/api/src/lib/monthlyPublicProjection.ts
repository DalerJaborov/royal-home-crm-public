import { prisma } from "../db.js";
import { COUNTED_SHOWING_WHERE } from "./tasks.js";
import { monthRange } from "./monthlyReport.js";

const LIMIT = 20000;
/** Read projection only: surviving public events, never a rewrite of the historical snapshot. */
export async function projectMonthlyPublicInteractions(metrics: unknown, periodStart: Date): Promise<unknown> {
  if (!metrics || typeof metrics !== "object" || Array.isArray(metrics)) return metrics;
  const m = metrics as Record<string, unknown>;
  if (m.publicInteractionScopeVersion === 1) return m;
  const { from, to } = monthRange(periodStart);
  const rows = await prisma.interaction.findMany({ where: {
    investigationOnly: false, client: { deletedAt: null }, createdAt: { gte: from, lt: to },
    OR: [{ type: { in: ["CALL", "MESSAGE", "MEETING"] } }, { type: "SHOWING", ...COUNTED_SHOWING_WHERE }],
  }, select: { type: true, clientId: true, agentId: true, subjectAgentId: true }, take: LIMIT + 1 }).catch(() => null);
  const known = rows !== null && rows.length <= LIMIT;
  const contacts = new Set<string>(), shown = new Set<string>(), byAgent = new Map<string, number>();
  if (known) for (const row of rows) {
    if (row.type !== "SHOWING") contacts.add(row.clientId);
    else { shown.add(row.clientId); const holder = row.agentId ?? row.subjectAgentId; if (holder) byAgent.set(holder, (byAgent.get(holder) ?? 0) + 1); }
  }
  return { ...m, publicInteractionScopeVersion: 1,
    publicInteractionCountersBasis: known ? "CURRENT_RECORDED_PUBLIC_EVENTS" : "UNAVAILABLE",
    funnel: Array.isArray(m.funnel) ? m.funnel.map((row: Record<string, unknown>) => row.key === "contacted" || row.key === "showings" ? { ...row, count: known ? (row.key === "contacted" ? contacts.size : shown.size) : null } : row) : m.funnel,
    agents: Array.isArray(m.agents) ? m.agents.map((row: Record<string, unknown>): Record<string, unknown> => ({ ...row, showings: known ? byAgent.get(String(row.agentId)) ?? 0 : null })).filter(row => row.leads || row.showings || row.deals || row.commission) : m.agents,
  };
}
