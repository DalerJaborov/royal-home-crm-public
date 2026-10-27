import { createHash, randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { customerAgentDeliveryEvidenceSchema, customerAgentCompanyPolicyObservationSchema } from "@royal-home/shared";
import { encryptSecret } from "../src/crypto.js";
import { customerDeliveryPayloadSchema } from "../src/lib/customerDeliveryContracts.js";
import { decodeCustomerOutboxPayload, decodeCustomerOutboxPublicData } from "../src/lib/customerOutbox.js";
import { currentCustomerAgentKnowledgeHash, readCustomerAgentCompanyKnowledge } from "../src/lib/customerAgentPublicReads.js";
import { readDmCustomerAgentDataWitness, readPublicCustomerAgentDataWitness } from "../src/lib/customerAgentDeliveryEvidence.js";
import type { CustomerPrincipal } from "../src/lib/customerPrincipal.js";
import type { CustomerAgentClaim } from "../src/lib/customerAgentClaim.js";
import type { PublicCommentPrincipal } from "../src/lib/publicCommentSourceIssuer.js";

const revision = "a".repeat(64);
function metadata() {
  const topic = "commission" as const;
  return customerAgentDeliveryEvidenceSchema.parse({ version: 1, agentRevisionId: revision,
    knowledgeSourceHash: currentCustomerAgentKnowledgeHash(), linkPreference: "social",
    observations: [customerAgentCompanyPolicyObservationSchema.parse({ kind: "company_policy", topic,
      sourceHash: currentCustomerAgentKnowledgeHash(), knowledge: readCustomerAgentCompanyKnowledge() })] });
}
function encrypted(raw: unknown, payloadVersion = 1) {
  const plain = JSON.stringify(raw);
  return { payloadVersion, payloadEncrypted: encryptSecret(plain),
    payloadHash: createHash("sha256").update(plain).digest("hex") };
}

describe("P12 exact public-data sideband boundary", () => {
  it("keeps authenticated sideband out of provider text while exposing it separately for freshness", () => {
    const publicData = metadata(), row = encrypted({ kind: "text", text: "Комиссия по правилам агентства.", publicData });
    expect(decodeCustomerOutboxPayload(row)).toEqual({ kind: "text", text: "Комиссия по правилам агентства." });
    expect(decodeCustomerOutboxPublicData(row)).toEqual(publicData);
    // A model/business payload may not inject metadata directly.
    expect(customerDeliveryPayloadSchema.safeParse({ kind: "text", text: "Ответ", publicData }).success).toBe(false);
  });
  it("preserves legacy text and image payloads, but refuses malformed metadata instead of dropping it", () => {
    const legacy = encrypted({ kind: "text", text: "Здравствуйте." });
    expect(decodeCustomerOutboxPayload(legacy)).toEqual({ kind: "text", text: "Здравствуйте." });
    expect(decodeCustomerOutboxPublicData(legacy)).toBeNull();
    const image = encrypted({ kind: "image", url: "https://example.invalid/owned.jpg" });
    expect(decodeCustomerOutboxPayload(image)).toEqual({ kind: "legacy_image", url: "https://example.invalid/owned.jpg" });
    expect(decodeCustomerOutboxPublicData(image)).toBeNull();
    const malformed = encrypted({ kind: "text", text: "Ответ", publicData: { ...metadata(), permission: true } });
    expect(() => decodeCustomerOutboxPayload(malformed)).toThrow();
    expect(() => decodeCustomerOutboxPublicData(malformed)).toThrow();
  });
  it("accepts v2 only for the sealed buyer-guide follow base text", () => {
    const guideFollow = customerAgentDeliveryEvidenceSchema.parse({ version: 1, agentRevisionId: revision,
      knowledgeSourceHash: currentCustomerAgentKnowledgeHash(), linkPreference: "social", observations: [],
      guideFollow: { version: 1, kind: "buyer_guide_follow", language: "ru" } });
    const allowed = encrypted({ kind: "text", text: "Этот файл доступен подписчикам страницы. Подпишитесь и напишите здесь.", publicData: guideFollow }, 2);
    expect(decodeCustomerOutboxPayload(allowed)).toMatchObject({ kind: "text" });
    expect(decodeCustomerOutboxPublicData(allowed)).toEqual(guideFollow);
    const unrelated = encrypted({ kind: "text", text: "Ответ", publicData: metadata() }, 2);
    expect(() => decodeCustomerOutboxPayload(unrelated)).toThrow();
    expect(() => decodeCustomerOutboxPublicData(unrelated)).toThrow();
  });
  it("retains encrypted-payload integrity checks for both decoding surfaces", () => {
    const row = encrypted({ kind: "text", text: "Ответ", publicData: metadata() });
    for (const bad of [{ ...row, payloadVersion: 9 }, { ...row, payloadHash: "0".repeat(64) }]) {
      expect(() => decodeCustomerOutboxPayload(bad)).toThrow();
      expect(() => decodeCustomerOutboxPublicData(bad)).toThrow();
    }
  });
  it("cannot turn parsed principal/claim JSON into a read witness on either surface", async () => {
    const call = { name: "get_company_policy", args: { topic: "commission" } };
    const dm = await readDmCustomerAgentDataWitness({ principal: { id: randomUUID() } as unknown as CustomerPrincipal,
      claim: { eventKey: "a".repeat(64) } as unknown as CustomerAgentClaim, call });
    const publicComment = await readPublicCustomerAgentDataWitness({
      principal: { visibility: "public", privateAuthorization: "none" } as PublicCommentPrincipal,
      call, linkPreference: "social" });
    expect(dm).toEqual({ status: "denied", reason: "original_context_changed" });
    expect(publicComment).toEqual({ status: "denied", reason: "original_context_changed" });
  });
});
