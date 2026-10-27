import { z } from "zod";
import { customerFenceSchema, customerMutationReceiptSchema, customerPropertyDeliverySchema, customerRevisionSchema, customerHandoverAckFenceSchema } from "@royal-home/shared";
import { customerApprovedFilePlanSchema } from "./customerApprovedFiles.js";

export const customerDeliveryMediaEndpointSchema = z.object({ channel: z.enum(["INSTAGRAM", "FACEBOOK", "WHATSAPP"]), endpointScopeId: z.string().uuid(),
  accountId: z.string().uuid().nullable(), peerId: z.string().min(1).max(512), transportKey: z.string().min(1).max(1024),
  scopeRevision: z.string().regex(/^\d+$/) }).strict();
export type CustomerDeliveryMediaEndpoint = z.infer<typeof customerDeliveryMediaEndpointSchema>;
export const customerPropertyMediaWitnessSchema = z.object({ version: z.literal(1), propertyId: z.string().uuid(), shortId: z.number().int().positive(),
  propertyFactsSignature: z.string().regex(/^[a-f0-9]{64}$/), ordinal: z.number().int().min(0).max(4),
  sourcePath: z.string().regex(/^\/uploads\/[^/\\?#]+$/), sourceSha256: z.string().regex(/^[a-f0-9]{64}$/),
  assetPath: z.string().regex(/^\/uploads\/msg\/customer-property-[a-f0-9]{64}\.jpg$/), assetSha256: z.string().regex(/^[a-f0-9]{64}$/),
  publicUrl: z.string().url().refine(value => value.startsWith("https://")),
  endpoint: customerDeliveryMediaEndpointSchema,
  photosPerOffer: z.number().int().min(1).max(5), agentRevisionId: z.string().regex(/^[a-f0-9]{64}$/),
  eventKey: z.string().regex(/^[a-f0-9]{64}$/), scopeKey: z.string().regex(/^[a-f0-9]{64}$/), focusGeneration: z.string().uuid(),
  fingerprint: z.string().regex(/^[a-f0-9]{64}$/),
}).strict().superRefine((witness, context) => {
  if (!witness.publicUrl.endsWith(witness.assetPath)) context.addIssue({ code: "custom", message: "invalid_media_witness" });
});
export type CustomerPropertyMediaWitness = z.infer<typeof customerPropertyMediaWitnessSchema>;

const mediaHash = z.string().regex(/^[a-f0-9]{64}$/);
const voiceTriggerSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("inbound_voice"), messageId: z.string().min(1).max(512), attachmentId: z.string().min(1).max(512) }).strict(),
  z.object({ kind: z.literal("explicit_request"), messageId: z.string().min(1).max(512) }).strict(),
]);
export const customerVoiceMediaWitnessSchema = z.object({ version: z.literal(1), kind: z.literal("customer_voice"),
  assetPath: z.string().regex(/^\/uploads\/msg-voice\/customer-agent-[a-f0-9]{64}\.(?:ogg|m4a)$/),
  assetSha256: mediaHash, byteLength: z.number().int().positive().max(25 * 1024 * 1024), mimeType: z.enum(["audio/ogg", "audio/mp4"]),
  publicUrl: z.string().url().refine(value => value.startsWith("https://")), endpoint: customerDeliveryMediaEndpointSchema,
  voiceTrigger: voiceTriggerSchema, sealedTextSha256: mediaHash, voiceReplies: z.literal(true), deadlineAtMs: z.number().int().positive(),
  synthesizer: z.literal("gemini_tts"),
  agentRevisionId: mediaHash, eventKey: mediaHash, scopeKey: mediaHash, turnKey: mediaHash,
  fingerprint: mediaHash,
}).strict().superRefine((witness, context) => {
  const expectedMime = witness.assetPath.endsWith(".ogg") ? "audio/ogg" : "audio/mp4";
  if (!witness.publicUrl.endsWith(witness.assetPath) || witness.mimeType !== expectedMime || witness.endpoint.channel !== "WHATSAPP" && witness.assetPath.endsWith(".ogg") ||
      witness.endpoint.channel === "WHATSAPP" && witness.assetPath.endsWith(".m4a")) context.addIssue({ code: "custom", message: "invalid_voice_media_witness" });
});
export type CustomerVoiceMediaWitness = z.infer<typeof customerVoiceMediaWitnessSchema>;

export const customerApprovedFileMediaWitnessSchema = z.object({ version: z.literal(1), kind: z.literal("approved_customer_file"),
  approvedFile: customerApprovedFilePlanSchema,
  endpoint: customerDeliveryMediaEndpointSchema, agentRevisionId: mediaHash, eventKey: mediaHash, scopeKey: mediaHash, turnKey: mediaHash,
  fingerprint: mediaHash,
}).strict().superRefine((witness, context) => {
  if (witness.approvedFile.channel !== witness.endpoint.channel ||
      witness.approvedFile.deliveryKind !== (witness.endpoint.channel === "INSTAGRAM" ? "link" : "file")) {
    context.addIssue({ code: "custom", message: "invalid_approved_file_witness" });
  }
});
export type CustomerApprovedFileMediaWitness = z.infer<typeof customerApprovedFileMediaWitnessSchema>;

export const customerDeliveryPayloadSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("text"), text: z.string().trim().min(1).max(12000) }).strict(),
  z.object({ kind: z.literal("image"), url: z.string().url().max(4096).refine(value => value.startsWith("https://")),
    mediaWitness: customerPropertyMediaWitnessSchema }).strict().superRefine((payload, context) => {
      if (payload.url !== payload.mediaWitness.publicUrl) context.addIssue({ code: "custom", message: "image_url_witness_mismatch" });
    }),
  z.object({ kind: z.literal("audio"), url: z.string().url().max(4096).refine(value => value.startsWith("https://")),
    mediaWitness: customerVoiceMediaWitnessSchema }).strict().superRefine((payload, context) => {
      if (payload.url !== payload.mediaWitness.publicUrl) context.addIssue({ code: "custom", message: "audio_url_witness_mismatch" });
    }),
  z.object({ kind: z.literal("file"), url: z.string().url().max(4096).refine(value => value.startsWith("https://")), name: z.string().min(1).max(200),
    mediaWitness: customerApprovedFileMediaWitnessSchema }).strict().superRefine((payload, context) => {
      if (payload.url !== payload.mediaWitness.approvedFile.publicUrl || payload.name !== payload.mediaWitness.approvedFile.fileName || payload.mediaWitness.approvedFile.deliveryKind !== "file") {
        context.addIssue({ code: "custom", message: "file_payload_witness_mismatch" });
      }
    }),
  z.object({ kind: z.literal("link"), url: z.string().url().max(4096).refine(value => value.startsWith("https://")),
    mediaWitness: customerApprovedFileMediaWitnessSchema }).strict().superRefine((payload, context) => {
      if (payload.url !== payload.mediaWitness.approvedFile.publicUrl || payload.mediaWitness.approvedFile.deliveryKind !== "link") {
        context.addIssue({ code: "custom", message: "link_payload_witness_mismatch" });
      }
    }),
]);
export type CustomerDeliveryPayload = z.infer<typeof customerDeliveryPayloadSchema>;
/** Decoder-only compatibility. Historical URL-only media never becomes a current send capability. */
export type CustomerLegacyStoredMediaPayload = { kind: "legacy_image" | "legacy_audio" | "legacy_file"; url: string; name?: string };
export type CustomerDecodedDeliveryPayload = CustomerDeliveryPayload | CustomerLegacyStoredMediaPayload;
export const customerDeliveryTransportSchema = z.object({
  endpointScopeId: z.string().uuid(), channel: z.enum(["INSTAGRAM", "WHATSAPP", "FACEBOOK", "WEBSITE"]),
  accountId: z.string().uuid().nullable(), accountExternalId: z.string().min(1).max(512).optional(),
  transportKey: z.string().min(1).max(1024), scopeRevision: customerRevisionSchema,
}).strict();
export const customerDeliveryStateSchema = z.enum(["READY", "IN_FLIGHT", "ACCEPTED", "AVAILABLE_WIDGET", "NOT_SENT", "UNKNOWN", "SUPPRESSED"]);
export const customerDeliveryReceiptsSchema = z.array(customerMutationReceiptSchema).max(8);
export const customerDeliveryP03Schema = customerPropertyDeliverySchema.refine(value => value.status === "pending");
export const customerDeliveryFenceSchema = customerFenceSchema.refine(value => value.nativeId !== null);
export type CustomerDeliveryState = z.infer<typeof customerDeliveryStateSchema>;
/** Persisted server record; status is not authorization. Payload is separately
 * authenticated-encrypted; no plaintext/decryptSafe fallback is permitted. */
export interface CustomerOutboxRow {
  id: string; partKey: string; ticketEventKey: string | null; inquiryId: string | null;
  publicMetaCommentId: string | null; publicTelegramCommentId: string | null; publicSourceRevision: bigint | null;
  originalNativeId: string; conversationId: string | null; turnKey: string; ordinal: number;
  mode: string; sourceKind: string; sourceKey: string; agentRevisionId: string | null; channel: string; endpointScopeId: string;
  transportJson: unknown; payloadEncrypted: string; payloadHash: string; payloadVersion: number;
  fenceJson: unknown; p03Json: unknown; receiptRefsJson: unknown; approvedAssetPurpose: string | null; status: string;
  claimRevision: bigint; leaseOwner: string | null; leaseUntil: Date | null;
  nextAttemptAt: Date | null; acceptedAt: Date | null; projectionRecordedAt: Date | null;
  supersededAt: Date | null; cancelRequestedAt: Date | null;
}
export interface CustomerAttemptRow {
  id: string; partId: string; endpointScopeId: string; attemptNo: number; claimRevision: bigint;
  outcome: string; providerMid: string | null; reportedMid: string | null; startedAt: Date; finishedAt: Date | null;
}

/** Purpose-aware structural projection only; dispatcher still validates actual ACK task/controller. */
export function customerDeliveryControllerFence(row: Pick<CustomerOutboxRow, "sourceKind" | "fenceJson">) {
  return row.sourceKind === "HANDOVER_ACK" ? customerHandoverAckFenceSchema.parse(row.fenceJson).after : customerDeliveryFenceSchema.parse(row.fenceJson);
}
