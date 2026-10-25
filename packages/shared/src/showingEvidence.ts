import { z } from "zod";

export interface BuyerShowingCandidatePreview {
  id: string; clientId: string; sourceType: string; proposedAt: string | null; reviewDueAt: string;
  evaluation: string; plannedAction: string | null; confidence?: string; followupEscalation?: string;
  revision: number; executionMode: string; followupDueAt?: string | null;
}

export const showingEvidenceFields = {
  showingOffCrm: z.boolean().optional(),
  showingOffCrmDetails: z.string().trim().max(1000).optional(),
};
export interface NewShowingEvidence {
  type: string; propertyId?: string | null; nextActionDate?: Date | string | null;
  showingOffCrm?: boolean; showingOffCrmDetails?: string | null;
}
export const showingInputGuardSchema = z.unknown().superRefine((value, ctx) => {
  if (!value || typeof value !== "object") return;
  const row = value as Record<string, unknown>;
  if (row.type === "SHOWING" && typeof row.nextActionDate === "string") {
    const parts = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})/.exec(row.nextActionDate);
    const day = parts ? new Date(Date.UTC(Number(parts[1]), Number(parts[2]) - 1, Number(parts[3]))) : null;
    if (!parts || !day || day.toISOString().slice(0, 10) !== row.nextActionDate.slice(0, 10)
      || Number(parts[4]) > 23 || Number(parts[5]) > 59)
      ctx.addIssue({ code: "custom", path: ["nextActionDate"], message: "Укажите существующую дату и точное время показа" });
  }
});
export function showingEvidenceIssues(value: NewShowingEvidence): Array<{ path: string; message: string }> {
  if (value.type !== "SHOWING") return [];
  const issues: Array<{ path: string; message: string }> = [];
  if (!value.nextActionDate || !Number.isFinite(value.nextActionDate instanceof Date ? value.nextActionDate.getTime() : Date.parse(value.nextActionDate)))
    issues.push({ path: "nextActionDate", message: "Укажите дату и время показа" });
  if (!value.propertyId && !value.showingOffCrm)
    issues.push({ path: "propertyId", message: "Выберите объект или отметьте, что он ещё не внесён в CRM" });
  if (value.propertyId && value.showingOffCrm)
    issues.push({ path: "showingOffCrm", message: "Выбранный объект уже есть в CRM" });
  if (value.showingOffCrm && (value.showingOffCrmDetails?.trim().length ?? 0) < 10)
    issues.push({ path: "showingOffCrmDetails", message: "Опишите объект и адрес (не менее 10 символов)" });
  return issues;
}
export function refineShowingEvidence(value: NewShowingEvidence, ctx: z.RefinementCtx) {
  for (const issue of showingEvidenceIssues(value)) ctx.addIssue({ code: "custom", path: [issue.path], message: issue.message });
}
