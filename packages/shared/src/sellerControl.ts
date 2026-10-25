import { z } from "zod";

/** Empty configuration deliberately has no deadlines and cannot execute. */
export const sellerControlConfigSchema = z.object({
  agentDueWorkingDays: z.number().int().min(1).max(365),
  ropReceiptDueWorkingDays: z.number().int().min(1).max(365),
  ropActionDueWorkingDays: z.number().int().min(1).max(365),
  buyerCandidateFollowupWorkingDays: z.number().int().min(1).max(365).optional(),
  defaultRopAgentId: z.string().uuid().optional(),
}).strict();
export type SellerControlConfig = z.infer<typeof sellerControlConfigSchema>;
export const sellerControlConfigUpdateSchema = z.object({ config: z.union([sellerControlConfigSchema, z.object({}).strict()]) }).strict();
export const sellerControlCommandSchema = z.object({
  requestKey: z.string().uuid(), revision: z.number().int().positive(),
  action: z.enum(["TICK", "RECEIPT", "ACTION", "RESOLVE", "CANCEL"]),
  note: z.string().trim().min(3).max(2000).optional(),
}).strict().refine(value => !["ACTION", "RESOLVE", "CANCEL"].includes(value.action) || !!value.note, { message: "Опишите действие" });
export type SellerControlCommand = z.infer<typeof sellerControlCommandSchema>;
export interface SellerControlEpisodeView {
  id: string; clientId: string; revision: number; status: string; executionMode: string;
  agentDueAt: string | null; ropReceiptDueAt: string | null; ropActionDueAt: string | null;
  events: Array<{ id: string; type: string; occurredAt: string }>;
}
export interface SellerControlPage {
  config: SellerControlConfig | null; configurationState: string; mode: "PREVIEW"; episodes: SellerControlEpisodeView[];
}

/** Ordinary assigned work only; investigation identifiers and reasons are never exposed. */
export interface SalesControlHome {
  tasks: Array<{ id: string; clientId: string; clientShortId: number; clientName: string;
    title: string; dueAt: string | null; responseAction: "RECEIPT" | "ACTION" | null }>;
  limited: boolean;
  actionsEnabled: boolean;
}
