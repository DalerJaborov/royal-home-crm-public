import { z } from "zod";
import { encryptSecret, decryptSecret } from "../crypto.js";
import { prisma } from "../db.js";
import { customerAgentClaimCurrentTx, type CustomerAgentClaim } from "./customerAgentClaim.js";
import { customerAgentMediaPerceptionSchema, type CustomerAgentMediaPerception } from "../ai/customerAgentMediaPerception.js";

const contextSchema = z.object({ version: z.literal(1), eventKey: z.string().regex(/^[a-f0-9]{64}$/),
  payloadHash: z.string().regex(/^[a-f0-9]{64}$/), agentRevisionId: z.string().regex(/^[a-f0-9]{64}$/),
  providerOperationId: z.string().uuid(), observedAt: z.number().int().nonnegative() }).strict();
type Context = z.infer<typeof contextSchema>;
const envelopeSchema = z.object({ context: contextSchema, perception: customerAgentMediaPerceptionSchema }).strict();
export function decodeCustomerAgentMediaObservation(ciphertext: string, expected: Context): CustomerAgentMediaPerception {
  if (ciphertext.length > 80000) throw new Error("Media observation exceeds limit");
  const value = envelopeSchema.parse(JSON.parse(decryptSecret(ciphertext)));
  if (JSON.stringify(value.context) !== JSON.stringify(contextSchema.parse(expected))) throw new Error("Media observation binding mismatch");
  return value.perception;
}
export async function loadCustomerAgentMediaObservation(claim: CustomerAgentClaim): Promise<CustomerAgentMediaPerception | null> {
  if (!await customerAgentClaimCurrentTx(prisma, claim)) throw new Error("Original media claim changed");
  const row = await prisma.customerPropertyIngressTicket.findUnique({ where: { eventKey: claim.eventKey }, select: {
    payloadHash: true, mediaObservationVersion: true, mediaObservationCiphertext: true, mediaObservedAt: true,
  } });
  if (!row || !row.payloadHash) throw new Error("Media input missing");
  if (row.mediaObservationVersion === null && row.mediaObservationCiphertext === null && row.mediaObservedAt === null) return null;
  if (row.mediaObservationVersion !== 1 || !row.mediaObservationCiphertext || !row.mediaObservedAt) throw new Error("Media observation incomplete");
  return decodeCustomerAgentMediaObservation(row.mediaObservationCiphertext, { version: 1, eventKey: claim.eventKey,
    payloadHash: row.payloadHash, agentRevisionId: claim.pin.agentRevisionId, providerOperationId: claim.pin.providerOperationId,
    observedAt: row.mediaObservedAt.getTime() });
}
export async function storeCustomerAgentMediaObservation(claim: CustomerAgentClaim, raw: CustomerAgentMediaPerception): Promise<void> {
  const perception = customerAgentMediaPerceptionSchema.parse(raw);
  await prisma.$transaction(async tx => {
    if (!await customerAgentClaimCurrentTx(tx, claim)) throw new Error("Original media claim changed");
    const [row] = await tx.$queryRaw<Array<{ payloadHash: string | null; mediaObservationCiphertext: string | null; observedAt: Date }>>`
      SELECT "payloadHash","mediaObservationCiphertext",
        date_trunc('milliseconds', clock_timestamp() AT TIME ZONE 'UTC') AS "observedAt"
      FROM "CustomerPropertyIngressTicket" WHERE "eventKey"=${claim.eventKey} FOR UPDATE`;
    if (!row?.payloadHash || row.mediaObservationCiphertext) throw new Error("Immutable original media observation");
    // The immutable-write trigger uses the database clock. An application
    // clock even a fraction ahead must not make a genuine perception future
    // dated. Truncate to the column's millisecond precision without rounding up.
    const observedAt = row.observedAt;
    const context: Context = { version: 1, eventKey: claim.eventKey, payloadHash: row.payloadHash,
      agentRevisionId: claim.pin.agentRevisionId, providerOperationId: claim.pin.providerOperationId, observedAt: observedAt.getTime() };
    const ciphertext = encryptSecret(JSON.stringify({ context, perception }));
    const count = await tx.$executeRaw`UPDATE "CustomerPropertyIngressTicket" SET "mediaObservationVersion"=1,
      "mediaObservationCiphertext"=${ciphertext},"mediaObservedAt"=${observedAt}
      WHERE "eventKey"=${claim.eventKey} AND "leaseOwner"=${claim.owner} AND "claimRevision"=${BigInt(claim.revision)}
      AND "processingState"='CLAIMED' AND "mediaObservationCiphertext" IS NULL`;
    if (count !== 1 || !await customerAgentClaimCurrentTx(tx, claim)) throw new Error("Original media claim changed");
  });
}
