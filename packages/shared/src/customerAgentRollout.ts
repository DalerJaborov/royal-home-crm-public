// Routing shapes, separate from authenticated principals and execution grants.
// Shapes only, not a verified subject, principal, policy publication or grant.
import { z } from "zod";
import { customerRevisionSchema } from "./customerState.js";
import { publicCommentTargetSchema } from "./customerPublicComments.js";
const digest = z.string().regex(/^[a-f0-9]{64}$/);
const scope = z.string().uuid();
const channel = z.enum(["INSTAGRAM", "FACEBOOK", "WHATSAPP", "WEBSITE", "TELEGRAM", "YOUTUBE", "PHONE"]);
export const customerAgentRolloutConfigSchema = z.object({ version: z.literal(1), cohortId: z.string().uuid(),
  candidateRevisionId: digest, percentBasisPoints: z.number().int().min(0).max(10_000),
  allowed: z.array(z.object({ surface: z.enum(["dm", "public_comment"]), channel, endpointScopeId: scope }).strict()).max(100)
    .refine(rows => new Set(rows.map(row => JSON.stringify([row.surface, row.endpointScopeId]))).size === rows.length),
}).strict();
export type CustomerAgentRolloutConfig = z.infer<typeof customerAgentRolloutConfigSchema>;
const endpoint = z.object({ endpointScopeId: scope, scopeRevision: customerRevisionSchema, channel,
  accountId: z.string().uuid().nullable(), transportKey: z.string().min(1).max(1024) }).strict();
export const customerAgentEnrollmentSubjectSchema = z.discriminatedUnion("surface", [
  z.object({ surface: z.literal("dm"), endpoint, peer: z.string().min(1).max(512) }).strict(),
  z.object({ surface: z.literal("public_comment"), endpoint, target: publicCommentTargetSchema }).strict(),
]);
export type CustomerAgentEnrollmentSubject = z.infer<typeof customerAgentEnrollmentSubjectSchema>;
export const customerAgentRolloutAssignmentSchema = z.object({ id: z.string().uuid(), cohortId: z.string().uuid().nullable(),
  surface: z.enum(["dm", "public_comment"]), endpointScopeId: scope, subjectKey: digest,
  bucketBps: z.number().int().min(0).max(9999).nullable(), lane: z.enum(["LEGACY", "CORE"]), candidateRevisionId: digest.nullable(),
}).strict().superRefine((value, ctx) => {
  const empty = value.cohortId === null && value.candidateRevisionId === null && value.bucketBps === null;
  const complete = value.cohortId !== null && value.candidateRevisionId !== null && value.bucketBps !== null;
  if (!complete && !(value.lane === "LEGACY" && empty)) ctx.addIssue({ code: "custom", message: "Incomplete enrollment campaign" });
});
export type CustomerAgentRolloutAssignment = z.infer<typeof customerAgentRolloutAssignmentSchema>;
