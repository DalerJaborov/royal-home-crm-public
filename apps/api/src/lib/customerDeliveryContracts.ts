import { z } from "zod";
import { customerFenceSchema, customerMutationReceiptSchema, customerPropertyDeliverySchema, customerRevisionSchema, customerHandoverAckFenceSchema } from "@royal-home/shared";

export const customerDeliveryPayloadSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("text"), text: z.string().trim().min(1).max(12000) }).strict(),
  z.object({ kind: z.literal("image"), url: z.string().url().max(4096).refine(value => value.startsWith("https://")) }).strict(),
  z.object({ kind: z.literal("audio"), url: z.string().url().max(4096).refine(value => value.startsWith("https://")) }).strict(),
  z.object({ kind: z.literal("file"), url: z.string().url().max(4096).refine(value => value.startsWith("https://")), name: z.string().min(1).max(200) }).strict(),
]);
export type CustomerDeliveryPayload = z.infer<typeof customerDeliveryPayloadSchema>;
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
  fenceJson: unknown; p03Json: unknown; receiptRefsJson: unknown; status: string;
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
