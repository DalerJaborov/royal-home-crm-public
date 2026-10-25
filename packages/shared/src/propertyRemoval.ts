import { z } from "zod";
import { PROPERTY_DELETE_REQUEST_REASONS, propertyDeleteRequestSchema } from "./schemas.js";

/** Old clients may omit both fields. New removal interfaces require an explicit reason. */
export const propertyRemovalSchema = z.object({
  removalReason: z.enum(PROPERTY_DELETE_REQUEST_REASONS).optional(),
  removalComment: z.string().trim().max(1000).optional(),
}).superRefine((data, ctx) => {
  if (!data.removalReason) {
    if (data.removalComment) ctx.addIssue({ code: "custom", path: ["removalReason"], message: "Выберите причину" });
    return;
  }
  const result = propertyDeleteRequestSchema.safeParse({ reason: data.removalReason, comment: data.removalComment });
  if (!result.success) for (const issue of result.error.issues) ctx.addIssue({ code: "custom", path: ["removalComment"], message: issue.message });
});
export type PropertyRemovalInput = z.infer<typeof propertyRemovalSchema>;
