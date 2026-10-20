import { z } from "zod";
import { ROLES, type Role } from "./enums.js";

/** UI availability only: this configuration never grants business permissions. */
export const uiShellRolloutSchema = z.object({
  enabled: z.boolean(),
  agentIds: z.array(z.string().trim().min(1).max(128)).max(1000),
  roles: z.array(z.enum(ROLES)).max(ROLES.length),
}).strict();

export type UiShellRollout = z.infer<typeof uiShellRolloutSchema>;
/** Opaque revision for optimistic concurrency; not a permission or feature flag. */
export const uiShellRolloutConfigSchema = uiShellRolloutSchema.extend({ version: z.string().min(1).max(100) });
export type UiShellRolloutConfig = z.infer<typeof uiShellRolloutConfigSchema>;
/** Internal persisted envelope. Existing plain configurations remain readable. */
export const storedUiShellRolloutSchema = z.object({ revision: z.uuid(), config: uiShellRolloutSchema }).strict();

export const uiShellEffectiveSchema = z.object({ enabled: z.boolean() }).strict();

export function parseUiShellRollout(value: unknown): UiShellRollout {
  const envelope = storedUiShellRolloutSchema.safeParse(value);
  const parsed = uiShellRolloutSchema.safeParse(envelope.success ? envelope.data.config : value);
  return parsed.success ? parsed.data : { enabled: false, agentIds: [], roles: [] };
}

export function isUiShellEnabled(value: unknown, agent: { id: string; role: Role }): boolean {
  const config = parseUiShellRollout(value);
  return config.enabled && (config.agentIds.includes(agent.id) || config.roles.includes(agent.role));
}
