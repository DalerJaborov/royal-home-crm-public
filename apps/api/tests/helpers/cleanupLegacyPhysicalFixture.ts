import { prisma } from "../../src/db.js";
import { legacyPhysicalDigest } from "../../src/lib/customerLegacyPhysical.js";
import { GRAPH_VERSION } from "../../src/messengers/metaGraph.js";

/** Only fixture-owned IDs, scopes and native comment IDs. No blanket reset or
 * relabeling of UNKNOWN. ACCESS EXCLUSIVE table lock and trigger restoration
 * stay in one test-only transaction; the runtime has no such cleanup API. */
export async function cleanupLegacyPhysicalFixture(input: {
  ids?: string[]; endpointScopeIds?: string[]; publicMetaCommentIds?: string[];
}): Promise<void> {
  const ids = input.ids ?? [], scopes = input.endpointScopeIds ?? [];
  const digests = (input.publicMetaCommentIds ?? []).flatMap(id => ["comments", "replies"].map(edge =>
    legacyPhysicalDigest(JSON.stringify(`/${GRAPH_VERSION}/${encodeURIComponent(id)}/${edge}`))));
  if (!ids.length && !scopes.length && !digests.length) return;
  await prisma.$transaction(async tx => {
    const owned = await tx.customerLegacyPhysicalAttempt.findMany({ where: { OR: [
      { id: { in: ids } }, { endpointScopeId: { in: scopes } },
      { endpointScopeId: null, targetDigest: { in: digests } },
    ] }, select: { id: true } });
    if (!owned.length) return;
    await tx.$executeRawUnsafe('ALTER TABLE "CustomerLegacyPhysicalAttempt" DISABLE TRIGGER "CustomerLegacyPhysicalAttempt_immutable"');
    await tx.customerLegacyPhysicalAttempt.deleteMany({ where: { id: { in: owned.map(row => row.id) } } });
    await tx.$executeRawUnsafe('ALTER TABLE "CustomerLegacyPhysicalAttempt" ENABLE TRIGGER "CustomerLegacyPhysicalAttempt_immutable"');
  });
}
