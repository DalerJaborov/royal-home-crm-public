// Shared response contract for the owner controls.
// Lives in packages/shared so API and web do not maintain separate contracts.
import { z } from "zod";
import { customerAgentRolloutConfigSchema } from "./customerAgentRollout.js";
import { customerStateSchema } from "./customerState.js";

export const customerAgentOwnerStateSchema = z.object({
  policyRevision: z.string().regex(/^(0|[1-9]\d*)$/),
  contractVersion: z.string(),
  rolloutMode: z.enum(["OFF", "SHADOW", "ACTIVE"]),
  activeAgentRevisionId: z.string().regex(/^[a-f0-9]{64}$/).nullable(),
  rollout: customerAgentRolloutConfigSchema.nullable(),
  capabilities: customerStateSchema.shape.capabilities,
  scopes: z.array(z.object({
    endpointScopeId: z.string().uuid(),
    channel: z.enum(["INSTAGRAM", "FACEBOOK", "WHATSAPP"]),
    surface: z.enum(["dm", "public_comment"]),
    displayLabel: z.string().trim().min(1).max(160),
    writeAssurance: z.literal("per_event_required"),
  }).strict()).max(100),
  moreScopes: z.boolean(),
  counts: z.array(z.object({ lane: z.enum(["LEGACY", "CORE"]), count: z.string().regex(/^\d+$/) }).strict()),
  disabled: z.array(z.enum(["SHADOW", "WEBSITE", "TELEGRAM", "YOUTUBE", "PHONE"])),
  stickyScope: z.literal("new_unassigned_only"),
  existingPromotion: z.literal("not_implemented"),
  dailyCap: z.literal("not_configured"),
  configId: z.string().min(1),
}).strict();
export type CustomerAgentOwnerState = z.infer<typeof customerAgentOwnerStateSchema>;
