import { z } from "zod";

/** An explicit registry of factual corrections, never arbitrary SQL or workflow writes. */
export const manualClientLabelPatchSchema = z.object({
  fullName: z.string().trim().min(2).max(200).optional(),
  lastName: z.string().trim().max(100).optional(),
}).strict().refine(value => Object.keys(value).length > 0, "Укажите исправляемые поля");
export const manualDataCorrectionSchema = z.object({
  requestKey: z.string().uuid(),
  actorId: z.string().uuid(),
  reason: z.string().trim().min(20).max(2000),
  operation: z.literal("CLIENT_LABELS"),
  targets: z.array(z.object({ clientId: z.string().uuid(), patch: manualClientLabelPatchSchema }).strict()).min(1).max(50),
}).strict().refine(value => new Set(value.targets.map(row => row.clientId)).size === value.targets.length, "Карточки не должны повторяться");
export type ManualDataCorrectionInput = z.infer<typeof manualDataCorrectionSchema>;
