import { z } from "zod";
import { PROPERTY_TYPES, PROPERTY_CONDITIONS, MARKET_TYPES, PROPERTY_STAGES } from "./enums.js";

// Internal server DTOs. Never accept a focus/fact/admission from model output.
const reference = z.string().min(1).max(1024);
const scopeKey = z.string().regex(/^[a-f0-9]{64}$/);
export const customerAdmissionOrderSchema = z.string().regex(/^[1-9]\d{0,18}$/)
  .refine((value) => /^[1-9]\d{0,18}$/.test(value) && BigInt(value) <= 9223372036854775807n);
export const customerPropertyEvidenceSchema = z.object({
  kind: z.enum(["ad", "url", "media", "reply", "public_selector", "untrusted_reference"]),
  origin: z.enum(["referral", "postback_referral", "remembered_referral", "message", "story", "website_page", "shared_media", "reply_to", "postback_payload"]),
  reference,
  secondaryReference: reference.optional(),
}).strict();
export type CustomerPropertyEvidence = z.infer<typeof customerPropertyEvidenceSchema>;

export const customerPropertyAdmissionSchema = z.object({
  eventKey: scopeKey,
  order: customerAdmissionOrderSchema,
  conversationId: z.string().uuid(),
  scopeKey,
  accountId: z.string().uuid().nullable(),
  endpointScopeId: z.string().uuid().optional(),
  channel: z.enum(["WHATSAPP", "INSTAGRAM", "FACEBOOK", "WEBSITE"]),
  evidence: z.array(customerPropertyEvidenceSchema).max(16),
}).strict();
export type CustomerPropertyAdmission = z.infer<typeof customerPropertyAdmissionSchema>;
export const customerPropertyAdmissionResultSchema = z.discriminatedUnion("status", [
  z.object({ status: z.literal("admitted"), ticket: customerPropertyAdmissionSchema, fresh: z.boolean().optional() }).strict(),
  z.object({ status: z.literal("denied"), reason: z.enum(["missing_identity", "account_unknown", "account_mismatch", "invalid_input", "storage_unavailable", "retry_ticket_missing", "already_managed"]) }).strict(),
]);
export type CustomerPropertyAdmissionResult = z.infer<typeof customerPropertyAdmissionResultSchema>;
export const customerPropertyBatchSchema = z.array(customerPropertyAdmissionResultSchema).max(16);

export const customerPropertyResolutionSchema = z.object({
  status: z.enum(["resolved", "ambiguous", "missing", "denied"]),
  propertyId: z.string().uuid().nullable(),
  candidates: z.array(z.string().uuid()).max(8),
  reason: z.enum(["unique", "conflict", "not_found", "untrusted_origin", "untrusted_reply", "unsupported", "lookup_unavailable"]),
  provenance: z.array(customerPropertyEvidenceSchema).max(16),
}).strict().superRefine((value, ctx) => {
  if ((value.status === "resolved") !== (value.propertyId !== null)) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["propertyId"], message: "Property is only present for a unique resolution" });
  }
});
export type CustomerPropertyResolution = z.infer<typeof customerPropertyResolutionSchema>;

export const customerPropertyFocusSchema = z.object({
  version: z.literal(1),
  scopeKey,
  generation: z.string().uuid(),
  lastEvidenceOrder: customerAdmissionOrderSchema,
  eventKey: scopeKey,
  status: z.enum(["pending", "resolved", "ambiguous", "missing", "denied"]),
  propertyId: z.string().uuid().nullable(),
  evidence: z.array(customerPropertyEvidenceSchema).max(16),
}).strict().superRefine((value, ctx) => {
  if ((value.status === "resolved") !== (value.propertyId !== null)) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["propertyId"], message: "A non-resolved focus cannot retain the previous property" });
  }
});
export type CustomerPropertyFocus = z.infer<typeof customerPropertyFocusSchema>;

export const customerPropertyCharacteristicsSchema = z.object({
  type: z.enum(PROPERTY_TYPES), rooms: z.number().int().min(1).max(100).nullable(),
  areaSqm: z.string().regex(/^\d{1,35}(?:\.\d{1,30})?$/).nullable(),
  landAreaSotka: z.string().regex(/^\d{1,35}(?:\.\d{1,30})?$/).nullable(),
  floor: z.number().int().nullable(), totalFloors: z.number().int().positive().nullable(),
  condition: z.enum(PROPERTY_CONDITIONS).nullable(), marketType: z.enum(MARKET_TYPES).nullable(), stage: z.enum(PROPERTY_STAGES).nullable(),
}).strict();
export type CustomerPropertyCharacteristics = z.infer<typeof customerPropertyCharacteristicsSchema>;
export const customerPropertyFactsSchema = z.object({
  propertyId: z.string().uuid(),
  shortId: z.number().int().positive(),
  price: z.string().regex(/^\d{1,14}(?:\.\d{1,2})?$/).nullable(),
  currency: z.enum(["TJS", "USD"]),
  availability: z.enum(["AVAILABLE", "RESERVED"]),
  publicAddress: z.string().max(300).nullable(),
  addressPolicy: z.literal("district_city_only"),
  builder: z.null(),
  // Optional only for immutable historical witnesses; live reads select real CRM fields.
  characteristics: customerPropertyCharacteristicsSchema.optional(),
  publicLink: z.string().url().max(1024).nullable(),
  updatedAt: z.string().datetime(),
  signature: scopeKey,
}).strict();
export type CustomerPropertyFacts = z.infer<typeof customerPropertyFactsSchema>;
export type CustomerPropertyFactKind = "price" | "address" | "builder" | "characteristics";

// Separate from legacy deliveryStatus=failed: pending/unknown/HOLD must not
// become a permission to replay the complete customer turn and its actions.
export const customerPropertyDeliverySchema = z.object({
  version: z.literal(1),
  partId: z.string().uuid(),
  inputEventKey: scopeKey,
  scopeKey,
  generation: z.string().uuid(),
  focusRevision: z.number().int().nonnegative(),
  propertyId: z.string().uuid().nullable(),
  factsSignature: scopeKey.nullable(),
  status: z.enum(["pending", "accepted", "held", "cancelled", "unknown"]),
  publishedAt: z.string().datetime().optional(),
}).strict();
export type CustomerPropertyDelivery = z.infer<typeof customerPropertyDeliverySchema>;

/** Server-built anchor for our own outbound property message, not model input. */
export const customerPropertyReferenceSchema = z.object({
  scopeKey,
  propertyId: z.string().uuid(),
}).strict();
export type CustomerPropertyReference = z.infer<typeof customerPropertyReferenceSchema>;

export interface ManagedCustomerPropertyReply {
  conversationId: string;
  channel: "WHATSAPP" | "INSTAGRAM" | "FACEBOOK" | "WEBSITE";
  peer: string;
  accountId: string | null;
  endpointScopeId?: string;
  accountExternalId?: string;
  text: string;
  delivery: CustomerPropertyDelivery;
}
