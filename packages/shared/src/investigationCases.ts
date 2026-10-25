import { z } from "zod";

export const investigationStatusSchema = z.enum(["OPEN", "REVIEWING", "CLEARED", "CONFIRMED"]);
export const investigationCaseConfigSchema = z.object({
  minSample: z.number().int().positive().max(1000000),
  repeatThreshold: z.number().int().positive().max(1000000),
  windowDays: z.number().int().positive().max(3660).default(30),
}).strict();
export type InvestigationCaseConfig = z.infer<typeof investigationCaseConfigSchema>;
export const investigationCaseConfigUpdateSchema = z.object({ config: z.union([investigationCaseConfigSchema, z.object({}).strict(), z.null()]) }).strict();
export const investigationDecisionSchema = z.object({
  requestKey: z.string().uuid(), revision: z.number().int().nonnegative(), status: investigationStatusSchema,
  note: z.string().trim().min(5).max(4000),
  level: z.enum(["C1", "C2", "C3"]).optional(),
}).strict().superRefine((data, ctx) => {
  if (data.level && data.status !== "REVIEWING") ctx.addIssue({ code: "custom", path: ["level"], message: "Уровень C1–C3 задаётся при рассмотрении" });
});
export const investigationCasesQuerySchema = z.object({
  status: investigationStatusSchema.optional(), page: z.coerce.number().int().min(1).default(1),
});
export const investigationSeveritySchema = z.object({
  requestKey: z.string().uuid(), revision: z.number().int().nonnegative(),
  level: z.enum(["C1", "C2", "C3", "C4"]), note: z.string().trim().min(5).max(4000),
  confirmC4: z.boolean().optional(),
}).strict().superRefine((data, ctx) => {
  if (data.level === "C4" && data.confirmC4 !== true) ctx.addIssue({ code: "custom", path: ["confirmC4"], message: "Подтвердите отдельное решение об уровне C4" });
});
export const investigationCaseRowSchema = z.object({
  id: z.string(), clientId: z.string().nullable(), propertyId: z.string().nullable(), showingId: z.string().nullable(),
  title: z.string(), status: z.string(), level: z.string(), revision: z.number(), lastSignalAt: z.string(), resolvedAt: z.string().nullable(),
  subjectAgent: z.object({ id: z.string(), fullName: z.string() }).nullable(),
  _count: z.object({ evidence: z.number(), decisions: z.number() }),
});
export type InvestigationCaseRow = z.infer<typeof investigationCaseRowSchema>;
export type InvestigationCaseDetail = InvestigationCaseRow & {
  recommendation?: { level: string; basis: string; evidenceIds: string[]; mode: string };
  independentSources: number;
  evidence: Array<{ id: string; sourceType: string; sourceId: string; independenceKey: string; kind: string; summary: string; occurredAt: string }>;
  decisions: Array<{ id: string; actorId: string; action: string; level: string; note: string; previousStatus: string; newStatus: string; createdAt: string }>;
};

export interface SellerControlPreviewPage {
  page: number; total: number; pageSize: number;
  items: Array<{ id: string; shortId: number; name: string; agentName: string | null;
    state: string; reasons: string[]; expected: number | null; accepted: number; drafts: number; terminal: number;
    anchorAt: string | null; anchorSource: string; lastAgentAttemptAt: string | null; lastClientMessageAt: string | null;
    hasPlannedNextStep: boolean; workingDaysSilent: number | null; proposedStage: string; ropInaction: string; directorAction: string }>;
}
