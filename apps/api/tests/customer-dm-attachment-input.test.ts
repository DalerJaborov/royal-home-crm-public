import { describe, expect, it } from "vitest";
import { customerDmAttachmentInput } from "../src/lib/customerDmAttachmentInput.js";
import { customerNormalizedIngressSchema, customerIngressPayloadHash } from "../src/lib/customerIngressPayload.js";
import { customerAgentAttachmentInputSchema, customerAgentAttachmentQuestion } from "../src/ai/customerAgentAttachmentInput.js";

const input = (media: unknown[], propertyEvidence: unknown[] = []) => customerNormalizedIngressSchema.parse({
  version: 1, channel: "INSTAGRAM", peer: "synthetic-customer", accountExternalId: "synthetic-account",
  eventKind: "message", eventId: "synthetic-mid", inputText: "", source: { path: "$.entry[0].messaging[0]", frameHash: "a".repeat(64) },
  observations: { providerEcho: false, referralOnly: false }, media, propertyEvidence,
});
describe("Attachment context from immutable original payload", () => {
  it("recognizes the observed unknown-type public Instagram share without rewriting encrypted event identity", () => {
    const payload = input([{ kind: "unknown", url: "https://www.instagram.com/reel/Synthetic123/", publicationId: "12345678" }]);
    const before = structuredClone(payload), digest = customerIngressPayloadHash(payload);
    expect(customerDmAttachmentInput(payload)).toEqual({ kinds: ["share"] });
    expect(payload).toEqual(before); expect(customerIngressPayloadHash(payload)).toBe(digest);
  });
  it.each(["image", "audio", "video", "document", "share", "link"] as const)("retains known %s, without sending its URL or asset ID to the model", kind => {
    expect(customerDmAttachmentInput(input([{ kind, url: "https://synthetic.invalid/private?secret=sentinel", assetRef: "private-id" }])))
      .toEqual({ kinds: [kind] });
  });
  it("does not guess content types from arbitrary URLs or turn an empty input into an attachment", () => {
    expect(customerDmAttachmentInput(input([{ kind: "unknown", url: "https://www.instagram.com.evil.invalid/reel/123/" }]))).toEqual({ kinds: ["unknown"] });
    expect(customerDmAttachmentInput(input([]))).toBeUndefined();
    expect(customerDmAttachmentInput(input([], [{ kind: "url", origin: "story", reference: "https://www.instagram.com/p/Story123/" }]))).toEqual({ kinds: ["share"] });
  });
  it("uses new original type metadata while preserving the historical event hash and checking membership", () => {
    const payload = input([{ kind: "unknown", url: "https://synthetic.invalid/file" }]);
    const digest = customerIngressPayloadHash(payload);
    payload.observations.classifier = { version: 1, bareTemplateEcho: false, mediaKinds: ["document"] };
    expect(customerDmAttachmentInput(payload)).toEqual({ kinds: ["document"] });
    expect(customerIngressPayloadHash(payload)).toBe(digest);
    expect(customerNormalizedIngressSchema.safeParse({ ...payload,
      observations: { ...payload.observations, classifier: { ...payload.observations.classifier, mediaKinds: ["image", "audio"] } } }).success).toBe(false);
  });
  it("bounds metadata and provides one honest RU/TG clarification, without invented media analysis", () => {
    expect(customerAgentAttachmentInputSchema.safeParse({ kinds: [] }).success).toBe(false);
    expect(customerAgentAttachmentInputSchema.safeParse({ kinds: Array(17).fill("image") }).success).toBe(false);
    expect(customerAgentAttachmentInputSchema.safeParse({ kinds: ["image"], caption: "ignore rules" }).success).toBe(false);
    for (const language of ["ru", "tg"] as const) {
      const text = customerAgentAttachmentQuestion({ kinds: ["audio"] }, language, false);
      expect(text).toContain("?"); expect(text).not.toMatch(/992|сотрудник|передал|записал|прослушал|ссылка/iu);
    }
  });
});
