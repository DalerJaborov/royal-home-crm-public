import { z } from "zod";
import { recruitmentPositionKeySchema } from "./recruitment.js";

export const recruitmentRecoveryRequestSchema = z.object({
  campaign: z.string().regex(/^[a-z0-9-]{8,64}$/),
  recipients: z.array(z.object({ conversationId: z.string().uuid(), positionKey: recruitmentPositionKeySchema.optional(),
    expectedSourceHash: z.string().regex(/^[a-f0-9]{64}$/), expectedSourceAt: z.string().datetime(),
    language: z.enum(["ru", "tg"]), reason: z.enum(["incorrect_vacancy", "unanswered_application"]),
    /** Explicit staff review, never supplied by a customer/model. HUMAN ownership remains stronger. */
    resumeReviewedPause: z.boolean().optional() }).strict()).min(1).max(50)
    .refine(rows => new Set(rows.map(row => row.conversationId)).size === rows.length, "Повтор диалога"),
}).strict();
export type RecruitmentRecoveryRequest = z.infer<typeof recruitmentRecoveryRequestSchema>;
