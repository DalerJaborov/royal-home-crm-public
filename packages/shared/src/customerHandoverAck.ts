import { z } from "zod";
import { customerFenceSchema, customerRevisionSchema } from "./customerState.js";
import { customerMutationReceiptSchema } from "./customerMutation.js";

/** Persisted purpose witness, never an authority/grant. */
export const customerHandoverAckFenceSchema = z.object({
  version: z.literal(1), purpose: z.literal("handover_ack"),
  before: customerFenceSchema, after: customerFenceSchema,
  eventKey: z.string().regex(/^[a-f0-9]{64}$/), order: customerRevisionSchema.refine(v => v !== "0"),
  originCipherHash: z.string().regex(/^[a-f0-9]{64}$/),
  originalReceivedAt: z.number().int().nonnegative(), deadlineAt: z.number().int().positive(),
  agentRevisionId: z.string().regex(/^[a-f0-9]{64}$/), providerOperationId: z.string().uuid(),
  receipt: customerMutationReceiptSchema.refine(r => r.version === 2 && r.kind === "handover" &&
    r.outcome === "handover_requested" && r.resourceType === "CallbackRequest"),
  language: z.enum(["ru", "tg"]),
}).strict().superRefine((v, ctx) => {
  const a = v.before, b = v.after;
  if (!a.nativeId || a.nativeId !== b.nativeId || a.inquiryId !== b.inquiryId ||
      JSON.stringify(a.endpoint) !== JSON.stringify(b.endpoint) ||
      a.bindingRevision !== b.bindingRevision || a.scopeRevision !== b.scopeRevision ||
      a.policyRevision !== b.policyRevision || !a.ownerToken || !b.ownerToken || a.ownerToken === b.ownerToken ||
      BigInt(b.ownershipEpoch) !== BigInt(a.ownershipEpoch) + 1n ||
      v.receipt.inquiryId !== b.inquiryId || v.receipt.version !== 2 || v.receipt.resourceRevision !== "1" ||
      v.deadlineAt <= v.originalReceivedAt || v.deadlineAt > v.originalReceivedAt + 15 * 60_000 ||
      !["INSTAGRAM", "FACEBOOK", "WHATSAPP"].includes(b.endpoint.channel)) {
    ctx.addIssue({ code: "custom", message: "Not an exact local BOT to HOLD handover" });
  }
});
export type CustomerHandoverAckFence = z.infer<typeof customerHandoverAckFenceSchema>;

/** No model text, agent-notified/dialled promise, booking, links or new action. */
export function customerHandoverAckText(language: "ru" | "tg"): string {
  return language === "ru" ? "Заявка на связь с сотрудником сохранена." : "Дархости суҳбат бо корманд сабт шуд.";
}
