import { createHash } from "node:crypto";
import { z } from "zod";
import { customerPropertyEvidenceSchema } from "@royal-home/shared";
import { encryptSecret, decryptSecret } from "../crypto.js";
import { customerVerifierCredentialSchema } from "./customerOriginCredential.js";

const reference = z.string().min(1).max(512);
/** Encrypted normalized input only. No auth header/raw envelope/model state. */
export const customerNormalizedIngressSchema = z.object({
  version: z.literal(1), channel: z.enum(["INSTAGRAM", "FACEBOOK", "WHATSAPP", "WEBSITE"]),
  peer: reference, accountExternalId: reference.optional(),
  eventKind: z.enum(["message", "postback", "website_message"]), eventId: reference,
  inputText: z.string().max(8000), replyToMessageId: reference.optional(),
  displayName: z.string().max(160).optional(), postbackPayload: z.string().max(2000).optional(),
  source: z.object({ path: z.string().min(1).max(256), frameHash: z.string().regex(/^[a-f0-9]{64}$/) }).strict(),
  observations: z.object({ providerEcho: z.boolean(), referralOnly: z.boolean(),
    // Captured by the actual raw normalizer. Missing historical evidence is
    // unknown, never bareTemplateEcho:false or a recovered FINAL grant.
    classifier: z.object({ version: z.literal(1), bareTemplateEcho: z.boolean(),
      recipientPhoneDigits: z.string().regex(/^\d{8,15}$/).optional(),
      // Optional transport classification, excluded from stable event identity.
      // Older encrypted envelopes remain readable and are never rewritten.
      mediaKinds: z.array(z.enum(["image", "video", "audio", "document", "share", "link", "ephemeral", "unknown"])).max(16).optional(),
    }).strict().optional(),
  }).strict(),
  providerOccurredAt: z.string().datetime({ offset: true }).optional(),
  media: z.array(z.object({ kind: z.enum(["image", "video", "audio", "document", "share", "link", "ephemeral", "unknown"]),
    url: z.string().min(1).max(4096).optional(), assetRef: reference.optional(),
    mimeType: z.string().max(160).optional(), publicationId: reference.optional(),
  }).strict()).max(16),
  propertyEvidence: z.array(customerPropertyEvidenceSchema).max(16),
}).strict().superRefine((value, ctx) => {
  if (value.observations.classifier?.mediaKinds && value.observations.classifier.mediaKinds.length !== value.media.length) {
    ctx.addIssue({ code: "custom", message: "Media classifier membership mismatch" });
  }
  if (value.channel !== "WHATSAPP" && value.observations.classifier?.recipientPhoneDigits) {
    ctx.addIssue({ code: "custom", message: "Phone recipient observation channel mismatch" });
  }
  if ((value.channel === "WEBSITE") !== (value.eventKind === "website_message") ||
      (value.channel === "WEBSITE" ? value.accountExternalId !== undefined : !value.accountExternalId)) {
    ctx.addIssue({ code: "custom", message: "Ingress channel/target mismatch" });
  }
  if (Buffer.byteLength(JSON.stringify(value), "utf8") > 64 * 1024) ctx.addIssue({ code: "custom", message: "Ingress payload exceeds byte limit" });
});
export type CustomerNormalizedIngressInput = z.infer<typeof customerNormalizedIngressSchema>;
const storageContextSchema = z.object({ version: z.literal(1), eventKey: z.string().regex(/^[a-f0-9]{64}$/),
  order: z.string().regex(/^[1-9]\d{0,18}$/), scopeKey: z.string().regex(/^[a-f0-9]{64}$/),
  endpointScopeId: z.string().uuid(), payloadHash: z.string().regex(/^[a-f0-9]{64}$/),
}).strict();
export type CustomerIngressStorageContext = z.infer<typeof storageContextSchema>;
/** Verified envelope observation, deliberately without FINAL classification or
 * accepted owner/native fence. It cannot mint a customer input/write grant. */
export const customerPendingVerificationSchema = z.object({
  version: z.literal(1), classification: z.literal("PENDING_ENVELOPE"),
  provenance: z.enum(["meta_signature", "website_application_key"]),
  assurance: z.enum(["protected_namespace", "public_envelope", "website_public_input"]),
  issuerSource: z.enum(["account_secret", "single_channel_global", "verified_public_envelope", "website_application_key"]),
  accountId: z.string().uuid().nullable(), endpointScopeId: z.string().uuid(),
  scopeRevision: z.string().regex(/^(0|[1-9]\d{0,18})$/), policyRevision: z.string().regex(/^(0|[1-9]\d{0,18})$/),
  issuedAt: z.number().int().nonnegative(), source: customerNormalizedIngressSchema.shape.source,
  verifierCredential: customerVerifierCredentialSchema.nullable(),
}).strict();
export type CustomerPendingVerification = z.infer<typeof customerPendingVerificationSchema>;
const envelopeSchema = z.object({ context: storageContextSchema, payload: customerNormalizedIngressSchema,
  verification: customerPendingVerificationSchema }).strict();
export function customerIngressPayloadHash(payload: CustomerNormalizedIngressInput): string {
  const normalized = customerNormalizedIngressSchema.parse(payload);
  // Envelope grouping can change a raw frame's array position on redelivery.
  // Its exact content hash remains bound; the diagnostic path is AEAD-protected
  // but is not part of stable provider-event content identity.
  // Optional server classifier metadata is AEAD protected, but not stable raw
  // provider-event identity. Redelivery must retain an older immutable payload,
  // not fail/upgrade it merely because this deployment captures more metadata.
  return createHash("sha256").update(JSON.stringify({ ...normalized,
    observations: { providerEcho: normalized.observations.providerEcho, referralOnly: normalized.observations.referralOnly },
    source: { frameHash: normalized.source.frameHash } })).digest("hex");
}
export function encryptCustomerIngressPayload(context: CustomerIngressStorageContext, payload: CustomerNormalizedIngressInput, proof: CustomerPendingVerification): string {
  const normalized = customerNormalizedIngressSchema.parse(payload), bound = storageContextSchema.parse(context);
  const verification = customerPendingVerificationSchema.parse(proof);
  if (bound.payloadHash !== customerIngressPayloadHash(normalized) || verification.endpointScopeId !== bound.endpointScopeId ||
      JSON.stringify(verification.source) !== JSON.stringify(normalized.source)) throw new Error("Ingress payload hash mismatch");
  return encryptSecret(JSON.stringify({ context: bound, payload: normalized, verification }));
}
/** Strict AES-GCM: corrupt/plaintext/transplanted data is an error, never a
 * legacy decryptSecretSafe fallback or an authenticated customer input. */
export function decryptCustomerIngressPayload(context: CustomerIngressStorageContext, ciphertext: string): CustomerNormalizedIngressInput {
  return decryptCustomerIngressEnvelope(context, ciphertext).payload;
}
export function decryptCustomerIngressEnvelope(context: CustomerIngressStorageContext, ciphertext: string): z.infer<typeof envelopeSchema> {
  if (ciphertext.length > 300_000) throw new Error("Ingress ciphertext exceeds limit");
  const bound = storageContextSchema.parse(context), value = envelopeSchema.parse(JSON.parse(decryptSecret(ciphertext)));
  if (JSON.stringify(value.context) !== JSON.stringify(bound) || customerIngressPayloadHash(value.payload) !== bound.payloadHash ||
      value.verification.endpointScopeId !== bound.endpointScopeId || JSON.stringify(value.verification.source) !== JSON.stringify(value.payload.source)) {
    throw new Error("Ingress ciphertext binding mismatch");
  }
  return value;
}
