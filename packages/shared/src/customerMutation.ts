import { z } from "zod";
import { customerEndpointRefSchema, customerRevisionSchema } from "./customerState.js";

const reference = z.string().min(1).max(512);
const phone = z.string().min(5).max(40);
const positiveRevision = customerRevisionSchema.refine(value => value !== "0");
const phoneEvidence = z.object({
  endpoint: customerEndpointRefSchema, nativeId: z.string().uuid(),
  eventKey: reference, order: positiveRevision, contactRevision: positiveRevision,
  provenance: z.enum(["meta_signature", "website_application_key"]),
  matchedAccountId: z.string().uuid().nullable(),
  scopeRevision: customerRevisionSchema,
}).strict();
export const customerClaimedContactSchema = z.object({
  version: z.literal(1), provenance: z.literal("customer_stated"),
  name: z.string().trim().min(1).max(160).optional(),
  phone: phone.optional(), extraPhones: z.array(phone).max(3).default([]),
  contactRevision: positiveRevision,
  phoneEvidence: phoneEvidence.optional(),
  evidenceRefs: z.array(reference).min(1).max(16), submittedAt: z.string().datetime(),
}).strict().refine(value => !!value.name || !!value.phone, "Contact must contain a stated slot");
export type CustomerClaimedContact = z.infer<typeof customerClaimedContactSchema>;

/** Proposals contain no routing/identity/actor/action key. The authenticated
 * current-IN adapter separately supplies server-branded write authority. */
export const customerMutationCommandSchema = z.discriminatedUnion("name", [
  z.object({ name: z.literal("save_job_application"), args: z.object({}).strict() }).strict(),
  z.object({ name: z.literal("save_contact"), args: z.object({
    name: z.string().trim().min(1).max(160).optional(), phone: phone.optional(),
  }).strict().refine(value => !!value.name || !!value.phone) }).strict(),
  z.object({ name: z.literal("request_callback"), args: z.object({
    topic: z.string().trim().min(1).max(500),
  }).strict() }).strict(),
  z.object({ name: z.literal("request_handover"), args: z.object({
    topic: z.string().trim().min(1).max(500),
  }).strict() }).strict(),
  z.object({ name: z.literal("book_showing"), args: z.object({
    propertyShortId: z.number().int().positive(), at: z.string().datetime({ offset: true }),
  }).strict() }).strict(),
  z.object({ name: z.literal("reschedule_showing"), args: z.object({
    bookingRef: z.string().uuid(), expectedRevision: positiveRevision, at: z.string().datetime({ offset: true }),
  }).strict() }).strict(),
  z.object({ name: z.literal("cancel_showing"), args: z.object({
    bookingRef: z.string().uuid(), expectedRevision: positiveRevision,
  }).strict() }).strict(),
  z.object({ name: z.literal("ask_owner"), args: z.object({
    question: z.string().trim().min(1).max(1000),
  }).strict() }).strict(),
]);
export type CustomerMutationCommand = z.infer<typeof customerMutationCommandSchema>;

/** Server-only receipt. Never send opaque resource IDs or foreign CRM references
 * to a model/customer. created/already_committed describe local persistence only. */
const legacyCustomerMutationReceiptSchema = z.object({
  version: z.literal(1), actionId: z.string().uuid(), inquiryId: z.string().uuid(),
  kind: z.enum(["contact", "callback", "new_lead"]), generation: positiveRevision,
  outcome: z.enum(["contact_saved", "callback_requested", "new_lead_created"]),
  resourceType: z.enum(["CustomerInquiry", "CallbackRequest", "Client"]), resourceId: z.string().uuid(),
  committedAt: z.string().datetime(),
}).strict().superRefine((value, context) => {
  const expected = { contact: ["contact_saved", "CustomerInquiry"], callback: ["callback_requested", "CallbackRequest"],
    new_lead: ["new_lead_created", "Client"] } as const;
  const pair = expected[value.kind];
  if (value.outcome !== pair[0] || value.resourceType !== pair[1] ||
      (value.kind === "contact" && value.resourceId !== value.inquiryId)) {
    context.addIssue({ code: "custom", message: "Receipt kind/resource mismatch" });
  }
});
const managedCustomerMutationReceiptSchema = z.object({
  version: z.literal(2), actionId: z.string().uuid(), inquiryId: z.string().uuid(),
  kind: z.enum(["handover", "book_showing", "reschedule_showing", "cancel_showing", "owner_question", "job_application"]),
  generation: positiveRevision, publicRef: z.string().uuid(), resourceRevision: positiveRevision,
  outcome: z.enum(["handover_requested", "showing_booked", "showing_rescheduled", "showing_cancelled", "owner_question_recorded", "job_application_saved"]),
  resourceType: z.enum(["CallbackRequest", "Interaction", "OwnerQuestion", "JobApplication"]), resourceId: z.string().uuid(),
  committedAt: z.string().datetime(),
}).strict().superRefine((value, context) => {
  const expected = { handover: ["handover_requested", "CallbackRequest"], book_showing: ["showing_booked", "Interaction"],
    reschedule_showing: ["showing_rescheduled", "Interaction"], cancel_showing: ["showing_cancelled", "Interaction"],
    owner_question: ["owner_question_recorded", "OwnerQuestion"], job_application: ["job_application_saved", "JobApplication"] } as const;
  const pair = expected[value.kind];
  if (value.outcome !== pair[0] || value.resourceType !== pair[1]) context.addIssue({ code: "custom", message: "Receipt kind/resource mismatch" });
});
export const customerMutationReceiptSchema = z.union([legacyCustomerMutationReceiptSchema, managedCustomerMutationReceiptSchema]);
export type CustomerMutationReceipt = z.infer<typeof customerMutationReceiptSchema>;

/** Persisted server-only return address. It never falls back to a Client's
 * current channel and does not itself authorize delivery. */
export const customerOwnerReplyTargetSchema = z.object({
  version: z.literal(1), nativeKind: z.literal("bot"), inquiryId: z.string().uuid(), nativeId: z.string().uuid(),
  channel: z.enum(["WHATSAPP", "INSTAGRAM", "FACEBOOK"]), peer: reference, accountId: z.string().uuid().nullable(),
  endpointScopeId: z.string().uuid(), transportKey: z.string().min(1).max(1024),
  scopeRevision: customerRevisionSchema, bindingRevision: customerRevisionSchema, generation: positiveRevision,
}).strict();
export type CustomerOwnerReplyTarget = z.infer<typeof customerOwnerReplyTargetSchema>;
export const customerRequestTransitionSchema = z.object({
  expectedRevision: positiveRevision, action: z.enum(["accept", "return", "close"]),
}).strict();
export const customerRequestCloseSchema = z.object({ expectedRevision: positiveRevision.optional() }).strict();
export type CustomerMutationResult =
  | { status: "created" | "already_committed"; receipt: CustomerMutationReceipt }
  | { status: "needs_input"; reason: "phone_required" }
  | { status: "denied" | "stale" | "unavailable"; reason: string }
  | { status: "needs_review"; reason: "native_already_linked" | "staff_phone" | "phone_collision" | "callback_no_longer_pending" }
  | { status: "unknown"; reason: "commit_unconfirmed" };

/** Historical receipt must pass the fresh per-kind owner/binding/generation
 * check before this minimal projection is used for an acknowledgement. */
export function projectCustomerMutationReceipt(receipt: CustomerMutationReceipt): {
  outcome: CustomerMutationReceipt["outcome"]; persisted: true;
} {
  const parsed = customerMutationReceiptSchema.parse(receipt);
  return { outcome: parsed.outcome, persisted: true };
}
