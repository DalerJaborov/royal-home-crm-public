import { z } from "zod";
export const somonRecipientsSchema = z.object({ agentIds: z.array(z.string().uuid()).max(100) }).strict().refine(v => new Set(v.agentIds).size === v.agentIds.length, { message: "Повторяющийся сотрудник" });
export type SomonRecipientsInput = z.infer<typeof somonRecipientsSchema>;
export const somonMonitorStateSchema = z.object({ enabled: z.boolean() }).strict();
