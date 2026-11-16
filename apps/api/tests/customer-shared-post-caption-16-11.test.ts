import { describe, expect, it, vi } from "vitest";
import type { CustomerPropertyAdmission } from "@royal-home/shared";
import { parseIncoming } from "../src/messengers/meta.js";
import { customerPropertyEvidenceFromMedia, customerPropertyEvidenceFromMeta } from "../src/lib/customerPropertyEvidence.js";
import { resolveCustomerPropertyEvidence, type CustomerPropertyRegistry } from "../src/lib/customerPropertyResolver.js";
import { captionPropertyNumber } from "../src/lib/customerPropertyReferenceText.js";
import { customerForeignShareCandidate } from "../src/lib/customerSharedPublication.js";
import { customerPropertyVideoLink, customerPropertyVideoRequested, renderCustomerPropertyVideoAnswer } from "../src/lib/customerPropertyVideoAnswer.js";
import { customerReplyCallsStaff } from "../src/ai/customerAgentStaffFollowUp.js";

/**
 * Instagram, 16.11.2026 21:29 (Dushanbe): the customer shared our post of object №178 as two attachments and asked
 * «Хами хонара видеоша дорен». The CRM stored both as «[вложение без текста]» with evidence [], and the bot asked
 * «which object?». Ids, phones and URLs below are fictional; the caption is the shape of our reels template.
 */
const CAPTION = [
  "🏠 Инвестиция в ликвидную недвижимость требует стратегического подхода к выбору локации.",
  "", "✅Район: Исмоили Сомони", "✅Адрес: Воданасос", "✅Количество комнат: 2", "✅Площадь: 105м²", "✅Этаж: 10",
  "✅Цена: 601 250 с. ($65 000)", "", "📲 Звоните или пишите в директ:",
  "+992 00 000-00-01 Агент Тестовая", "+992 00 000-00-02 Royal Home", "", "Объект №178",
].join("\n");
const CDN = (n: number) => `https://lookaside.fbsbx.com/ig_messaging_cdn/?asset_id=1000000000000000${n}&signature=fictional-signature-${n}`;
const property = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const scope: Pick<CustomerPropertyAdmission, "conversationId" | "scopeKey" | "accountId" | "channel"> = {
  conversationId: property(900), scopeKey: "a".repeat(64), accountId: property(901), channel: "INSTAGRAM",
};
function registry(overrides: Partial<CustomerPropertyRegistry> = {}): CustomerPropertyRegistry {
  return { ad: vi.fn(async () => null), media: vi.fn(async () => []), url: vi.fn(async () => []), reply: vi.fn(async () => []),
    selector: vi.fn(async (reference: string) => { const n = Number(reference.replace(/^short:/, "")); return n > 0 ? [property(n)] : []; }),
    ...overrides };
}
/** One Instagram webhook delivery with one messaging event per attachment, exactly as the two events of 16.11 arrived. */
function webhook(attachments: Array<{ type: string; payload: Record<string, unknown> }>) {
  return { object: "instagram", entry: [{ id: "17800000000000001", time: 1_763_310_584_000, messaging: attachments.map((attachment, index) => ({
    sender: { id: "1780000000000000099" }, recipient: { id: "17800000000000001" }, timestamp: 1_763_310_584_000 + index,
    message: { mid: `fictional-mid-${index}`, attachments: [attachment] } })) }] };
}

describe("16.11: the exact payload — two image attachments without caption or publication id", () => {
  const parsed = parseIncoming(webhook([{ type: "image", payload: { url: CDN(1) } }, { type: "image", payload: { url: CDN(2) } }]),
    undefined, false, { captureCustomerReferences: true });

  it("arrive as two separate image inputs with no text and no property evidence (why the CRM showed «[вложение без текста]»)", () => {
    expect(parsed).toHaveLength(2);
    for (const message of parsed) {
      expect(message).toMatchObject({ channel: "INSTAGRAM", text: "", attachmentType: "image" });
      expect(message.attachmentTitle).toBeUndefined();
      expect(message.attachmentMediaId).toBeUndefined();
      expect(customerPropertyEvidenceFromMeta(message)).toEqual([]);
    }
  });

  it("the object is recovered from what was read on the picture: «Объект №178» of our caption", async () => {
    const screenshot = { subject: "other", transcript: "", readableText: `royalhome.tj\n${CAPTION}` };
    const evidence = customerPropertyEvidenceFromMedia(screenshot);
    expect(evidence).toEqual([{ kind: "public_selector", origin: "message", reference: "short:178" }]);
    expect(await resolveCustomerPropertyEvidence(evidence, scope, registry())).toMatchObject({ status: "resolved", propertyId: property(178) });
  });

  it("a house or flat number on a photo is not an object number", () => {
    expect(customerPropertyEvidenceFromMedia({ subject: "building_exterior", transcript: "", readableText: "Дом №12, подъезд 3" })).toEqual([]);
    expect(customerPropertyEvidenceFromMedia({ subject: "home_interior", transcript: "", readableText: "кв. №45" })).toEqual([]);
  });

  it("a listing card and spoken words keep their earlier, wider reading", () => {
    expect(customerPropertyEvidenceFromMedia({ subject: "listing_card", transcript: "", readableText: "№ 77 Сино" }))
      .toEqual([{ kind: "public_selector", origin: "message", reference: "short:77" }]);
    expect(customerPropertyEvidenceFromMedia({ subject: "not_visible", transcript: "мне про объект 64", readableText: "" }))
      .toEqual([{ kind: "public_selector", origin: "message", reference: "short:64" }]);
  });
});

describe("16.11: the same post as a real Instagram share with its caption (payload.title)", () => {
  const share = (type: string, payload: Record<string, unknown>) =>
    parseIncoming(webhook([{ type, payload }]), undefined, false, { captureCustomerReferences: true })[0];

  it("a post of an agent's own account (id not in our registry) resolves by the caption", async () => {
    const message = share("ig_post", { url: CDN(3), title: CAPTION, ig_post_media_id: "18000000000000003" });
    expect(message.attachmentTitle).toContain("Объект №178");
    const evidence = customerPropertyEvidenceFromMeta(message);
    expect(evidence).toEqual([{ kind: "media", origin: "shared_media", reference: "18000000000000003", secondaryReference: "short:178" }]);
    const reads = registry();
    expect(await resolveCustomerPropertyEvidence(evidence, scope, reads)).toMatchObject({ status: "resolved", propertyId: property(178) });
    expect(reads.media).toHaveBeenCalledWith("18000000000000003");
  });

  it("our own registered post still resolves by its id, and the caption agrees", async () => {
    const evidence = customerPropertyEvidenceFromMeta(share("ig_reel", { url: CDN(4), title: CAPTION, reel_video_id: "18000000000000004" }));
    const reads = registry({ media: vi.fn(async (id) => id === "18000000000000004" ? [property(178)] : []) });
    expect(await resolveCustomerPropertyEvidence(evidence, scope, reads)).toMatchObject({ status: "resolved", propertyId: property(178) });
  });

  it("a caption that contradicts the registry is a conflict, never a silent pick", async () => {
    const evidence = customerPropertyEvidenceFromMeta(share("ig_post", { url: CDN(5), title: CAPTION, ig_post_media_id: "18000000000000005" }));
    const reads = registry({ media: vi.fn(async () => [property(50)]) });
    expect(await resolveCustomerPropertyEvidence(evidence, scope, reads)).toMatchObject({ status: "ambiguous", propertyId: null });
  });

  it("a public permalink of a foreign account + our caption resolves through the caption of that same share", async () => {
    const evidence = customerPropertyEvidenceFromMeta(share("share", { url: "https://www.instagram.com/reel/FICTIONAL1/", title: CAPTION }));
    expect(evidence).toEqual([{ kind: "url", origin: "shared_media", reference: "https://www.instagram.com/p/FICTIONAL1/", secondaryReference: "short:178" }]);
    expect(await resolveCustomerPropertyEvidence(evidence, scope, registry())).toMatchObject({ status: "resolved", propertyId: property(178) });
  });

  it("CDN file + caption only: the caption is the single reference (no untrusted CDN url)", async () => {
    const evidence = customerPropertyEvidenceFromMeta(share("share", { url: CDN(6), title: CAPTION }));
    expect(evidence).toEqual([{ kind: "public_selector", origin: "shared_media", reference: "short:178" }]);
    expect(await resolveCustomerPropertyEvidence(evidence, scope, registry())).toMatchObject({ status: "resolved", propertyId: property(178) });
    // Still a share-only input: if the CRM has no object №178 the foreign-share rule applies as before.
    expect(customerForeignShareCandidate({ kinds: ["share"], propertyEvidence: evidence })).toBe(true);
  });

  it("without a caption number nothing changes: CDN-only share stays an untrusted reference, an id stays alone", () => {
    expect(customerPropertyEvidenceFromMeta(share("share", { url: CDN(7), title: "Красивый вид на горы" })))
      .toEqual([{ kind: "untrusted_reference", origin: "shared_media", reference: "untrusted_origin" }]);
    expect(customerPropertyEvidenceFromMeta(share("ig_post", { url: CDN(8), ig_post_media_id: "18000000000000008" })))
      .toEqual([{ kind: "media", origin: "shared_media", reference: "18000000000000008" }]);
  });
});

describe("caption object number", () => {
  it.each([
    [CAPTION, "178"],
    ["Объекти №178", "178"],
    ["объект #42 — 3 комнаты", "42"],
    ["Объект №12 и объект №13", null],
    ["Дом №12", null],
    ["№178", null],
    ["+992 00 000-00-01, цена 601 250", null],
    [undefined, null],
  ])("%s → %s", (text, expected) => expect(captionPropertyNumber(text)).toBe(expected));
});

describe("16.11: «Хами хонара видеоша дорен» — the video answer comes from the CRM", () => {
  it.each(["Хами хонара видеоша дорен", "Видео есть?", "Видеоша равон кунед", "А видео можно?", "video dored?"])("request: %s", text =>
    expect(customerPropertyVideoRequested(text)).toBe(true));
  it.each(["Видео пришлю завтра", "Видео мефиристам", "Видео и цена?", "Салом", "Фото и видео есть?", "Видео тут https://x.y/z"])(
    "not a plain video request: %s", text => expect(customerPropertyVideoRequested(text)).toBe(false));

  it("the published reel of the object is its video; a photo post is not", () => {
    expect(customerPropertyVideoLink("https://www.instagram.com/reel/FICTIONAL2/")).toBe("https://www.instagram.com/p/FICTIONAL2/");
    expect(customerPropertyVideoLink("https://www.instagram.com/p/FICTIONAL3/")).toBeNull();
    expect(customerPropertyVideoLink(null)).toBeNull();
  });

  it("with a video: the link, no promise of an agent", () => {
    const answer = renderCustomerPropertyVideoAnswer(178, "https://www.instagram.com/p/FICTIONAL2/", "tg");
    expect(answer).toEqual({ agentPromised: false, text: "Бале, видеои объекти №178 ҳаст. Ин ҳавола: https://www.instagram.com/p/FICTIONAL2/" });
    expect(renderCustomerPropertyVideoAnswer(178, "https://www.instagram.com/p/FICTIONAL2/", "ru").text).toContain("Вот ссылка");
  });

  it("without a video: honest «the agent will send it», flagged so the turn signals the agent", () => {
    expect(renderCustomerPropertyVideoAnswer(178, null, "tg")).toEqual({ agentPromised: true, text: "Видеои объекти №178-ро агенти мо ба шумо мефиристад." });
    expect(renderCustomerPropertyVideoAnswer(178, null, "ru")).toEqual({ agentPromised: true, text: "Видео объекта №178 пришлёт вам наш агент." });
    // Not one of the model-era staff lines: the deterministic path signals the agent itself (agentPromised).
    expect(customerReplyCallsStaff(renderCustomerPropertyVideoAnswer(178, null, "ru").text)).toBe(false);
  });
});
