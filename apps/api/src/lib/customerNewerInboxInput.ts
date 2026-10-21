import { prisma, type TxClient } from "../db.js";
import { decryptCustomerIngressEnvelope } from "./customerIngressPayload.js";

type Pending = { eventKey: string; order: bigint; scopeKey: string; endpointScopeId: string | null;
  payloadHash: string | null; payloadCiphertext: string | null };
/** Supersession observation only. A newer genuine signed input can stop an
 * older response before FINAL is processed by a busy worker. This does not
 * append/accept that input, refresh age, select an owner or grant any action. */
export async function hasNewerCustomerInboxInput(eventKey: string, db: Pick<TxClient, "$queryRaw"> = prisma): Promise<boolean> {
  const rows = await db.$queryRaw<Pending[]>`SELECT n."eventKey",n."order",n."scopeKey",n."endpointScopeId",n."payloadHash",n."payloadCiphertext"
    FROM "CustomerPropertyIngressTicket" n JOIN "CustomerPropertyIngressTicket" original ON original."eventKey"=${eventKey}
    WHERE n."scopeKey"=original."scopeKey" AND n."endpointScopeId"=original."endpointScopeId" AND n."order">original."order"
      AND n."payloadVersion"=1 AND n."intakeAgentRevisionId" IS NOT NULL AND n."tombstonedAt" IS NULL
    ORDER BY n."order" DESC LIMIT 8`;
  for (const row of rows) {
    if (!row.endpointScopeId || !row.payloadHash || !row.payloadCiphertext) continue;
    try {
      const envelope = decryptCustomerIngressEnvelope({ version: 1, eventKey: row.eventKey, order: row.order.toString(),
        scopeKey: row.scopeKey, endpointScopeId: row.endpointScopeId, payloadHash: row.payloadHash }, row.payloadCiphertext);
      if (envelope.verification.provenance === "meta_signature" && envelope.verification.assurance === "protected_namespace" &&
        !envelope.payload.observations.providerEcho && !envelope.payload.observations.referralOnly &&
        envelope.payload.observations.classifier?.bareTemplateEcho !== true) return true;
    } catch { /* A corrupt/unverified observation cannot supersede genuine input. */ }
  }
  return false;
}
