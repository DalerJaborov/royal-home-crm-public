/** Public source contracts. A parsed JSON object is NOT a server-issued public principal. */
import { z } from "zod";
import { customerPropertyFactsSchema } from "./customerPropertyContext.js";
const id = z.string().min(1).max(512);
const revision = z.string().regex(/^(?:0|[1-9]\d{0,18})$/).refine(s => BigInt(s) <= 9223372036854775807n);
export const publicCommentChannelSchema = z.enum(["INSTAGRAM", "FACEBOOK", "YOUTUBE", "TELEGRAM"]);
export const publicSourceRefSchema = z.object({ table: z.enum(["meta", "telegram"]), id }).strict();
export const publicCommentTargetSchema = z.object({ channel: publicCommentChannelSchema, publicationId: id,
  commentId: id, parentId: id.nullable(), threadId: id, threadKind: z.enum(["comment_anchor", "provider_thread", "discussion_post"]), accountExternalId: id }).strict();
export const publicInstallationSchema = z.object({ id, revision, channel: publicCommentChannelSchema,
  accountId: id.nullable(), resourceId: id, transportKey: id }).strict();
export const publicSourceProofSchema = z.object({ version: z.literal(1),
  origin: z.enum(["meta_verified_comment", "youtube_own_channel_poll", "telegram_verified_discussion_update"]),
  installation: publicInstallationSchema, source: publicSourceRefSchema, sourceRevision: revision, policyRevision: revision,
  digest: z.string().regex(/^[a-f0-9]{64}$/) }).strict();
export const publicSettingsSnapshotSchema = z.object({ policyRevision: revision,
  contractVersion: z.enum(["compat", "scoped"]), rolloutMode: z.enum(["OFF", "SHADOW", "ACTIVE"]), publicRead: z.boolean(),
  botEnabled: z.boolean(), botCanAnswerComments: z.boolean(), botInstagramEnabled: z.boolean(),
  botFacebookEnabled: z.boolean(), botTelegramEnabled: z.boolean(), metaEnabled: z.boolean() }).strict();
export const serverPublicCommentSnapshotSchema = z.object({ source: publicSourceRefSchema, sourceRevision: revision,
  status: z.string().max(64), target: publicCommentTargetSchema, text: z.string().max(2000),
  proof: publicSourceProofSchema.nullable(), currentInstallation: publicInstallationSchema.nullable(),
  settings: publicSettingsSnapshotSchema }).strict();
export type PublicCommentChannel = z.infer<typeof publicCommentChannelSchema>;
export type PublicSourceRef = Readonly<z.infer<typeof publicSourceRefSchema>>;
export type PublicCommentTarget = Readonly<z.infer<typeof publicCommentTargetSchema>>;
export type PublicInstallation = Readonly<z.infer<typeof publicInstallationSchema>>;
export type PublicSourceProof = Readonly<z.infer<typeof publicSourceProofSchema>>;
export type PublicSettingsSnapshot = Readonly<z.infer<typeof publicSettingsSnapshotSchema>>;
export type ServerPublicCommentSnapshot = Readonly<z.infer<typeof serverPublicCommentSnapshotSchema>>;
export type PublicReadContext = Readonly<{ source: PublicSourceRef; target: PublicCommentTarget; text: string }>;
export type PublicHeldReason = "source_missing" | "source_closed" | "origin_missing" | "origin_changed" |
  "installation_missing" | "installation_changed" | "policy_off" | "unsupported_channel" |
  "snapshot_unavailable" | "principal_unknown" | "tool_denied" | "facts_unavailable" | "capture_expired";
export type PublicResult<T> = { status: "current"; value: T } | { status: "held"; reason: PublicHeldReason };

export const publicReplyOutcomeSchema = z.enum(["accepted", "refused", "unknown"]);
export const publicReplyReceiptSchema = z.object({ outcome: publicReplyOutcomeSchema, providerId: id.nullable(), reason: z.string().min(1).max(128) }).strict();
export const publicReplyTargetSchema = z.union([
  z.object({ channel: z.enum(["INSTAGRAM", "FACEBOOK", "YOUTUBE"]), accountExternalId: id.nullable(), mediaId: id, commentId: id, parentId: id.nullable() }).strict(),
  z.object({ channel: z.literal("TELEGRAM"), groupChatId: id, messageId: id, postMessageId: id }).strict(),
]);
export type PublicReplyOutcome = z.infer<typeof publicReplyOutcomeSchema>;
export type PublicReplyReceipt = z.infer<typeof publicReplyReceiptSchema>;
export type PublicReplyTarget = z.infer<typeof publicReplyTargetSchema>;

export const publicCommentDeliveryFenceSchema = z.object({ version: z.literal(1), surface: z.literal("public_comment"),
  source: publicSourceRefSchema, sourceRevision: revision, installation: publicInstallationSchema,
  policyRevision: revision, target: publicCommentTargetSchema }).strict();
export const publicCommentDeliveryTransportSchema = z.object({ version: z.literal(1), surface: z.literal("public_comment"),
  installation: publicInstallationSchema, target: publicCommentTargetSchema }).strict();
export const publicCommentFactsWitnessSchema = z.object({ version: z.literal(1), kind: z.literal("public_facts"), facts: customerPropertyFactsSchema }).strict();
export type PublicCommentDeliveryFence = z.infer<typeof publicCommentDeliveryFenceSchema>;
export type PublicCommentFactsWitness = z.infer<typeof publicCommentFactsWitnessSchema>;

export const staffPublicCommentDeliveryFenceSchema = z.object({ version: z.literal(1), surface: z.literal("staff_public_comment"),
  purpose: z.literal("staff_public_reply"), source: publicSourceRefSchema.extend({ table: z.literal("meta") }),
  originalSourceRevision: revision, sourceRevision: revision, originDigest: z.string().regex(/^[a-f0-9]{64}$/),
  installation: publicInstallationSchema.extend({ channel: z.enum(["INSTAGRAM", "FACEBOOK"]) }),
  target: publicCommentTargetSchema.extend({ channel: z.enum(["INSTAGRAM", "FACEBOOK"]) }),
  staffAgentId: id, claimNonce: z.string().uuid(),
}).strict();
export const staffPublicCommentDeliveryTransportSchema = z.object({ version: z.literal(1), surface: z.literal("staff_public_comment"),
  installation: publicInstallationSchema.extend({ channel: z.enum(["INSTAGRAM", "FACEBOOK"]) }),
  target: publicCommentTargetSchema.extend({ channel: z.enum(["INSTAGRAM", "FACEBOOK"]) }),
}).strict();
export type StaffPublicCommentDeliveryFence = z.infer<typeof staffPublicCommentDeliveryFenceSchema>;
