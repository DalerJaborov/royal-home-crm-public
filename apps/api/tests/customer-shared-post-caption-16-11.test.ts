import { describe, expect, it, vi } from "vitest";
import type { CustomerPropertyAdmission } from "@royal-home/shared";
import { parseIncoming } from "../src/messengers/meta.js";
import { customerPropertyEvidenceFromMeta } from "../src/lib/customerPropertyEvidence.js";
import { resolveCustomerPropertyEvidence, type CustomerPropertyRegistry } from "../src/lib/customerPropertyResolver.js";
import { captionPropertyNumber } from "../src/lib/customerPropertyReferenceText.js";
import { customerCaptionFields, customerCaptionReference, customerCaptionReferenceMatchesCard, customerTextHasOwnMark,
  foldBrandName, type CustomerOwnBrandMarks } from "../src/lib/customerCaptionReference.js";
import { customerBurstFocusFresh, type CustomerBurstReference } from "../src/lib/customerAgentMediaFocus.js";
import { customerPropertyVideoLink, customerPropertyVideoPlan, renderCustomerPropertyVideoAnswer } from "../src/lib/customerPropertyVideoAnswer.js";
import { customerReplyCallsStaff } from "../src/ai/customerAgentStaffFollowUp.js";
import { customerReplyLink } from "../src/lib/customerReplyLink.js";
import { resolveCustomerDmLanguage } from "../src/ai/customerDmLanguage.js";

/**
 * Instagram, 16.11.2026 21:29 (Dushanbe): the customer shared our post of object №178 as two attachments and asked
 * «Хами хонара видеоша дорен». The CRM stored both as «[вложение без текста]» with evidence [], and the bot asked
 * «which object?». Review #225 (17.11) scenarios: H1 service marker, H2 old focus, H3 foreign caption, M1 OCR misread,
 * M2 mixed questions and refusals, M3 bare Tajik phrase. Ids, phones and URLs below are fictional.
 */
const MARKS: CustomerOwnBrandMarks = { names: ["royalhome", "arvan"].map(name => foldBrandName(name)!), phoneTails: ["446501414", "000000001"] };
const OUR_CAPTION = [
  "🏠 Инвестиция в ликвидную недвижимость требует стратегического подхода к выбору локации.",
  "", "✅Район: Исмоили Сомони", "✅Адрес: Воданасос", "✅Количество комнат: 2", "✅Площадь: 105м²", "✅Этаж: 10",
  "✅Цена: 601 250 с. ($65 000)", "", "📲 Звоните или пишите в директ:",
  "+992 00 000-00-01 Агент Тестовая", "+992 44 650-14-14 Royal Home", "", "Объект №178",
].join("\n");
const FOREIGN_CAPTION = "agentstvo_dom.tj\n✅Район: Сино\n✅Цена: 500 000 с.\n📲 +992 90 123-45-67\nОбъект №45";
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
function webhook(attachments: Array<{ type: string; payload: Record<string, unknown> }>) {
  return { object: "instagram", entry: [{ id: "17800000000000001", time: 1_763_310_584_000, messaging: attachments.map((attachment, index) => ({
    sender: { id: "1780000000000000099" }, recipient: { id: "17800000000000001" }, timestamp: 1_763_310_584_000 + index,
    message: { mid: `fictional-mid-${index}`, attachments: [attachment] } })) }] };
}

describe("16.11: the exact payload — two image attachments without caption or publication id", () => {
  it("arrive as two separate image inputs with no text and no property evidence", () => {
    const parsed = parseIncoming(webhook([{ type: "image", payload: { url: CDN(1) } }, { type: "image", payload: { url: CDN(2) } }]),
      undefined, false, { captureCustomerReferences: true });
    expect(parsed).toHaveLength(2);
    for (const message of parsed) {
      expect(message).toMatchObject({ channel: "INSTAGRAM", text: "", attachmentType: "image" });
      expect(message.attachmentTitle).toBeUndefined();
      expect(message.attachmentMediaId).toBeUndefined();
      expect(customerPropertyEvidenceFromMeta(message)).toEqual([]);
    }
  });

  it("a Meta caption is transport data: the webhook evidence is exactly as before (no number from the caption)", () => {
    const [message] = parseIncoming(webhook([{ type: "ig_post", payload: { url: CDN(3), title: OUR_CAPTION, ig_post_media_id: "18000000000000003" } }]),
      undefined, false, { captureCustomerReferences: true });
    expect(message.attachmentTitle).toContain("Объект №178");
    expect(customerPropertyEvidenceFromMeta(message)).toEqual([{ kind: "media", origin: "shared_media", reference: "18000000000000003" }]);
  });
});

describe("H3: a caption/screenshot number counts only next to OUR mark", () => {
  it("our caption: the company line or an agent phone from the CRM, any spacing", () => {
    expect(customerCaptionReference(OUR_CAPTION, MARKS)).toEqual({ shortId: 178, fields: { rooms: 2, areaSqm: 105, district: "Исмоили Сомони" } });
    expect(customerTextHasOwnMark("Звоните: +992 (44) 650 14 14", MARKS)).toBe(true);
    expect(customerTextHasOwnMark("агент 000-000-001", { names: [], phoneTails: ["000000001"] })).toBe(true);
    expect(customerTextHasOwnMark("ROYAL HOME — агентство", MARKS)).toBe(true);
    expect(customerTextHasOwnMark("Арван / Arvan Estate", MARKS)).toBe(true);
  });
  it("a foreign agency's post «Объект №45» is not our №45", () => {
    expect(customerCaptionReference(FOREIGN_CAPTION, MARKS)).toBeNull();
    expect(customerCaptionReference("Объект №45", MARKS)).toBeNull();
  });
  it("our mark but no single explicit number: nothing", () => {
    expect(customerCaptionReference("Royal Home\nОбъект №12 и объект №13", MARKS)).toBeNull();
    expect(customerCaptionReference("Royal Home, дом №12", MARKS)).toBeNull();
    expect(customerCaptionReference("Royal Home · Видео", MARKS)).toBeNull();
  });
  it("a printed listing card may use the bare «№ 77», still only with our mark", () => {
    expect(customerCaptionReference("Royal Home\n№ 77 Сино", MARKS, { listingCard: true })).toMatchObject({ shortId: 77 });
    expect(customerCaptionReference("№ 77 Сино", MARKS, { listingCard: true })).toBeNull();
  });
});

describe("M1: the fields a caption prints must match the CRM card", () => {
  const card = { rooms: 2, areaSqm: "105", districtName: "Исмоили Сомони" };
  it("matching card", () => expect(customerCaptionReferenceMatchesCard(customerCaptionFields(OUR_CAPTION), card)).toBe(true));
  it("a misread number lands on another flat: rooms, area or district disagree → no", () => {
    expect(customerCaptionReferenceMatchesCard({ rooms: 3 }, card)).toBe(false);
    expect(customerCaptionReferenceMatchesCard({ areaSqm: 64 }, card)).toBe(false);
    expect(customerCaptionReferenceMatchesCard({ district: "Сино" }, card)).toBe(false);
    expect(customerCaptionReferenceMatchesCard({ areaSqm: 105.5, district: "р-н Исмоили Сомони" }, card)).toBe(true);
  });
  it("a field the caption or the card lacks is not a conflict", () => {
    expect(customerCaptionReferenceMatchesCard({}, card)).toBe(true);
    expect(customerCaptionReferenceMatchesCard({ rooms: 2 }, { rooms: null, areaSqm: null, districtName: null })).toBe(true);
  });
});

describe("caption number and the shared-post fallback in the resolver", () => {
  it.each([[OUR_CAPTION, "178"], ["Объекти №178", "178"], ["объект #42 — 3 комнаты", "42"], ["Объект №12 и объект №13", null],
    ["Дом №12", null], ["№178", null], ["+992 00 000-00-01, цена 601 250", null], [undefined, null]])("%s → %s",
    (text, expected) => expect(captionPropertyNumber(text)).toBe(expected));

  it("a publication missing from our registry (agent's own account) resolves by its verified caption number", async () => {
    const evidence = [{ kind: "media" as const, origin: "shared_media" as const, reference: "18000000000000003", secondaryReference: "short:178" }];
    expect(await resolveCustomerPropertyEvidence(evidence, scope, registry())).toMatchObject({ status: "resolved", propertyId: property(178) });
  });
  it("a caption that contradicts the registry is a conflict, never a silent pick", async () => {
    const evidence = [{ kind: "media" as const, origin: "shared_media" as const, reference: "18000000000000005", secondaryReference: "short:178" }];
    expect(await resolveCustomerPropertyEvidence(evidence, scope, registry({ media: vi.fn(async () => [property(50)]) })))
      .toMatchObject({ status: "ambiguous", propertyId: null });
  });
  it("two pictures with different numbers stay ambiguous", async () => {
    const evidence = [178, 45].map(n => ({ kind: "public_selector" as const, origin: "message" as const, reference: `short:${n}` }));
    expect(await resolveCustomerPropertyEvidence(evidence, scope, registry())).toMatchObject({ status: "ambiguous", propertyId: null });
  });
});

describe("H2: the video answer uses only an object THIS burst pointed at", () => {
  const ref = (order: number, extra: Partial<CustomerBurstReference> = {}): CustomerBurstReference =>
    ({ eventKey: `e${order}`, order: BigInt(order), media: false, ownEvidence: false, selectors: [], fromCaption: false, evidence: [], ...extra });
  it("16.11: a video screenshot, then our caption screenshot, then the words → fresh", () => {
    const burst = [ref(1, { media: true }), ref(2, { media: true, selectors: [178] }), ref(3)];
    expect(customerBurstFocusFresh({ status: "resolved", eventKey: "e3" }, burst)).toBe(true);
  });
  it("an older focus (a week ago) never answers: not set by this burst", () => {
    expect(customerBurstFocusFresh({ status: "resolved", eventKey: "old" }, [ref(1, { media: true }), ref(2)])).toBe(false);
  });
  it("a picture that pointed at nothing AFTER the reference may be another object → not fresh", () => {
    const burst = [ref(1, { media: true, selectors: [178] }), ref(2, { media: true }), ref(3)];
    expect(customerBurstFocusFresh({ status: "resolved", eventKey: "e3" }, burst)).toBe(false);
  });
  it("a shared post with its own registered id in the burst is a reference", () => {
    const burst = [ref(1, { media: true, ownEvidence: true }), ref(2)];
    expect(customerBurstFocusFresh({ status: "resolved", eventKey: "e1" }, burst)).toBe(true);
    expect(customerBurstFocusFresh({ status: "ambiguous", eventKey: "e1" }, burst)).toBe(false);
  });
});

describe("H1/M2: the video request is decided from the customer's own words", () => {
  it.each(["Хами хонара видеоша дорен", "Салом Алейкум\nХами хонара видеоша дорен", "Видео есть?", "Видеоша равон кунед", "А видео можно?", "video dored?", "Видео объекта №178 есть?"])(
    "plain request: %s", text => expect(customerPropertyVideoPlan(text)).toMatchObject({ facts: [] }));
  it("video + a fact question the CRM answers → both", () => {
    expect(customerPropertyVideoPlan("Видео есть? И сколько стоит?")).toMatchObject({ facts: ["price"] });
    expect(customerPropertyVideoPlan("Видео есть и где находится?")).toMatchObject({ facts: ["address"] });
    expect(customerPropertyVideoPlan("Салом Алейкум\nВидео есть? И сколько стоит?")).toMatchObject({ facts: ["price"] });
  });
  it.each([
    "[вложение: video]\nТакой вариант есть?", // H1: a service marker is never the customer's request
    "Такой вариант есть?", "Видео не нужно", "Видео видел, есть ещё варианты?", "Видео смотрел, хочу такую же", "Видео лозим нест",
    "А ролик есть по Сино?", "Видео есть, сколько?", "Видео пришлю завтра", "Видео мефиристам", "Салом", "Видео тут https://x.y/z",
  ])("not a plain video request (model answers): %s", text => expect(customerPropertyVideoPlan(text)).toBeNull());
});

describe("M3: the bare Tajik phrase is Tajik", () => {
  it("«Хами хонара видеоша дорен» without any history", () => expect(resolveCustomerDmLanguage("Хами хонара видеоша дорен")).toBe("tg"));
  it("a Russian question stays Russian", () => expect(resolveCustomerDmLanguage("А видео этой квартиры есть?")).toBe("ru"));
});

describe("video link and answer", () => {
  it("the published reel of the object is its video; a photo post is not", () => {
    expect(customerPropertyVideoLink("https://www.instagram.com/reel/FICTIONAL2/")).toBe("https://www.instagram.com/p/FICTIONAL2/");
    expect(customerPropertyVideoLink("https://www.instagram.com/p/FICTIONAL3/")).toBeNull();
    expect(customerPropertyVideoLink(null)).toBeNull();
  });
  it("with a video: the link, no promise of an agent", () => {
    expect(renderCustomerPropertyVideoAnswer(178, "https://www.instagram.com/p/FICTIONAL2/", "tg"))
      .toEqual({ agentPromised: false, text: "Бале, видеои объекти №178 ҳаст. Ин ҳавола: https://www.instagram.com/p/FICTIONAL2/" });
  });
  it("without a video: «the agent will send it», flagged so the turn signals the agent itself", () => {
    expect(renderCustomerPropertyVideoAnswer(178, null, "ru")).toEqual({ agentPromised: true, text: "Видео объекта №178 пришлёт вам наш агент." });
    expect(customerReplyCallsStaff(renderCustomerPropertyVideoAnswer(178, null, "ru").text)).toBe(false);
  });
});

describe("review #225, second pass", () => {
  it("N3: «ЖК Royal Park. Объект №45» is a foreign post; the caption with «Royal Home» is ours", () => {
    const marks: CustomerOwnBrandMarks = { names: ["royalhome", "royalhometj"], phoneTails: [] };
    expect(customerCaptionReference("ЖК Royal Park. Объект №45. 2-комнатная, 60 м²", marks)).toBeNull();
    expect(customerCaptionReference("Royal Home\nОбъект №45", marks)).toEqual({ shortId: 45, fields: {} });
    expect(customerCaptionReference("royalhome · Объект №45", marks)).toMatchObject({ shortId: 45 });
    expect(customerCaptionReference("@royal.home.tj\nОбъект №45", marks)).toMatchObject({ shortId: 45 });
  });
  it("N3: a part of a name or a longer word is not our mark", () => {
    const marks: CustomerOwnBrandMarks = { names: ["royalhome", "royalhometj"], phoneTails: [] };
    for (const text of ["Royal Homes — агентство", "royal", "unroyal home", "Royal Hometown", "home royal"]) expect(customerTextHasOwnMark(text, marks)).toBe(false);
    for (const text of ["Royal Home", "ROYAL  HOME!", "RoyalHome", "агентство «Royal Home», Душанбе"]) expect(customerTextHasOwnMark(text, marks)).toBe(true);
  });
  it("N1: one rule of a link — switched off, no link", () => {
    expect(customerReplyLink("https://www.instagram.com/p/X1/", false)).toBeNull();
    expect(customerReplyLink("https://www.instagram.com/p/X1/", true)).toBe("https://www.instagram.com/p/X1/");
    expect(customerReplyLink("https://www.instagram.com/p/X1/", undefined)).toBe("https://www.instagram.com/p/X1/");
    expect(customerReplyLink(null, true)).toBeNull();
  });
  it("N1/N2: a video that exists but may not be linked → «there is a video, the agent will send it» + the agent is called", () => {
    const ru = renderCustomerPropertyVideoAnswer(178, null, "ru", true);
    expect(ru).toEqual({ agentPromised: true, text: "Да, видео объекта №178 есть. Наш агент пришлёт его вам." });
    expect(ru.text).not.toMatch(/https?:/u);
    const tg = renderCustomerPropertyVideoAnswer(178, null, "tg", true);
    expect(tg).toEqual({ agentPromised: true, text: "Бале, видеои объекти №178 ҳаст. Агенти мо онро ба шумо мефиристад." });
    expect(customerReplyCallsStaff(ru.text)).toBe(false);
    expect(customerReplyCallsStaff(tg.text)).toBe(false);
  });
  it("«Видео бор?» is Tajik: the plan says so, and the answer is on «шумо»", () => {
    expect(customerPropertyVideoPlan("Видео бор?")).toEqual({ facts: [], tajik: true });
    expect(customerPropertyVideoPlan("Видеоша дорен?")).toMatchObject({ tajik: true });
    expect(customerPropertyVideoPlan("Видео есть?")).toEqual({ facts: [], tajik: false });
    const answer = renderCustomerPropertyVideoAnswer(178, null, "tg", false).text;
    expect(answer).toContain("ба шумо");
    expect(answer).not.toMatch(/[Тт]у|ба ту/u);
  });
});
