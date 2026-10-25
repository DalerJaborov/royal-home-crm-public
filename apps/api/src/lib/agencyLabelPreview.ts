import type { AgencyLabelCoincidence, AgencyLabelPreview } from '@royal-home/shared';
import { prisma } from '../db.js';
interface Source { id: string; entityId: string | null; meta: unknown; createdAt: Date }
/** Exact structured producer fields only. No aliases, fuzzy company matching or
 * narrative extraction. Distinct clients prevent repeated clicks counting twice. */
export function groupAgencyLabelCoincidences(rows: Source[]): AgencyLabelCoincidence[] {
  const groups = new Map<string, { agentId: string; labels: Set<string>; clients: Set<string>; sources: Set<string>; latestAt: Date }>();
  for (const row of rows) {
    if (!row.entityId || !row.meta || typeof row.meta !== 'object' || Array.isArray(row.meta)) continue;
    const meta = row.meta as Record<string, unknown>;
    if (typeof meta.competitorName !== 'string' || typeof meta.assignedAgentId !== 'string' || !meta.assignedAgentId) continue;
    const label = meta.competitorName.trim(); if (!label || label.length > 200) continue;
    const key = JSON.stringify([meta.assignedAgentId, label.normalize('NFC').toLowerCase()]);
    const group = groups.get(key) ?? { agentId: meta.assignedAgentId, labels: new Set<string>(), clients: new Set<string>(), sources: new Set<string>(), latestAt: row.createdAt };
    group.labels.add(label); group.clients.add(row.entityId); group.sources.add(row.id);
    if (row.createdAt > group.latestAt) group.latestAt = row.createdAt;
    groups.set(key, group);
  }
  return [...groups.values()].filter(group => group.clients.size >= 2).map(group => ({ agentId: group.agentId, originalLabels: [...group.labels], distinctClients: group.clients.size,
    sourceIds: [...group.sources], clientIds: [...group.clients], latestAt: group.latestAt.toISOString(), companyIdentity: 'UNKNOWN' as const })).sort((a, b) => b.latestAt.localeCompare(a.latestAt));
}
export async function previewAgencyLabelCoincidences(now = new Date()): Promise<AgencyLabelPreview> {
  const from = new Date(now.getTime() - 90 * 86400000);
  const rows = await prisma.auditLog.findMany({ where: { action: 'CLIENT_REFUSE', entityType: 'Client', createdAt: { gte: from, lte: now } },
    select: { id: true, entityId: true, meta: true, createdAt: true }, orderBy: [{ createdAt: 'desc' }, { id: 'desc' }], take: 1001 });
  return { mode: 'PREVIEW', from: from.toISOString(), to: now.toISOString(), truncated: rows.length > 1000, sourceRows: Math.min(rows.length, 1000), groups: groupAgencyLabelCoincidences(rows.slice(0, 1000)) };
}
