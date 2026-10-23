import { z } from "zod";
import { customerAgentDecisionSchema, customerAgentSurfaceSchema, customerAgentSayDropReasonSchema, customerAgentSayStatusSchema } from "./customerAgent.js";
import { customerMutationReceiptSchema } from "./customerMutation.js";

export const BOT_TURN_TRACE_COVERAGE = "meta_website_customer_bot_v1" as const;
export const BOT_CUSTOMER_AGENT_TRACE_COVERAGE = "customer_agent_dm_public_v1" as const;
export const traceChannelSchema = z.enum(["WHATSAPP", "INSTAGRAM", "FACEBOOK", "WEBSITE"]);
export const traceSourceSchema = z.enum(["webhook", "website", "ai_retry", "manual_retry", "internal", "delivery_status"]);
export const traceOutcomeSchema = z.enum(["incomplete", "completed", "duplicate", "remembered", "echo", "manual", "bot_off", "batched", "no_reply", "failed", "blocked", "partially_sent"]);
export const traceStageSchema = z.enum(["ingress", "media_download", "asr", "vision", "resolution", "model", "qualifier_guards", "reply_chain", "recovery", "send", "stamp", "final"]);
const key = z.string().regex(/^[a-f0-9]{64}$/).nullable();
const count = z.number().int().nonnegative();
const time = z.string().datetime();
export const botIngressShapeSchema = z.strictObject({
  eventReferral: z.boolean(), messageReferral: z.boolean(), postbackReferral: z.boolean(),
  quickReplyPayload: z.boolean(), postbackPayload: z.boolean(), replyTo: z.boolean(),
  story: z.boolean(), attachments: count.max(1000), normalizedReferral: z.boolean(),
});
export const traceTextSchema = z.strictObject({ present: z.boolean(), chars: count, text: z.string().max(2000).optional() });
export const traceResolutionFactSchema = z.strictObject({
  kind: z.enum(["ad", "shared", "reply_to", "active", "showcase"]),
  propertyKey: key, status: z.enum(["found", "missing", "unknown"]),
  resolutionStatus: z.enum(["pending", "resolved", "ambiguous", "missing", "denied"]).optional(),
  provenanceKinds: z.array(z.enum(["ad", "url", "media", "reply", "public_selector", "untrusted_reference"])).max(6).optional(),
  candidateCount: z.number().int().min(0).max(8).optional(), superseded: z.boolean().optional(),
});
export const traceModelProjectionSchema = z.strictObject({
  object: z.boolean(), reply: traceTextSchema, replyType: z.enum(["string", "array", "missing", "other"]),
  readyType: z.enum(["boolean", "missing", "other"]), confidentType: z.enum(["boolean", "missing", "other"]),
  leadPresent: z.boolean(), jobPresent: z.boolean(), showingPresent: z.boolean(), topicPresent: z.boolean(),
});
export const traceModelAttemptSchema = z.strictObject({
  index: count, endpoint: z.enum(["lead-qualify", "assistant-tools"]), model: z.string().regex(/^[a-zA-Z0-9._-]{1,100}$/),
  cacheUsed: z.boolean().nullable(), outcome: z.enum(["started", "returned", "parsed", "invalid", "wrong_tool", "multiple_calls", "empty", "blocked", "error"]),
  protocolIssue: z.enum(["wrong_tool", "multiple_calls"]).optional(),
  durationMs: count, projection: traceModelProjectionSchema.optional(),
  schemaIssues: z.array(z.strictObject({ path: z.enum(["reply", "ready", "confident", "lead", "jobApplication", "showing", "topic", "other"]), code: z.enum(["invalid_type", "invalid_value", "too_small", "too_big", "unrecognized_keys", "custom", "other"]) })).max(16),
});
export const traceFilterDeltaSchema = z.strictObject({
  guard: z.enum(["price", "discount", "availability", "media_apology", "reply_chain", "recovery"]),
  attemptIndex: count, stage: z.enum(["qualifier_guards", "reply_chain", "recovery"]),
  before: traceTextSchema, after: traceTextSchema, changed: z.boolean(), guardHits: count,
});
export const traceOutgoingPartSchema = z.strictObject({
  ordinal: count, kind: z.enum(["text", "image", "audio", "file", "video", "buttons", "location", "reaction", "other"]),
  origin: z.enum(["bot", "regenerated", "neutral", "widget"]), requestedAt: time, finishedAt: time.nullable(),
  providerOutcome: z.enum(["started", "accepted", "failed", "unknown", "blocked", "available_to_widget", "delivered", "read"]),
  midKey: key, stampOutcome: z.enum(["not_attempted", "success", "failed", "missing"]), text: traceTextSchema,
  visibleAt: time.optional(),
});
export const traceTimingSchema = z.strictObject({ stage: traceStageSchema, durationMs: count });
// Metadata only. Known decisions/outcomes derive from their ONE existing contract.
const decisionKind = z.union(customerAgentDecisionSchema.options.map(option => option.shape.kind));
const receiptOutcome = z.union(customerMutationReceiptSchema.options.map(option => option.shape.outcome));
export const traceCustomerCoreReasonSchema = z.enum(["context_changed", "operation_stopped", "effect_unknown", "protocol_invalid", "limit", "unsupported", "needs_review", "other"]);
export const traceCustomerProtocolReasonSchema = z.enum(["invalid_model_turn", "mixed_model_protocol", "missing_model_parts", "duplicate_call_id", "invalid_model_call", "invalid_call_id", "call_id_reused", "invalid_model_decision", "duplicate_tool_definition"]);
/** Exact internal held reason, retained only when it matches a known Core stop code. */
export const traceCustomerCoreStopCodeSchema = z.enum([
  "managed_operation_required", "publication_context_invalid", "context_scope_mismatch", "media_surface_unqualified", "input_limit",
  "duplicate_tool_definition", "public_write_definition_denied", "unsupported_decision_evidence", "facts_unavailable", "invalid_model_turn",
  "missing_model_parts", "duplicate_call_id", "invalid_model_call", "invalid_call_id", "call_id_reused", "effect_unknown",
  "repeated_effect_denied", "invalid_model_decision", "surface_decision_denied", "receipt_requires_reconciliation", "model_payload_limit",
  "tool_limit", "unavailable_tool", "output_limit", "round_limit", "operation_stopped", "turn_deadline", "turn_unavailable",
  "port_not_started", "port_deadline", "port_cancelled", "original_context_changed", "public_write_denied", "invalid_server_observation",
  "cancelled", "deadline", "expired", "customer_core_unavailable",
]);
const traceCustomerDecisionKindSchema = decisionKind;
const traceCustomerSkipReasonSchema = z.enum(["no_reply_needed", "duplicate", "unsupported"]);
export const traceManagedContextSchema = z.strictObject({
  surface: customerAgentSurfaceSchema.exclude(["voice"]), phase: z.enum(["planning", "delivery"]),
  revisionId: z.string().regex(/^[a-f0-9]{64}$/).optional(), operationKey: key,
});
export const traceCustomerCoreSchema = z.strictObject({
  status: z.enum(["ready", "held", "planned", "unchanged"]), decisionKind: decisionKind.optional(),
  rounds: count.max(8), toolCalls: count.max(17), receiptOutcomes: z.array(receiptOutcome).max(8),
  heldReason: traceCustomerCoreReasonSchema.optional(),
  protocolReason: traceCustomerProtocolReasonSchema.optional(),
  /** Exact finite Core stop plus only schema-validated surface-denied decision fields. */
  stopCode: traceCustomerCoreStopCodeSchema.optional(),
  rejectedDecisionKind: traceCustomerDecisionKindSchema.optional(),
  skipReason: traceCustomerSkipReasonSchema.optional(),
  decisionSource: z.enum(["model", "verified_public_fallback", "receipt_confirmation"]).optional(),
  /** Safe diagnostic code of a held/fallback turn (snake_case reason or error class name); never text or data. */
  causeCode: z.string().regex(/^[A-Za-z][A-Za-z0-9_]{1,47}$/).optional(),
  /** Grounded free-phrase channel: status and verdict code only. The text itself is never written to the trace. */
  sayStatus: customerAgentSayStatusSchema.optional(), sayDropReason: customerAgentSayDropReasonSchema.optional(),
}).superRefine((value, ctx) => {
  if (value.skipReason !== undefined && value.rejectedDecisionKind !== "skip") {
    ctx.addIssue({ code: "custom", path: ["skipReason"], message: "skipReason requires rejectedDecisionKind=skip" });
  }
  if ((value.rejectedDecisionKind !== undefined || value.skipReason !== undefined) && value.stopCode !== "surface_decision_denied") {
    ctx.addIssue({ code: "custom", path: ["rejectedDecisionKind"], message: "rejected decisions require a surface decision stop" });
  }
});
export const traceManagedDeliverySchema = z.strictObject({
  status: z.enum(["accepted", "available_widget", "unknown", "suppressed", "not_sent", "waiting", "missing"]),
  projectionPending: z.boolean(),
});
export type TraceManagedContext = z.infer<typeof traceManagedContextSchema>;
export type TraceCustomerCore = z.infer<typeof traceCustomerCoreSchema>;
export type TraceManagedDelivery = z.infer<typeof traceManagedDeliverySchema>;
export const botTurnTracePayloadSchema = z.strictObject({
  schemaVersion: z.literal(1), coverage: z.enum([BOT_TURN_TRACE_COVERAGE, BOT_CUSTOMER_AGENT_TRACE_COVERAGE]), traceId: z.string().uuid(),
  createdAt: time, completedAt: time.nullable(), expiresAt: time, checkpointSeq: count,
  channel: traceChannelSchema, source: traceSourceSchema, outcome: traceOutcomeSchema,
  eventKey: key, conversationKey: key, accountKey: key, groupedEventKeys: z.array(key).max(32), groupedTraceIds: z.array(z.string().uuid()).max(32),
  input: z.strictObject({ kind: z.enum(["text", "media", "referral", "echo", "unknown"]), textPresent: z.boolean(), attachmentCount: count.max(1000), mimeKinds: z.array(z.enum(["image", "audio", "video", "document"])).max(4), language: z.enum(["ru", "tg", "unknown"]), echoReason: z.enum(["known_mid", "history_mid", "in_flight", "template", "manual", "unknown"]).nullable() }),
  managed: traceManagedContextSchema.optional(), customerCore: traceCustomerCoreSchema.optional(),
  managedDelivery: traceManagedDeliverySchema.optional(),
  ingress: botIngressShapeSchema.nullable(), resolutions: z.array(traceResolutionFactSchema).max(12),
  modelAttempts: z.array(traceModelAttemptSchema).max(8), filterDeltas: z.array(traceFilterDeltaSchema).max(16),
  outgoing: z.array(traceOutgoingPartSchema).max(12), timings: z.array(traceTimingSchema).max(12),
  guardHits: count, checkpointGaps: count, truncated: z.boolean(),
  omittedCounts: z.strictObject({ resolutions: count, modelAttempts: count, filterDeltas: count, outgoing: count, timings: count, textChars: count, grouped: count }),
  redactedKinds: z.array(z.enum(["free_text_omitted", "phone", "email", "handle", "url", "credential", "known_contact", "truncated"])).max(8),
});
export type BotTurnTracePayload = z.infer<typeof botTurnTracePayloadSchema>;
export type BotIngressShape = z.infer<typeof botIngressShapeSchema>;
export type TraceModelAttempt = z.infer<typeof traceModelAttemptSchema>;
export type TraceOutgoingPart = z.infer<typeof traceOutgoingPartSchema>;
export type TraceOutcome = z.infer<typeof traceOutcomeSchema>;
export type TraceStage = z.infer<typeof traceStageSchema>;
