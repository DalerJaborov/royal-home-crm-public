import { z } from "zod";
import { customerFenceSchema } from "@royal-home/shared";
import { encryptSecret, decryptSecret } from "../crypto.js";
import { customerVerifierCredentialSchema } from "./customerOriginCredential.js";

export const customerFinalOriginSchema = z.object({
  version: z.literal(1), classification: z.literal("FINAL_IN"), verifierVersion: z.literal(1),
  eventKey: z.string().regex(/^[a-f0-9]{64}$/), order: z.string().regex(/^[1-9]\d{0,18}$/),
  scopeKey: z.string().regex(/^[a-f0-9]{64}$/), payloadHash: z.string().regex(/^[a-f0-9]{64}$/),
  originalConversationId: z.string().uuid(),
  input: z.object({ channel: z.enum(["INSTAGRAM", "FACEBOOK", "WHATSAPP", "WEBSITE"]),
    peer: z.string().min(1).max(512), accountExternalId: z.string().min(1).max(512).optional(),
    eventId: z.string().min(1).max(512), inputText: z.string().max(8000),
    eventKind: z.enum(["message", "postback", "website_message", "direct"]),
    provenance: z.enum(["meta_signature", "website_application_key"]),
    protectedMetaAccountId: z.string().uuid().nullable(), protectedMetaEndpointScopeId: z.string().uuid().nullable(),
    issuerAccountId: z.string().uuid().nullable(),
    assurance: z.enum(["protected_namespace", "public_envelope", "website_public_input"]),
    issuerSource: z.enum(["account_secret", "single_channel_global", "verified_public_envelope", "website_application_key"]),
    issuerEndpointScopeId: z.string().uuid().nullable(), issuerScopeRevision: z.string().nullable(), issuerPolicyRevision: z.string().nullable(),
    acceptedFence: customerFenceSchema, issuedAt: z.number().int().nonnegative(),
    verifierCredential: customerVerifierCredentialSchema.nullable(),
  }).strict(),
}).strict();
export type CustomerFinalOrigin = z.infer<typeof customerFinalOriginSchema>;
export function encryptCustomerFinalOrigin(value: CustomerFinalOrigin): string {
  return encryptSecret(JSON.stringify(customerFinalOriginSchema.parse(value)));
}
export function decryptCustomerFinalOrigin(ciphertext: string): CustomerFinalOrigin {
  if (ciphertext.length > 100_000) throw new Error("Origin ciphertext exceeds bound");
  return customerFinalOriginSchema.parse(JSON.parse(decryptSecret(ciphertext)));
}
