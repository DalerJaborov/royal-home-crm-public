import { z } from "zod";
import { recruitmentPositionKeySchema } from "./recruitment.js";

const MAX_REVISION = 9223372036854775807n;
export const customerRevisionSchema = z.string().regex(/^(?:0|[1-9]\d{0,18})$/)
  .refine(value => /^(?:0|[1-9]\d{0,18})$/.test(value) && BigInt(value) <= MAX_REVISION);
const reference = z.string().min(1).max(512);
export const customerAcceptedCallbackQuestionSchema = z.object({
  version: z.literal(1), partId: z.string().uuid(), attemptId: z.string().uuid(), providerMid: reference,
  payloadHash: z.string().regex(/^[a-f0-9]{64}$/), questionEventKey: reference,
  questionOrder: customerRevisionSchema.refine(value => value !== "0"), affirmationEventKey: reference,
  affirmationOrder: customerRevisionSchema.refine(value => value !== "0"),
}).strict();
export type CustomerAcceptedCallbackQuestion = z.infer<typeof customerAcceptedCallbackQuestionSchema>;
export const customerCallbackConsentSchema = z.object({
  matcherVersion: z.literal(1), acceptedQuestion: customerAcceptedCallbackQuestionSchema.optional(), originalEventKey: reference,
  originalOrder: customerRevisionSchema.refine(value => value !== "0"),
  nativeId: z.string().uuid(), endpointScopeId: z.string().uuid(), accountId: z.string().uuid().nullable(),
  ownershipEpoch: customerRevisionSchema, bindingRevision: customerRevisionSchema,
  scopeRevision: customerRevisionSchema, policyRevision: customerRevisionSchema, ownerToken: z.string().uuid(),
}).strict();
export type CustomerCallbackConsent = z.infer<typeof customerCallbackConsentSchema>;
export const customerActionKindSchema = z.enum(["contact", "callback", "handover", "book_showing", "reschedule_showing", "cancel_showing", "owner_question", "job_application"]);
export type CustomerActionKind = z.infer<typeof customerActionKindSchema>;
const intent = z.object({
  generation: customerRevisionSchema,
  status: z.enum(["open", "committed", "cancelled", "needs_review"]),
  evidenceRefs: z.array(reference).min(1).max(16),
  commandDigest: z.string().regex(/^[a-f0-9]{64}$/).optional(),
}).strict();
export const customerActionIntentsSchema = z.object({ contact: intent.optional(),
  callback: intent.extend({ consent: customerCallbackConsentSchema.optional() }).strict().optional(),
  handover: intent.optional(), book_showing: intent.optional(), reschedule_showing: intent.optional(),
  cancel_showing: intent.optional(), owner_question: intent.optional(), job_application: intent.optional(),
}).strict();
export type CustomerActionIntents = z.infer<typeof customerActionIntentsSchema>;

/** Safe conversation state. Claimed names/phones, profile memory and receipts
 * are separate server-only action data, never part of this projection. */
export const customerPublicStateSchema = z.object({
  language: z.enum(["ru", "tg", "mixed", "unknown"]).default("unknown"),
  topic: z.enum(["buyer", "seller", "job", "rent", "unknown"]).default("unknown"),
  jobPositionKey: recruitmentPositionKeySchema.optional(),
  openQuestion: z.enum(["property", "price", "address", "builder", "contact", "callback", "none"]).default("none"),
}).strict();
export const customerOwnerModeSchema = z.enum(["BOT", "HUMAN", "OFF", "HOLD"]);
export const customerEndpointRefSchema = z.object({
  endpointScopeId: z.string().uuid(), channel: reference,
  accountId: z.string().uuid().nullable(), peerId: reference,
  threadId: z.string().max(512),
}).strict();
export type CustomerEndpointRef = z.infer<typeof customerEndpointRefSchema>;
export const customerFenceSchema = z.object({
  inquiryId: z.string().uuid(), endpoint: customerEndpointRefSchema,
  nativeId: z.string().uuid().nullable(),
  stateRevision: customerRevisionSchema, intentRevision: customerRevisionSchema,
  ownershipEpoch: customerRevisionSchema, bindingRevision: customerRevisionSchema,
  scopeRevision: customerRevisionSchema, policyRevision: customerRevisionSchema,
  ownerToken: z.string().uuid().nullable(),
}).strict();
export type CustomerFence = z.infer<typeof customerFenceSchema>;
export const customerShieldPauseFenceSchema = z.object({ version: z.literal(1), fence: customerFenceSchema }).strict();
export const customerStateSchema = z.object({
  version: z.literal(1), fence: customerFenceSchema,
  ownerMode: customerOwnerModeSchema, ownerAgentId: z.string().uuid().nullable(),
  ownerLeaseUntil: z.string().datetime().nullable(), closedAt: z.string().datetime().nullable(),
  publicState: customerPublicStateSchema,
  privateAuthorization: z.literal("none"), legacyMemoryQuarantined: z.boolean(),
  contractVersion: z.enum(["compat", "scoped"]), rolloutMode: z.enum(["OFF", "SHADOW", "ACTIVE"]),
  capabilities: z.object({ publicRead: z.boolean().default(false), contactWrite: z.boolean().default(false), callbackWrite: z.boolean().default(false),
    newLeadBridge: z.boolean().default(false), handoverWrite: z.boolean().default(false),
    showingWrite: z.boolean().default(false), ownerQuestionWrite: z.boolean().default(false) }).strict(),
}).strict();
export type CustomerStateSnapshot = z.infer<typeof customerStateSchema>;

/** These are server events, not tools or model proposals. Schemas validate
 * shape only; issuers and inbound slot evidence are checked by the server. */
export const customerStateEventSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("accepted_inbound"), eventKey: reference, order: customerRevisionSchema.refine(value => value !== "0"),
    publicState: customerPublicStateSchema.optional() }).strict(),
  z.object({ type: z.literal("intent"), kind: customerActionKindSchema,
    change: z.enum(["request", "correct", "cancel", "review"]), evidenceRefs: z.array(reference).min(1).max(16),
    commandDigest: z.string().regex(/^[a-f0-9]{64}$/).optional() }).strict(),
  z.object({ type: z.literal("callback_consent"), consent: customerCallbackConsentSchema }).strict(),
  z.object({ type: z.literal("intent_evidence"), kind: z.literal("callback"), generation: customerRevisionSchema,
    eventKey: reference }).strict(),
  z.object({ type: z.literal("intent_committed"), kind: customerActionKindSchema,
    generation: customerRevisionSchema }).strict(),
  z.object({ type: z.literal("owner"), mode: customerOwnerModeSchema,
    agentId: z.string().uuid().nullable(), token: z.string().uuid(),
    leaseUntil: z.string().datetime().nullable() }).strict(),
  z.object({ type: z.literal("close"), at: z.string().datetime() }).strict(),
]);
export type CustomerStateEvent = z.infer<typeof customerStateEventSchema>;
