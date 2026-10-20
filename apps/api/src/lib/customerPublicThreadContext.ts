import { type CustomerAgentVerifiedContext, type CustomerAgentRevision } from "@royal-home/shared";
import { prisma } from "../db.js";
import { inspectPublicCommentPrincipal, revalidatePublicCommentPrincipal, type PublicCommentPrincipal } from "./publicCommentSourceIssuer.js";
import { publicCommentOrigin, readPublicSourceRow } from "./customerPublicCommentStore.js";
import { samePublicInstallation, publicCommentSourceDigest } from "./publicCommentSourceIdentity.js";
import { decodeCustomerOutboxPayload } from "./customerOutboxCodec.js";
import { projectCustomerAgentMemory, type CustomerAgentMemoryCandidate } from "./customerAgentVerifiedContext.js";

/** Explicit ancestor chain only, same author/account/publication and genuine
 * source origin. Never reads DM, a neighbour's comment or a global thread cache.
 * Older utterances remain untrusted data, not consent or verified house facts. */
export async function loadCustomerPublicThreadContext(principal: PublicCommentPrincipal, revision: Readonly<CustomerAgentRevision>): Promise<CustomerAgentVerifiedContext | undefined> {
  const original = inspectPublicCommentPrincipal(principal);
  if (!original || principal.source.table !== "meta" || !principal.target.parentId ||
      (await revalidatePublicCommentPrincipal(principal)).status !== "current") return undefined;
  const source = await readPublicSourceRow(principal.source);
  if (!source) return undefined;
  const candidates: CustomerAgentMemoryCandidate[] = [], seen = new Set<string>([source.commentId]);
  let parent: string | null = source.parentId;
  for (let depth = 0; parent && depth < 3; depth++) {
    if (seen.has(parent)) break; seen.add(parent);
    const row = await prisma.instagramComment.findFirst({ where: {
      channel: source.channel, accountExternalId: source.targetResource, mediaId: source.publicationId,
      authorId: source.authorId, OR: [{ commentId: parent }, { replyCommentId: parent }],
      publicOriginVersion: 1, publicOriginCiphertext: { not: null },
    }, orderBy: { createdAt: "desc" } });
    if (!row) break;
    try {
      const historic = await readPublicSourceRow({ table: "meta", id: row.id });
      if (!historic) break;
      const origin = publicCommentOrigin(historic);
      if (!original.currentInstallation || !samePublicInstallation(origin.proof.installation, original.currentInstallation) ||
          origin.target.publicationId !== source.publicationId || origin.target.commentId !== row.commentId ||
          origin.target.accountExternalId !== source.targetResource ||
          origin.proof.source.id !== historic.id || origin.proof.source.table !== "meta" ||
          origin.proof.digest !== publicCommentSourceDigest({ source: origin.proof.source, target: origin.target, text: row.text })) break;
      const accepted = row.status === "REPLIED" && row.replyText && row.replyCommentId ? await prisma.customerOutboxPart.findFirst({ where: {
        sourceKey: `meta:${row.id}`, sourceKind: "PUBLIC_COMMENT_REPLY", status: "ACCEPTED", mode: "LIVE",
        endpointScopeId: principal.installation.id, publicSourceRevision: BigInt(origin.proof.sourceRevision),
        attempts: { some: { outcome: "ACCEPTED", providerMid: row.replyCommentId, finishedAt: { not: null } } },
      } }) : null;
      // Terminal projection intentionally advances source revision once. Match
      // the ACCEPTED part to its ORIGINAL revision; edits after that projection
      // advance it again and must not become historical customer context.
      const projected = row.status === "REPLIED" && accepted &&
        row.publicSourceRevision === BigInt(origin.proof.sourceRevision) + 1n;
      if (!projected && historic.sourceRevision !== origin.proof.sourceRevision) break;
      candidates.push({ role: "user", text: row.text, observedAt: row.createdAt.getTime(), stableKey: `in:${row.id}` });
      if (accepted?.acceptedAt && row.replyText) {
        const payload = decodeCustomerOutboxPayload(accepted);
        if (payload.kind === "text" && payload.text === row.replyText) candidates.push({ role: "assistant", text: row.replyText,
          observedAt: accepted.acceptedAt.getTime(), stableKey: `out:${row.id}` });
      }
      parent = row.parentId;
    } catch { break; }
  }
  if ((await revalidatePublicCommentPrincipal(principal)).status !== "current") return undefined;
  return { surface: "public_comment", revisionId: revision.id, turns: projectCustomerAgentMemory(candidates, revision.limits.maxInputChars),
    publicState: { language: "unknown", topic: "unknown", openQuestion: "none" } };
}
