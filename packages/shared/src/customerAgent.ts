import { z } from "zod";
import { customerToolCallSchema } from "./customerTools.js";
import { customerMutationCommandSchema } from "./customerMutation.js";
import { customerPublicStateSchema } from "./customerState.js";
import { customerAgentCompanyPolicyCallSchema, customerAgentPropertySearchCallSchema, customerAgentCompanyInformationCallSchema } from "./customerAgentPublicReads.js";
import { customerAgentVacanciesCallSchema } from "./recruitment.js";
import { customerPropertyFactKindSchema } from "./customerPropertyContext.js";
import { recruitmentFactKeySchema } from "./recruitmentResume.js";

// DRAFT: no barrel export until the coordinated fresh-main integration.
export const customerAgentSurfaceSchema = z.enum(["dm", "public_comment", "voice"]);
export type CustomerAgentSurface = z.infer<typeof customerAgentSurfaceSchema>;
// Temporary leaf addition; root will align the existing public registry.
export const customerAgentAgencyContactCallSchema = z.object({ name: z.literal("get_agency_contact"), args: z.object({}).strict() }).strict();
export const customerAgentToolCallSchema = z.union([customerToolCallSchema, customerAgentAgencyContactCallSchema,
  customerAgentCompanyPolicyCallSchema, customerAgentPropertySearchCallSchema, customerAgentCompanyInformationCallSchema, customerAgentVacanciesCallSchema, customerMutationCommandSchema]);
export type CustomerAgentToolCall = z.infer<typeof customerAgentToolCallSchema>;
export const customerAgentFactKindSchema = customerPropertyFactKindSchema;
export const customerAgentQuestionSchema = z.enum(["none", "property", "budget", "location", "rooms", "name", "phone", "callback_consent", "topic", "role", "clarify_previous", "seller_details", "preferences", "job_position", "job_experience", "job_portfolio", "job_tools", "job_format", "job_start", "job_required"]);
export type CustomerAgentQuestion = z.infer<typeof customerAgentQuestionSchema>;
export const customerAgentSocialActSchema = z.enum(["none", "greet", "thank", "acknowledge", "apologize"]);
/** Server presentation state, never model-selected file authority. */
export const customerAgentApprovedFileStateSchema = z.enum(["available", "needs_follow", "awaiting_follow", "unavailable", "already_sent", "pending_delivery"]);
export type CustomerAgentApprovedFileState = z.infer<typeof customerAgentApprovedFileStateSchema>;
const evidenceRef = z.string().regex(/^e(?:0|[1-9]\d{0,3})$/);
const refs = z.array(evidenceRef).max(8).refine(values => new Set(values).size === values.length);
/** One or two short grounded sentences beside the template answer. The core lifts it out of the raw model JSON BEFORE the strict
 * parse (a bad `say` must never void the decision) and re-attaches it only after the server validator accepted it in live mode. */
export const customerAgentSayTextSchema = z.string().min(2).max(200);
const say = customerAgentSayTextSchema.optional();
/** Why a model `say` did not reach the customer: the 14 validator verdicts plus `language_disabled` (tg is off in v1) and `shadow`
 * (valid, but the mode only counts it). One enum for the validator, the trace and the guard counters. */
export const customerAgentSayDropReasonSchema = z.enum(["surface_disabled", "language_disabled", "length", "question", "number_or_date", "contact", "promise",
  "fact_claim", "place", "meta", "cliche", "language", "echo", "repeat", "double_greet", "shadow"]);
export type CustomerAgentSayDropReason = z.infer<typeof customerAgentSayDropReasonSchema>;
export const customerAgentSayStatusSchema = z.enum(["absent", "used", "dropped"]);
export const customerAgentSayModeSchema = z.enum(["shadow", "live"]);
export type CustomerAgentSayMode = z.infer<typeof customerAgentSayModeSchema>;
const reply = z.object({
  kind: z.literal("reply"), refs, social: customerAgentSocialActSchema,
  question: customerAgentQuestionSchema, say,
  /** A suggestion to the server planner; never a URL, asset ID or send receipt. */
  attachment: z.literal("buyer_guide").optional(),
}).strict();
export const customerAgentDecisionSchema = z.discriminatedUnion("kind", [
  reply,
  z.object({ kind: z.literal("clarify"), refs, question: customerAgentQuestionSchema.exclude(["none"]), social: customerAgentSocialActSchema, say }).strict(),
  z.object({ kind: z.literal("propose"), ref: evidenceRef, social: customerAgentSocialActSchema, say }).strict(),
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
  /** Own inquiry progress only; no private HR verdict or contact/identity grant. */
  recruitmentKnown: z.array(recruitmentFactKeySchema).max(13).optional(),
  recruitmentAnswerTo: recruitmentFactKeySchema.optional(),
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
