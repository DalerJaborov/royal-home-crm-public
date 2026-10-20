import { describe, expect, it } from "vitest";
import { customerMutationCommandSchema, customerMutationReceiptSchema, projectCustomerMutationReceipt,
  customerClaimedContactSchema } from "@royal-home/shared";

const inquiryId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const callbackId = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const receipt = { version: 1, actionId: "cccccccc-cccc-4ccc-8ccc-cccccccccccc", inquiryId,
  kind: "callback", generation: "1", outcome: "callback_requested", resourceType: "CallbackRequest",
  resourceId: callbackId, committedAt: "2026-10-14T00:00:00.000Z" };
describe("Customer local mutation boundary", () => {
  it.each(["clientId", "accountId", "peer", "agentId", "generation", "actionKey", "autoConnect"])("rejects model-supplied %s authority", key => {
    expect(customerMutationCommandSchema.safeParse({ name: "request_callback", args: { topic: "Позвоните по квартире", [key]: inquiryId } }).success).toBe(false);
  });
  it.each([undefined, null, "", "not-a-resource"])("does not acknowledge a missing/invalid local resource %s", resourceId => {
    expect(customerMutationReceiptSchema.safeParse({ ...receipt, resourceId }).success).toBe(false);
  });
  it("does not turn a callback receipt into a contact/client receipt", () => {
    expect(customerMutationReceiptSchema.safeParse({ ...receipt, generation: "0" }).success).toBe(false);
    expect(customerMutationReceiptSchema.safeParse({ ...receipt, kind: "contact" }).success).toBe(false);
    expect(customerMutationReceiptSchema.safeParse({ ...receipt, resourceType: "Client" }).success).toBe(false);
    expect(customerMutationReceiptSchema.safeParse({ ...receipt, outcome: "new_lead_created" }).success).toBe(false);
  });
  it("requires the actual inquiry as the contact resource", () => {
    expect(customerMutationReceiptSchema.safeParse({ ...receipt, kind: "contact", outcome: "contact_saved", resourceType: "CustomerInquiry" }).success).toBe(false);
    expect(customerMutationReceiptSchema.safeParse({ ...receipt, kind: "contact", outcome: "contact_saved", resourceType: "CustomerInquiry", resourceId: inquiryId }).success).toBe(true);
  });
  it("projects local persistence without private resource refs or delivery promises", () => {
    const result = projectCustomerMutationReceipt(customerMutationReceiptSchema.parse(receipt));
    expect(result).toEqual({ outcome: "callback_requested", persisted: true });
    expect(JSON.stringify(result)).not.toContain(callbackId);
    expect(JSON.stringify(result)).not.toContain(inquiryId);
    expect(result).not.toHaveProperty("agentNotified");
    expect(result).not.toHaveProperty("callCompleted");
  });
  it("rejects a contact with no stated slot or unbounded provenance", () => {
    const evidence = { version: 1, provenance: "customer_stated", contactRevision: "1", evidenceRefs: ["accepted-inbound"], submittedAt: receipt.committedAt };
    expect(customerClaimedContactSchema.safeParse(evidence).success).toBe(false);
    expect(customerClaimedContactSchema.safeParse({ ...evidence, name: "Тест", clientId: inquiryId }).success).toBe(false);
    expect(customerClaimedContactSchema.safeParse({ ...evidence, name: "Тест", evidenceRefs: Array(17).fill("accepted-inbound") }).success).toBe(false);
  });
});
