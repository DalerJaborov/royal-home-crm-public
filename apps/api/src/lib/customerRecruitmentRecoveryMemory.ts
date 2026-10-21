import { prisma } from "../db.js";
import { decryptSecret } from "../crypto.js";
import { recruitmentRecoveryHash } from "../ai/recruitmentRecoveryReply.js";
import { customerFenceSchema } from "@royal-home/shared";
import { readCustomerOpenVacancies } from "./recruitmentPositions.js";
import { isCustomerPrincipal, revalidateCustomerPrincipal } from "./customerPrincipal.js";
import { customerPrincipalAuthenticatedInput } from "./customerPrincipal.js";
import { inspectAuthenticatedCustomerInput } from "./customerIngressAuthority.js";

/** Accepted owner-approved bot correction only. No fake customer IN, action
 * receipt, contact join or inferred permission. Future tools still need IN. */
export async function readCustomerRecruitmentRecoveryMemory(principal: unknown) {
  const result: Array<{ role: "assistant"; text: string; observedAt: number; stableKey: string }> = [];
  if (!isCustomerPrincipal(principal) || (await revalidateCustomerPrincipal(principal)).status !== "current") return result;
  const input = customerPrincipalAuthenticatedInput(principal);
  const original = input && inspectAuthenticatedCustomerInput(input);
  if (!original) return result;
  const rows = await prisma.$queryRaw<Array<{ id: string; payloadEncrypted: string; payloadHash: string; fenceJson: unknown;
    catalogHash: string; finishedAt: Date }>>`SELECT "id","payloadEncrypted","payloadHash","fenceJson","catalogHash","finishedAt"
    FROM "RecruitmentRecovery" WHERE "conversationId"=${principal.scope.conversationId} AND "endpointScopeId"=${principal.scope.endpointScopeId}
      AND "status"='ACCEPTED' AND "providerMid" IS NOT NULL AND "projectionAt" IS NOT NULL AND "finishedAt"<=${new Date(original.issuedAt)}
    ORDER BY "finishedAt" DESC LIMIT 2`;
  if (!rows.length) return result;
  const catalog = await readCustomerOpenVacancies();
  for (const row of rows) {
    const old = customerFenceSchema.safeParse(row.fenceJson), current = principal.authority.fence;
    if (!old.success || old.data.inquiryId !== current.inquiryId || old.data.nativeId !== current.nativeId || old.data.ownerToken !== current.ownerToken ||
      old.data.ownershipEpoch !== current.ownershipEpoch || old.data.bindingRevision !== current.bindingRevision ||
      old.data.scopeRevision !== current.scopeRevision || row.catalogHash !== catalog.sourceHash) continue;
    try {
      const text = decryptSecret(row.payloadEncrypted);
      if (recruitmentRecoveryHash({ text }) !== row.payloadHash) continue;
      // Preserve the accepted correction/topic without crowding out the next
      // customer's words with a full conditions sheet. Current facts are reread.
      result.push({ role: "assistant", text: text.split("\n").slice(0, 3).join("\n"), observedAt: row.finishedAt.getTime(), stableKey: `recruitment-correction:${row.id}` });
    } catch { /* Corrupt historical data grants nothing. */ }
  }
  return (await revalidateCustomerPrincipal(principal)).status === "current" ? result : [];
}
