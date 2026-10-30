import { afterEach, describe, expect, it, vi } from "vitest";
import type { CustomerPropertyEvidence } from "@royal-home/shared";
vi.mock("../src/loadEnv.js", () => ({}));
import { parseIncoming } from "../src/messengers/meta.js";
import { customerPropertyEvidenceFromMeta } from "../src/lib/customerPropertyEvidence.js";
import { customerPropertyUnresolvedReason } from "../src/lib/customerPropertyUnresolvedReason.js";
import { customerDmAttachmentInput } from "../src/lib/customerDmAttachmentInput.js";
import { renderCustomerAgentDecision, type CustomerAgentEvidence, type CustomerAgentObservation } from "../src/ai/customerAgentRenderer.js";
import { normalizeAuthenticatedCustomerIngress } from "../src/lib/customerIngressNormalize.js";
import { registerAuthenticatedMetaCustomerRequest } from "../src/lib/customerIngressAuthority.js";
import { rememberAdReferral, resetMetaPeerMemory } from "../src/messengers/metaPeerMemory.js";

const CDN = "https://scontent-fra5-1.cdninstagram.com/v/t51.12442-15/synthetic_story.jpg?token=synthetic";
const ACCOUNT = "synthetic-account-30-10";
const PEER = "synthetic-peer-30-10";
function frame(message: Record<string, unknown>, extra: Record<string, unknown> = {}) {
  return { object: "instagram", entry: [{ id: ACCOUNT, messaging: [{ sender: { id: PEER }, recipient: { id: ACCOUNT }, timestamp: 1, ...extra,
    ...(Object.keys(message).length ? { message } : {}) }] }] };
}
const storyReply = (story: Record<string, unknown>, text = "салом адрес") => frame({ mid: "mid-story-1", text, reply_to: { story } });
const parse = (body: unknown) => parseIncoming(body, undefined, false, { captureCustomerReferences: true });
function normalized(body: unknown) {
  const raw = Buffer.from(JSON.stringify(body));
  const request = { rawBody: raw, get: () => "sha256=synthetic" };
  registerAuthenticatedMetaCustomerRequest(request);
  return normalizeAuthenticatedCustomerIngress(request as never).entries;
}
afterEach(() => resetMetaPeerMemory());

describe("P1 reply to our own story carries the story media id", () => {
  it("reads reply_to.story.id and turns it into media evidence before any url evidence", () => {
    const [message] = parse(storyReply({ id: "18118597472517514", url: CDN }));
    expect(message.replyToStoryId).toBe("18118597472517514");
    const evidence = customerPropertyEvidenceFromMeta(message);
    expect(evidence).toContainEqual({ kind: "media", origin: "story", reference: "18118597472517514" });
    // The CDN link is transport data: it must not poison the resolution with untrusted_origin.
    expect(evidence.some(item => item.kind === "untrusted_reference")).toBe(false);
  });
  it("a reaction-only story reply (no text, id only) is still a message", () => {
    const [message] = parse(frame({ mid: "mid-story-2", reply_to: { story: { id: "18118597472517514" } } }));
    expect(message?.replyToStoryId).toBe("18118597472517514");
  });
  it("without an id the old url evidence stays (untrusted CDN origin)", () => {
    const [message] = parse(storyReply({ url: CDN }));
    expect(message.replyToStoryId).toBeUndefined();
    expect(customerPropertyEvidenceFromMeta(message)).toContainEqual({ kind: "untrusted_reference", origin: "story", reference: "untrusted_origin" });
  });
  it("a story reply counts as a shared publication for the attachment reader", () => {
    const [message] = parse(storyReply({ id: "18118597472517514", url: CDN }, ""));
    const [entry] = normalized(storyReply({ id: "18118597472517514", url: CDN }, ""));
    expect(entry.propertyEvidence).toContainEqual({ kind: "media", origin: "story", reference: "18118597472517514" });
    expect(customerDmAttachmentInput(entry)).toEqual({ kinds: ["share"] });
    expect(message.text).toBe("");
  });
});

describe("P1 an ad without a link or number says so in its own words", () => {
  const ad: CustomerPropertyEvidence[] = [{ kind: "ad", origin: "remembered_referral", reference: "1234567890" }];
  it("ad-only evidence that did not resolve is ad_unmapped, a link problem stays a link problem", () => {
    expect(customerPropertyUnresolvedReason(ad, "missing")).toBe("ad_unmapped");
    expect(customerPropertyUnresolvedReason([...ad, { kind: "untrusted_reference", origin: "message", reference: "untrusted_origin" }], "missing")).toBe("untrusted_origin");
    expect(customerPropertyUnresolvedReason([{ kind: "url", origin: "message", reference: "https://royalhome.tj/listing/1" }], "missing")).toBe("not_found");
    expect(customerPropertyUnresolvedReason(ad, "missing", 1)).toBe("lookup_unavailable");
  });
  const unresolved = (reason: string): CustomerAgentEvidence => ({ ref: "e0", value: { kind: "property_unresolved", status: "missing", reason } as CustomerAgentObservation });
  const render = (language: "ru" | "tg") => renderCustomerAgentDecision({ decision: { kind: "reply", refs: ["e0"], social: "none", question: "property" } as never,
    evidence: [unresolved("ad_unmapped")], language, requestedFacts: [], knownPhoneSource: "none", maxOutputChars: 4000, surface: "dm" }) ?? "";
  it("the line has no «link or number» wording in either language", () => {
    const ru = render("ru").split(String.fromCharCode(10))[0], tg = render("tg").split(String.fromCharCode(10))[0];
    expect(ru).toContain("По этой рекламе объект не определился");
    expect(ru).not.toMatch(/ссылк|номеру/u);
    expect(tg).toContain("Аз рӯи ин реклама объект муайян нашуд");
    expect(tg).not.toMatch(/пайванд|рақам ёфт/u);
  });
});

describe("P1 a click on our ad (referral without a message) reaches the next CORE message", () => {
  const text = (value: string, id = "mid-after-ad") => frame({ mid: id, text: value });
  it("adds the remembered ad as evidence when the message has no property reference of its own", () => {
    rememberAdReferral("INSTAGRAM", PEER, { adId: "ad-synthetic-1", adPostId: "post-synthetic-1" }, Date.now() - 60_000, ACCOUNT);
    const [entry] = normalized(text("Салом, нарх чанд?"));
    expect(entry.propertyEvidence).toContainEqual({ kind: "ad", origin: "remembered_referral", reference: "ad-synthetic-1", secondaryReference: "post-synthetic-1" });
  });
  it("is deterministic for a redelivery (the memory is not consumed by reading)", () => {
    rememberAdReferral("INSTAGRAM", PEER, { adId: "ad-synthetic-1" }, Date.now(), ACCOUNT);
    expect(normalized(text("Салом"))[0].propertyEvidence).toEqual(normalized(text("Салом"))[0].propertyEvidence);
    expect(normalized(text("Салом"))[0].propertyEvidence.some(item => item.kind === "ad")).toBe(true);
  });
  it("a redelivered older message does not pick up a click that came after it", () => {
    expect(normalized(text("Салом", "mid-old"))[0].propertyEvidence).toEqual([]);
    rememberAdReferral("INSTAGRAM", PEER, { adId: "ad-synthetic-1" }, Date.now(), ACCOUNT);
    expect(normalized(text("Салом", "mid-old"))[0].propertyEvidence).toEqual([]);
    expect(normalized(text("Салом", "mid-new"))[0].propertyEvidence.some(item => item.kind === "ad")).toBe(true);
  });
  it("does not add it after ten minutes", () => {
    rememberAdReferral("INSTAGRAM", PEER, { adId: "ad-synthetic-1" }, Date.now() - 11 * 60_000, ACCOUNT);
    expect(normalized(text("Салом"))[0].propertyEvidence.some(item => item.kind === "ad")).toBe(false);
  });
  it("does not add it to another account's or another peer's message", () => {
    rememberAdReferral("INSTAGRAM", "someone-else", { adId: "ad-synthetic-1" }, Date.now(), ACCOUNT);
    rememberAdReferral("INSTAGRAM", PEER, { adId: "ad-synthetic-1" }, Date.now(), "another-account");
    expect(normalized(text("Салом"))[0].propertyEvidence.some(item => item.kind === "ad")).toBe(false);
  });
  it("does not mix it with an explicit reference typed in the message", () => {
    rememberAdReferral("INSTAGRAM", PEER, { adId: "ad-synthetic-1" }, Date.now(), ACCOUNT);
    const [entry] = normalized(text("а вот этот номер 123456 сколько?"));
    expect(entry.propertyEvidence.some(item => item.kind === "ad")).toBe(false);
    expect(entry.propertyEvidence.length).toBeGreaterThan(0);
  });
  it("a message that carries its own referral keeps it", () => {
    rememberAdReferral("INSTAGRAM", PEER, { adId: "ad-old" }, Date.now(), ACCOUNT);
    const [entry] = normalized(frame({ mid: "mid-own", text: "Салом", referral: { source: "ADS", ad_id: "ad-own" } }));
    expect(entry.propertyEvidence.filter(item => item.kind === "ad")).toEqual([{ kind: "ad", origin: "referral", reference: "ad-own" }]);
  });
});
