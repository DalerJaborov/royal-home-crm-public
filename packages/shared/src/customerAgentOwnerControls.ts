// Strict owner command boundaries; the server chooses and verifies artifacts.
import { z } from "zod";
import { customerRevisionSchema, customerStateSchema } from "./customerState.js";
import { customerAgentRolloutConfigSchema } from "./customerAgentRollout.js";
const reason = z.string().trim().min(1).max(500);
export const customerAgentRegisterRequestSchema = z.object({
  configId: z.enum(["royal-customer-g36-tools-20261015-v2", "royal-customer-g36-media-20261017-v3"]), reason,
}).strict();
export const customerAgentPublishRequestSchema = z.object({
  expectedPolicyRevision: customerRevisionSchema,
  rollout: customerAgentRolloutConfigSchema,
  capabilities: customerStateSchema.shape.capabilities,
  advanceIdleRevision: z.literal(true).optional(),
  confirmMediaProfileUpgrade: z.literal(true).optional(),
  confirmCatalogFactsUpgrade: z.literal(true).optional(),
  confirmRecruitmentResumeUpgrade: z.literal(true).optional(),
  confirmManagedPaidCalls: z.literal(true), acknowledgeNoDailyCap: z.literal(true), reason,
}).strict().refine(value => !value.confirmMediaProfileUpgrade || value.advanceIdleRevision === true,
  { message: "Media profile upgrade requires explicit idle revision advancement" })
  .refine(value => !value.confirmCatalogFactsUpgrade || value.advanceIdleRevision === true,
    { message: "Catalog facts upgrade requires explicit idle revision advancement" })
  .refine(value => !value.confirmRecruitmentResumeUpgrade || value.advanceIdleRevision === true,
    { message: "Recruitment résumé upgrade requires explicit idle revision advancement" });
export const customerAgentKillRequestSchema = z.object({ expectedPolicyRevision: customerRevisionSchema, reason }).strict();
/** The server chooses the deployed factory and retains the existing policy. */
export const customerAgentRefreshRequestSchema = z.object({ expectedPolicyRevision: customerRevisionSchema, reason,
  confirmRecruitmentResumeUpgrade: z.literal(true).optional() }).strict();
export type CustomerAgentRefreshRequest = z.infer<typeof customerAgentRefreshRequestSchema>;
export type CustomerAgentPublishRequest = z.infer<typeof customerAgentPublishRequestSchema>;

/** A reserve artifact chooses its own reviewed recovery target. Client IDs and
 * generic publication acknowledgements are deliberately not accepted here. */
export const customerAgentQualityRecoveryRequestSchema = z.object({
  expectedPolicyRevision: customerRevisionSchema, requestId: z.string().uuid(), reason,
  confirmQualityRecovery: z.literal(true), acknowledgeResumeFromOff: z.literal(true).optional(),
}).strict();
export const customerAgentQualityRecoveryStateSchema = z.object({
  status: z.enum(["ready", "blocked", "already_recovered"]), reason: z.string().min(1),
  requiresResumeFromOff: z.boolean(), policyRevision: customerRevisionSchema,
}).strict();
export const customerAgentQualityRecoveryResultSchema = z.object({
  policyRevision: customerRevisionSchema, rolloutMode: z.literal("ACTIVE"), recoveryVersion: z.literal("quality-v1"),
  revisionId: z.string().regex(/^[a-f0-9]{64}$/), alreadyApplied: z.boolean(),
}).strict();
export type CustomerAgentQualityRecoveryRequest = z.infer<typeof customerAgentQualityRecoveryRequestSchema>;
export type CustomerAgentQualityRecoveryState = z.infer<typeof customerAgentQualityRecoveryStateSchema>;
export type CustomerAgentQualityRecoveryResult = z.infer<typeof customerAgentQualityRecoveryResultSchema>;
