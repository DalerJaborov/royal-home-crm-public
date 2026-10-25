import { prisma } from "../db.js";

/** Ownership belongs to the client, not the agent who manages the property.
 * Read persisted links so narrow property projections cannot accidentally omit this exclusion.
 * Unsaved previews have no persisted owner and remain eligible for ordinary matching.
 */
export async function matchingPropertySellers(propertyIds: string[]): Promise<Map<string, string>> {
  if (propertyIds.length === 0) return new Map();
  const rows = await prisma.property.findMany({
    where: { id: { in: [...new Set(propertyIds)] }, sellerClientId: { not: null } },
    select: { id: true, sellerClientId: true },
  });
  return new Map(rows.flatMap((row) => row.sellerClientId ? [[row.id, row.sellerClientId] as const] : []));
}
