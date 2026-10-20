import { z } from "zod";
import { encryptSecret, decryptSecret } from "../crypto.js";
import { customerVerifierCredentialSchema } from "./customerOriginCredential.js";

const digest = z.string().regex(/^[a-f0-9]{64}$/);
export const customerSenderObservationContextSchema = z.object({
  version: z.literal(1), source: z.literal("instagram_username_get"),
  eventKey: digest, order: z.string().regex(/^[1-9]\d{0,18}$/), payloadHash: digest,
  channel: z.literal("INSTAGRAM"), peer: z.string().min(1).max(512), accountId: z.string().uuid(),
  endpointScopeId: z.string().uuid(), scopeRevision: z.string().regex(/^(0|[1-9]\d{0,18})$/),
  policyRevision: z.string().regex(/^(0|[1-9]\d{0,18})$/), receivedAt: z.number().int().nonnegative(),
  signingCredential: customerVerifierCredentialSchema, accountTokenFingerprint: digest, ownIdentitiesHash: digest,
}).strict();
export type CustomerSenderObservationContext = z.infer<typeof customerSenderObservationContextSchema>;
const observationSchema = z.object({ context: customerSenderObservationContextSchema,
  observedAt: z.number().int().nonnegative(), username: z.string().regex(/^[A-Za-z0-9._]{1,30}$/),
}).strict().refine(value => value.observedAt >= value.context.receivedAt && value.observedAt <= value.context.receivedAt + 15 * 60_000);
export function encryptCustomerSenderObservation(context: CustomerSenderObservationContext, username: string, observedAt: number): string {
  return encryptSecret(JSON.stringify(observationSchema.parse({ context, username, observedAt })));
}
/** A server-written observation only, not an input brand or authorization. */
export function decryptCustomerSenderObservation(context: CustomerSenderObservationContext, ciphertext: string) {
  if (ciphertext.length > 32_000) throw new Error("Sender observation exceeds bound");
  const expected = customerSenderObservationContextSchema.parse(context);
  const value = observationSchema.parse(JSON.parse(decryptSecret(ciphertext)));
  if (JSON.stringify(value.context) !== JSON.stringify(expected) || Date.now() < expected.receivedAt || value.observedAt > Date.now() ||
      Date.now() - expected.receivedAt > 15 * 60_000) throw new Error("Sender observation context stale");
  return value;
}
