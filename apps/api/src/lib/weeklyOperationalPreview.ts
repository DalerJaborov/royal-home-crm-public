import type { WeeklyOperationalPreviewKind, WeeklyOperationalPreviewPage, WeeklyOperationalPreviewItem } from '@royal-home/shared';
import { Prisma } from '../generated/prisma/client.js';
import { prisma } from '../db.js';
const DAY = 86_400_000;
/** Read-only snapshot; absence in these ledgers is not proof of absence outside CRM.
 * No severity, score, assignment, case, notification or provider writes. */
export function weeklyOperationalSourceSql(kind: WeeklyOperationalPreviewKind, now: Date): Prisma.Sql {
  const week = new Date(now.getTime() - 7 * DAY); const fortnight = new Date(now.getTime() - 14 * DAY);
  if (kind === 'DEFERRED_AFTER_SHOWING') return Prisma.sql`
    SELECT c.id, c.id AS "clientId", s."propertyId", c."assignedAgentId" AS "agentId", a."fullName" AS "agentName",
      c."deferredAt" AS "observedAt", s.id AS "sourceId", 'Interaction'::text AS "sourceType"
    FROM "Client" c LEFT JOIN "Agent" a ON a.id = c."assignedAgentId"
    JOIN LATERAL (SELECT i.id, i."propertyId" FROM "Interaction" i WHERE i."clientId" = c.id
      AND i.type = 'SHOWING' AND i."investigationOnly" = false AND i."taskCancelledAt" IS NULL AND i."declinedAt" IS NULL
      AND i."propertyId" IS NOT NULL AND i."completedAt" IS NOT NULL AND i."completedAt" <= c."deferredAt"
      AND i."nextActionDate" >= c."assignedAt" AND i."nextActionDate" <= c."deferredAt"
      ORDER BY i."nextActionDate" DESC, i.id DESC LIMIT 1) s ON true
    WHERE c."deletedAt" IS NULL AND c."workStatus" = 'DEFERRED'
      AND c."deferredAt" >= ${week} AND c."deferredAt" <= ${now}`;
  if (kind === 'PROPERTY_NO_RECORDED_ACTIVITY') return Prisma.sql`
    SELECT p.id, p."sellerClientId" AS "clientId", p.id AS "propertyId", p."assignedAgentId" AS "agentId", a."fullName" AS "agentName",
      GREATEST(p."createdAt", p."listingAcceptedAt") AS "observedAt", p.id AS "sourceId", 'Property'::text AS "sourceType"
    FROM "Property" p LEFT JOIN "Agent" a ON a.id = p."assignedAgentId"
    WHERE p."deletedAt" IS NULL AND p.status = 'AVAILABLE' AND GREATEST(p."createdAt", p."listingAcceptedAt") <= ${fortnight}
      AND NOT EXISTS (SELECT 1 FROM "PropertyExposure" e WHERE e."propertyId" = p.id AND e."sentAt" >= ${fortnight})
      AND NOT EXISTS (SELECT 1 FROM "Interaction" i WHERE i."investigationOnly" = false AND i."taskCancelledAt" IS NULL AND i."declinedAt" IS NULL
        AND ((i.type = 'SHOWING' AND i."propertyId" = p.id AND (i."createdAt" >= ${fortnight} OR i."nextActionDate" >= ${fortnight}))
          OR (i.type = 'CALL' AND i."clientId" = p."sellerClientId" AND i."createdAt" >= ${fortnight})))
      AND NOT EXISTS (SELECT 1 FROM "Client" c WHERE c.id = p."sellerClientId" AND c."lastClientMessageAt" >= ${fortnight})`;
  return Prisma.sql`
    SELECT d.id, d."clientId", d."propertyId", d."agentId", a."fullName" AS "agentName", d."startedAt" AS "observedAt", d.id AS "sourceId", 'Deal'::text AS "sourceType"
    FROM "Deal" d JOIN "Property" p ON p.id = d."propertyId" LEFT JOIN "Agent" a ON a.id = d."agentId"
    WHERE d.stage NOT IN ('COMPLETED', 'CANCELLED') AND p."deletedAt" IS NULL AND d."startedAt" <= ${fortnight}
      AND NOT EXISTS (SELECT 1 FROM "AuditLog" l WHERE l."entityType" = 'Deal' AND l."entityId" = d.id AND l."createdAt" >= ${fortnight})
      AND NOT EXISTS (SELECT 1 FROM "DealDocument" doc WHERE doc."dealId" = d.id AND doc."uploadedAt" >= ${fortnight})
      AND NOT EXISTS (SELECT 1 FROM "Interaction" i WHERE i."clientId" = d."clientId" AND i."investigationOnly" = false AND i."createdAt" >= ${fortnight})
      AND NOT EXISTS (SELECT 1 FROM "Client" c WHERE c.id = d."clientId" AND c."lastClientMessageAt" >= ${fortnight})
      AND NOT EXISTS (SELECT 1 FROM "PropertyExposure" e WHERE e."propertyId" = d."propertyId" AND e."clientId" = d."clientId" AND e."sentAt" >= ${fortnight})
    UNION ALL
    SELECT p.id, p."reservedForClientId" AS "clientId", p.id AS "propertyId", p."assignedAgentId" AS "agentId", a."fullName" AS "agentName",
      p."reservedAt" AS "observedAt", p.id AS "sourceId", 'Reservation'::text AS "sourceType"
    FROM "Property" p LEFT JOIN "Agent" a ON a.id = p."assignedAgentId"
    WHERE p.status = 'RESERVED' AND p."deletedAt" IS NULL AND p."reservedAt" <= ${fortnight}
      AND NOT EXISTS (SELECT 1 FROM "Deal" d WHERE d."propertyId" = p.id AND d.stage NOT IN ('COMPLETED', 'CANCELLED'))
      AND NOT EXISTS (SELECT 1 FROM "AuditLog" l WHERE l."entityType" = 'Property' AND l."entityId" = p.id AND l."createdAt" >= ${fortnight})
      AND NOT EXISTS (SELECT 1 FROM "Interaction" i WHERE i."investigationOnly" = false AND i."createdAt" >= ${fortnight}
        AND (i."propertyId" = p.id OR i."clientId" = p."reservedForClientId"))
      AND NOT EXISTS (SELECT 1 FROM "Client" c WHERE c.id = p."reservedForClientId" AND c."lastClientMessageAt" >= ${fortnight})`;
}
export async function previewWeeklyOperations(kind: WeeklyOperationalPreviewKind, page: number, now = new Date()): Promise<WeeklyOperationalPreviewPage> {
  const source = weeklyOperationalSourceSql(kind, now); const pageSize = 25;
  const [rows, counts] = await Promise.all([
    prisma.$queryRaw<Array<Omit<WeeklyOperationalPreviewItem, 'observedAt'> & { observedAt: Date }>>(Prisma.sql`SELECT * FROM (${source}) evidence ORDER BY "observedAt" DESC, id LIMIT ${pageSize} OFFSET ${(page - 1) * pageSize}`),
    prisma.$queryRaw<Array<{ count: bigint }>>(Prisma.sql`SELECT count(*) AS count FROM (${source}) evidence`),
  ]);
  return { mode: 'PREVIEW', kind, generatedAt: now.toISOString(), periodStart: new Date(now.getTime() - (kind === 'DEFERRED_AFTER_SHOWING' ? 7 : 14) * DAY).toISOString(),
    page, pageSize, total: Number(counts[0]?.count ?? 0), coverage: 'RECORDED_CRM_FACTS_ONLY', items: rows.map(row => ({ ...row, observedAt: row.observedAt.toISOString() })) };
}
