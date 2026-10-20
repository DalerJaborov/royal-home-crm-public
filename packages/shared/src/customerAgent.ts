import { z } from "zod";
import { customerToolCallSchema } from "./customerTools.js";
import { customerMutationCommandSchema } from "./customerMutation.js";
import { customerPublicStateSchema } from "./customerState.js";
import { customerAgentCompanyPolicyCallSchema, customerAgentPropertySearchCallSchema, customerAgentCompanyInformationCallSchema } from "./customerAgentPublicReads.js";

// DRAFT: no barrel export until the coordinated fresh-main integration.
export const customerAgentSurfaceSchema = z.enum(["dm", "public_comment", "voice"]);
export type CustomerAgentSurface = z.infer<typeof customerAgentSurfaceSchema>;
// Temporary leaf addition; root will align the existing public registry.
export const customerAgentAgencyContactCallSchema = z.object({ name: z.literal("get_agency_contact"), args: z.object({}).strict() }).strict();
export const customerAgentToolCallSchema = z.union([customerToolCallSchema, customerAgentAgencyContactCallSchema,
  customerAgentCompanyPolicyCallSchema, customerAgentPropertySearchCallSchema, customerAgentCompanyInformationCallSchema, customerMutationCommandSchema]);
export type CustomerAgentToolCall = z.infer<typeof customerAgentToolCallSchema>;
export const customerAgentFactKindSchema = z.enum(["price", "address", "builder", "characteristics"]);
export const customerAgentQuestionSchema = z.enum(["none", "property", "budget", "location", "rooms", "name", "phone", "callback_consent", "topic", "role", "clarify_previous", "seller_details", "preferences"]);
export type CustomerAgentQuestion = z.infer<typeof customerAgentQuestionSchema>;
export const customerAgentSocialActSchema = z.enum(["none", "greet", "thank", "acknowledge", "apologize"]);
const evidenceRef = z.string().regex(/^e(?:0|[1-9]\d{0,3})$/);
const refs = z.array(evidenceRef).max(8).refine(values => new Set(values).size === values.length);
const reply = z.object({
  kind: z.literal("reply"), refs, social: customerAgentSocialActSchema,
  question: customerAgentQuestionSchema,
}).strict();
export const customerAgentDecisionSchema = z.discriminatedUnion("kind", [
  reply,
  z.object({ kind: z.literal("clarify"), refs, question: customerAgentQuestionSchema.exclude(["none"]), social: customerAgentSocialActSchema }).strict(),
  z.object({ kind: z.literal("propose"), ref: evidenceRef, social: customerAgentSocialActSchema }).strict(),
  z.object({ kind: z.literal("skip"), reason: z.enum(["no_reply_needed", "duplicate", "unsupported"]) }).strict(),
  z.object({ kind: z.literal("escalate"), reason: z.enum(["needs_staff", "complaint", "unsupported"]) }).strict(),
  z.object({ kind: z.literal("moderation_proposal"), action: z.enum(["hide", "delete"]), reason: z.enum(["spam", "abuse"]) }).strict(),
]);
export type CustomerAgentDecision = z.infer<typeof customerAgentDecisionSchema>;

const digest = z.string().regex(/^[a-f0-9]{64}$/);
const positive = z.number().int().positive();
export const customerAgentRevisionSchema = z.object({
  id: digest, coreHash: digest, modelSchemaHash: digest, toolSchemaHash: digest,
  rendererHash: digest, knowledgeSchemaHash: digest, knowledgeSourceHash: digest, providerProfileHash: digest,
  promptHash: digest, providerPolicyHash: digest,
  limits: z.object({
    maxRounds: positive.max(8), maxToolCalls: positive.max(16),
    maxInputChars: positive.max(128_000), maxOutputChars: positive.max(12_000),
    maxModelOutputTokens: positive.max(65_536), deadlineMs: positive.max(900_000),
  }).strict(),
}).strict();
export type CustomerAgentRevision = z.infer<typeof customerAgentRevisionSchema>;

/** Shape of an already minimized server projection, NOT proof of its source.
 * Only the real namespace/binding/revision loader may supply this field. */
export const customerAgentVerifiedContextSchema = z.object({
  surface: customerAgentSurfaceSchema, revisionId: digest,
  turns: z.array(z.object({ role: z.enum(["user", "assistant"]), text: z.string().trim().min(1).max(1500) }).strict()).max(6),
  publicState: customerPublicStateSchema,
  /** Progress from verified customer IN only; never a mutation/consent grant. */
  intake: z.object({ role: z.enum(["buyer", "seller", "unknown"]),
    sellerKnown: z.array(z.enum(["rooms", "area", "district", "floor", "condition", "price"])).max(6),
    buyerKnown: z.array(z.enum(["rooms", "budget", "location"])).max(3),
    /** Bounded customer words, never verified catalog facts or authority. */
    statements: z.array(z.string().min(1).max(360)).max(6).optional(),
  }).strict().optional(),
}).strict();
export type CustomerAgentVerifiedContext = z.infer<typeof customerAgentVerifiedContextSchema>;

/** These are model protocols and server configuration shapes, not principal,
 * input, moderation, proposal-confirmation, write or delivery authorities. */
