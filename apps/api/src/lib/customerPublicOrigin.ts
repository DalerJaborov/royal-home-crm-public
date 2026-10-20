import { randomUUID } from "node:crypto";
import { z } from "zod";
import { Prisma } from "../generated/prisma/client.js";
import { publicCommentTargetSchema, publicSourceProofSchema,
  type PublicCommentTarget, type PublicSourceProof } from "@royal-home/shared";
import { encryptSecret, decryptSecret } from "../crypto.js";
import type { TxClient } from "../db.js";
import { isActiveTransactionClient } from "./transactionScope.js";
import { customerAgentTurnDeadline, decodeCustomerAgentRevision } from "./customerAgentRevision.js";
import { publicCommentSourceDigest } from "./publicCommentSourceIdentity.js";

const originSchema = z.object({ version: z.literal(1), purpose: z.literal("customer_public_origin"),
  proof: publicSourceProofSchema, target: publicCommentTargetSchema,
  originalReceivedAt: z.number().int().nonnegative(),
  agentPin: z.object({ agentRevisionId: z.string().regex(/^[a-f0-9]{64}$/),
    providerOperationId: z.string().uuid(), providerDeadlineAt: z.number().int().nonnegative() }).strict(),
}).strict().superRefine((value, ctx) => {
  if (value.agentPin.providerDeadlineAt <= value.originalReceivedAt ||
      value.agentPin.providerDeadlineAt > value.originalReceivedAt + 900_000 ||
      value.proof.installation.channel !== value.target.channel ||
      value.proof.installation.resourceId !== value.target.accountExternalId ||
      (value.proof.source.table === "telegram") !== (value.target.channel === "TELEGRAM")) {
    ctx.addIssue({ code: "custom", message: "Public origin identity/deadline mismatch" });
  }
});
export type CustomerPublicOrigin = Readonly<z.infer<typeof originSchema>>;

/** Audit decoding does not grant a send and deliberately does not renew time.
 * The concrete issuer rechecks source, credential epoch, policy and expiry. */
export function decodePublicOrigin(row: { version: number | null; ciphertext: string | null; capturedAt: Date | null }): CustomerPublicOrigin {
  if (row.version !== 1 || !row.ciphertext || row.ciphertext.length > 100_000 || !row.capturedAt) {
    throw new TypeError("Verified public origin unavailable");
  }
  const value = originSchema.parse(JSON.parse(decryptSecret(row.ciphertext)));
  if (row.capturedAt.getTime() !== value.originalReceivedAt) throw new TypeError("Public origin timestamp mismatch");
  return value;
}

interface SourceRow { channel: string; resource: string | null; publicationId: string; commentId: string;
  parentId: string | null; text: string; revision: bigint; originVersion: number | null }
/** Internal encoder called ONLY inside actual producer capture. Parsed proof
 * JSON alone is not a principal; no exported delivery factory accepts it.
 * Scope registration must finish in a separate tx before this source lock. */
export async function preparePublicOriginTx(tx: TxClient, raw: {
  proof: PublicSourceProof; target: PublicCommentTarget; originalReceivedAt: number; expectedRevisionId?: string;
}): Promise<{ version: 1; ciphertext: string; capturedAt: Date }> {
  if (!isActiveTransactionClient(tx)) throw new TypeError("Active source transaction required");
  const proof = publicSourceProofSchema.parse(raw.proof), target = publicCommentTargetSchema.parse(raw.target);
  const receivedAt = z.number().int().nonnegative().parse(raw.originalReceivedAt), now = Date.now();
  if (receivedAt > now || now - receivedAt >= 900_000) throw new TypeError("Original public input expired");
  const rows = proof.source.table === "meta" ? await tx.$queryRaw<SourceRow[]>(Prisma.sql`
    SELECT "channel","accountExternalId" AS resource,"mediaId" AS "publicationId","commentId","parentId","text",
      "publicSourceRevision" AS revision,"publicOriginVersion" AS "originVersion" FROM "InstagramComment"
    WHERE "id"=${proof.source.id} FOR UPDATE`)
    : await tx.$queryRaw<SourceRow[]>(Prisma.sql`
    SELECT 'TELEGRAM' AS channel,"groupChatId" AS resource,"postMessageId" AS "publicationId","messageId" AS "commentId",
      NULL::text AS "parentId","text","publicSourceRevision" AS revision,"publicOriginVersion" AS "originVersion"
    FROM "TelegramGroupComment" WHERE "id"=${proof.source.id} FOR UPDATE`);
  const source = rows[0];
  const expectedOrigin = target.channel === "TELEGRAM" ? "telegram_verified_discussion_update" :
    target.channel === "YOUTUBE" ? "youtube_own_channel_poll" : "meta_verified_comment";
  if (!source || source.originVersion !== null || source.revision.toString() !== proof.sourceRevision ||
      source.channel !== target.channel || source.resource !== target.accountExternalId ||
      source.publicationId !== target.publicationId || source.commentId !== target.commentId ||
      (target.channel !== "TELEGRAM" && source.parentId !== target.parentId) || proof.origin !== expectedOrigin ||
      publicCommentSourceDigest({ source: proof.source, target, text: source.text }) !== proof.digest) {
    throw new TypeError("Original public source changed");
  }
  const [scope] = await tx.$queryRaw<Array<{ kind: string; realmKey: string; channel: string; transportKey: string;
    messengerAccountId: string | null; scopeRevision: bigint; publicResourceId: string | null; publicCredentialFingerprint: string | null }>>`
    SELECT "kind","realmKey","channel","transportKey","messengerAccountId","scopeRevision","publicResourceId","publicCredentialFingerprint"
    FROM "CustomerEndpointScope" WHERE "id"=${proof.installation.id} FOR SHARE`;
  if (!scope || scope.kind !== "PUBLIC" || scope.realmKey !== "customer-public" || scope.channel !== target.channel ||
      scope.scopeRevision.toString() !== proof.installation.revision || scope.messengerAccountId !== proof.installation.accountId ||
      scope.publicResourceId !== target.accountExternalId || scope.transportKey !== proof.installation.transportKey ||
      scope.transportKey !== `public:${target.channel}:${target.accountExternalId}` || !scope.publicCredentialFingerprint ||
      proof.installation.channel !== target.channel || proof.installation.resourceId !== target.accountExternalId) {
    throw new TypeError("Original public installation changed");
  }
  const [policy] = await tx.$queryRaw<Array<{ policyRevision: bigint; activeAgentRevisionId: string | null }>>`
    SELECT "policyRevision","activeAgentRevisionId" FROM "CustomerRuntimePolicy" WHERE "id"='singleton' FOR SHARE`;
  if (!policy || policy.policyRevision.toString() !== proof.policyRevision || !policy.activeAgentRevisionId) {
    throw new TypeError("Public revision is not configured");
  }
  if (raw.expectedRevisionId && policy.activeAgentRevisionId !== raw.expectedRevisionId) throw new TypeError("Original rollout revision changed");
  const [row] = await tx.$queryRaw<Array<{ id: string; manifestJson: unknown }>>`
    SELECT "id","manifestJson" FROM "CustomerAgentRevision" WHERE "id"=${policy.activeAgentRevisionId}`;
  if (!row) throw new TypeError("Public revision unavailable");
  const revision = decodeCustomerAgentRevision(row), deadlineAt = customerAgentTurnDeadline(receivedAt, revision.limits.deadlineMs);
  if (Date.now() >= deadlineAt) throw new TypeError("Original public input expired");
  const envelope = originSchema.parse({ version: 1, purpose: "customer_public_origin", proof, target,
    originalReceivedAt: receivedAt, agentPin: { agentRevisionId: revision.id, providerOperationId: randomUUID(), providerDeadlineAt: deadlineAt } });
  return { version: 1, ciphertext: encryptSecret(JSON.stringify(envelope)), capturedAt: new Date(receivedAt) };
}
