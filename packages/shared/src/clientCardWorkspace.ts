import { z } from "zod";

/** A person may buy and sell without duplicating their contact or dossier. */
export function clientIntents(client: { kind?: string | null; dualIntent?: boolean }) {
  return {
    sells: client.kind === "SELLER" || (client.kind === "BUYER" && client.dualIntent === true),
    buys: client.kind === "BUYER" || (client.kind === "SELLER" && client.dualIntent === true),
  };
}

export function clientCardCanWrite(input: {
  viewerId?: string; assignedAgentId?: string | null; canAssign: boolean;
  readOnly: boolean; pending: boolean; deleted?: boolean;
  assignmentCompletedAt?: string | null; canManageCompleted?: boolean;
}) {
  return (!input.assignmentCompletedAt || input.canManageCompleted === true)
    && !input.readOnly && !input.pending && !input.deleted && !!input.viewerId
    && (input.assignedAgentId === input.viewerId || input.canAssign);
}

/** A historical switch of kind is a signal to ask, never a confirmation of concurrent roles. */
export function confirmedClientIntents(client: { kind?: string | null; dualIntent?: boolean; dualIntentConfirmedAt?: Date | string | null }) {
  return clientIntents({ kind: client.kind, dualIntent: client.dualIntent === true && !!client.dualIntentConfirmedAt });
}

export const confirmClientIntentSchema = z.object({
  dualIntent: z.boolean(),
  resolution: z.enum(["MANUAL", "AUTO"]).optional(),
}).strict();

export const clientPropertyActivityQuerySchema = z.object({
  section: z.enum(["sent", "showings"]).default("sent"),
  page: z.coerce.number().int().min(1).max(100_000).default(1),
});
export const clientActivityPropertySchema = z.object({
  id: z.string(), shortId: z.number(), title: z.string(), price: z.string(),
  currency: z.enum(["TJS", "USD"]), status: z.string(), thumbUrl: z.string().nullable(),
});
export const clientPropertyActivitySchema = z.object({
  items: z.array(z.object({
    id: z.string(), at: z.string(), property: clientActivityPropertySchema.nullable(),
    shortId: z.number().nullable(), channel: z.string().nullable(),
    kind: z.enum(["PHOTO", "LINK", "SHOWING"]),
    state: z.enum(["sent", "scheduled", "completed", "cancelled", "unrecorded"]),
    scheduledAt: z.string().nullable(),
    canManage: z.boolean(),
  })),
  total: z.number(), page: z.number(), pageSize: z.number(),
});
export type ClientPropertyActivity = z.infer<typeof clientPropertyActivitySchema>;
export type ClientActivityProperty = z.infer<typeof clientActivityPropertySchema>;
export interface ClientPropertyActivitySummary {
  lastSentAt: string | null;
  sentCount: number;
  showingCount: number;
}
