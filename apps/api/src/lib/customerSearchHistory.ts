import { prisma } from "../db.js";
import { isCustomerPrincipal, revalidateCustomerPrincipal, customerPrincipalAuthenticatedInput, type CustomerPrincipal } from "./customerPrincipal.js";
import { inspectAuthenticatedCustomerInput } from "./customerIngressAuthority.js";
import { customerDeliveryFenceSchema } from "./customerDeliveryContracts.js";
import { decodeCustomerOutboxPublicData, decodeCustomerOutboxPayload } from "./customerOutboxCodec.js";
import type { CustomerAgentSearchObservation } from "@royal-home/shared";
import { inspectPublicCommentPrincipal, revalidatePublicCommentPrincipal, type PublicCommentPrincipal } from "./publicCommentSourceIssuer.js";
import { readPublicSourceRow, publicCommentOrigin } from "./customerPublicCommentStore.js";
import { samePublicInstallation, publicCommentSourceDigest } from "./publicCommentSourceIdentity.js";

/** Actual accepted search parts, same inquiry/endpoint/ownership epoch. No
 * Profile, cross-account phone match, model-supplied exclusion or pending send.
 * Presentation memory only, never an identity, interest, consent or action. */
export async function readCustomerAcceptedSearchCollections(principal: CustomerPrincipal): Promise<Array<{
  partId: string; payloadHash: string; latestReply: boolean; text: string; observations: CustomerAgentSearchObservation[];
}>> {
  if (!isCustomerPrincipal(principal) || (await revalidateCustomerPrincipal(principal)).status !== "current") return [];
  const sourceInput = inspectAuthenticatedCustomerInput(customerPrincipalAuthenticatedInput(principal));
  if (!sourceInput) return [];
  const f = principal.authority.fence;
  const parts = await prisma.customerOutboxPart.findMany({ where: {
    inquiryId: f.inquiryId, endpointScopeId: principal.scope.endpointScopeId,
    conversationId: principal.scope.conversationId, originalNativeId: principal.scope.conversationId,
    sourceKind: "BOT_TURN", mode: "LIVE", status: "ACCEPTED", projectionRecordedAt: { not: null },
    acceptedAt: { gte: new Date(Date.now() - 7 * 86400000), lte: new Date(sourceInput.issuedAt) }, supersededAt: null, cancelRequestedAt: null,
  }, include: { attempts: { where: { outcome: "ACCEPTED", providerMid: { not: null }, finishedAt: { not: null } },
    orderBy: { attemptNo: "desc" }, take: 1 } }, orderBy: { acceptedAt: "desc" }, take: 50 });
  const result: Array<{ partId: string; payloadHash: string; latestReply: boolean; text: string; observations: CustomerAgentSearchObservation[] }> = [];
  for (const part of parts) {
    try {
      const old = customerDeliveryFenceSchema.parse(part.fenceJson), attempt = part.attempts[0];
      if (!attempt?.providerMid?.trim() || attempt.claimRevision !== part.claimRevision ||
          attempt.endpointScopeId !== principal.scope.endpointScopeId || old.inquiryId !== f.inquiryId ||
          old.endpoint.endpointScopeId !== f.endpoint.endpointScopeId || old.endpoint.peerId !== f.endpoint.peerId ||
          old.endpoint.accountId !== f.endpoint.accountId || old.ownerToken !== f.ownerToken ||
          old.endpoint.channel !== f.endpoint.channel || old.scopeRevision !== f.scopeRevision ||
          old.bindingRevision !== f.bindingRevision || old.ownershipEpoch !== f.ownershipEpoch) continue;
      const data = decodeCustomerOutboxPublicData(part), payload = decodeCustomerOutboxPayload(part);
      if (payload.kind !== "text") continue;
      const observations = data?.observations.filter(value => value.kind === "property_search") ?? [];
      if (observations.length) result.push({ partId: part.id, payloadHash: part.payloadHash, latestReply: part.id === parts[0]?.id, text: payload.text, observations });
    } catch { /* Corrupt historical data supplies no evidence of presentation. */ }
  }
  return (await revalidateCustomerPrincipal(principal)).status === "current" ? result : [];
}
export async function readCustomerShownSearchProperties(principal: CustomerPrincipal): Promise<number[]> {
  return [...new Set((await readCustomerAcceptedSearchCollections(principal)).flatMap(part =>
    part.observations.flatMap(observation => observation.cards.map(card => card.facts.shortId))))];
}

/** Same public author + exact post + verified account. Never joins a public
 * author to a private recipient or another post/account via a name/phone. */
export async function readCustomerPublicShownProperties(principal: PublicCommentPrincipal): Promise<number[]> {
  const original = inspectPublicCommentPrincipal(principal);
  if (!original || principal.source.table !== "meta" || (await revalidatePublicCommentPrincipal(principal)).status !== "current") return [];
  const source = await readPublicSourceRow(principal.source); if (!source) return [];
  const rows = await prisma.instagramComment.findMany({ where: { channel: source.channel, accountExternalId: source.targetResource,
    mediaId: source.publicationId, authorId: source.authorId, publicOriginVersion: 1, status: "REPLIED",
    repliedAt: { gte: new Date(Date.now() - 7 * 86400000) } }, orderBy: { repliedAt: "desc" }, take: 50 });
  const result = new Set<number>();
  for (const row of rows) {
    try {
      const historic = await readPublicSourceRow({ table: "meta", id: row.id });
      if (!historic || !row.replyCommentId) continue;
      const origin = publicCommentOrigin(historic);
      if (!original.currentInstallation || !samePublicInstallation(origin.proof.installation, original.currentInstallation) ||
          origin.proof.source.id !== row.id || row.publicSourceRevision !== BigInt(origin.proof.sourceRevision) + 1n ||
          origin.proof.digest !== publicCommentSourceDigest({ source: origin.proof.source, target: origin.target, text: row.text })) continue;
      const part = await prisma.customerOutboxPart.findFirst({ where: { sourceKey: `meta:${row.id}`, sourceKind: "PUBLIC_COMMENT_REPLY",
        status: "ACCEPTED", mode: "LIVE", endpointScopeId: principal.installation.id, publicSourceRevision: BigInt(origin.proof.sourceRevision),
        attempts: { some: { outcome: "ACCEPTED", providerMid: row.replyCommentId, finishedAt: { not: null } } } } });
      if (!part) continue;
      for (const value of decodeCustomerOutboxPublicData(part)?.observations ?? []) if (value.kind === "property_search") {
        for (const card of value.cards) result.add(card.facts.shortId);
      }
    } catch { /* No valid source/receipt: no presentation memory. */ }
  }
  return (await revalidatePublicCommentPrincipal(principal)).status === "current" ? [...result] : [];
}
