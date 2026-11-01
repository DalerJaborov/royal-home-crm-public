import { describe, expect, it } from "vitest";
import { customerAgentVerifiedContextSchema, type CustomerPropertyEvidence, type CustomerPropertyFactKind } from "@royal-home/shared";
import { detectClientLanguage } from "../src/ai/clientLanguage.js";
import { resolveCustomerDmLanguage } from "../src/ai/customerDmLanguage.js";
import { renderCustomerAgentDecision, type CustomerAgentEvidence } from "../src/ai/customerAgentRenderer.js";
import { customerShowingWish } from "../src/ai/customerAgentConversationPolicy.js";
import { customerAgentAttachmentQuestion } from "../src/ai/customerAgentAttachmentInput.js";
import { customerAgentPublicListingSignature, customerAgentSearchFit } from "../src/ai/customerAgentPublicProtocol.js";
import { classifyCustomerPropertyFactIntent } from "../src/lib/customerPropertyFactIntent.js";
import { customerPropertyEvidenceFromMeta } from "../src/lib/customerPropertyEvidence.js";
import { resolveCustomerPropertyEvidence, type CustomerPropertyRegistry } from "../src/lib/customerPropertyResolver.js";

/** 01.11.2026, four live Instagram Direct dialogues (owner screenshots): wrong language, repeated price,
 * no answer to "I want to see it", an ad object not recognised, a long list for an address/photo question. */

describe("colloquial Tajik is not Russian", () => {
  it.each(["Маин хонара фурухтед ё холи не", "Адресаш дар куҷост", "Суроға?", "хонара медидем", "Ин хона фурухта шуд ё не?", "Ман фотоша мефиристам"])(
    "%s", text => {
      expect(detectClientLanguage(text)).toBe("tg");
      expect(resolveCustomerDmLanguage(text, [], "ru")).toBe("tg");
    });
  it.each(["Не подходит, дорого", "Сколько стоит? Можно посмотреть", "Меняем квартиру на дом", "Это быстро? наравне с другими"])(
    "a Russian sentence stays Russian: %s", text => { expect(detectClientLanguage(text)).toBe("ru"); });
  it("one stray Russian word does not switch a Tajik dialogue", () => {
    expect(resolveCustomerDmLanguage("Маин холо кор не", ["Ин хона фурухта шуд?"])).toBe("tg");
    expect(resolveCustomerDmLanguage("Маин холо кор не", [], "tg")).toBe("tg");
  });
  it.each(["Мне нужна двушка в Сино", "Квартира на первом этаже?", "Номер телефона агента", "Фото квартиры можно"])(
    "a plain Russian sentence switches a Tajik dialogue to Russian: %s", text => {
      expect(resolveCustomerDmLanguage(text, ["Ман хона мехохам"], "tg")).toBe("ru");
    });
});

const hash = "a".repeat(64);
const context = (turns: Array<{ role: "user" | "assistant"; text: string }>, language: "ru" | "tg" = "ru") => customerAgentVerifiedContextSchema.parse({
  surface: "dm", revisionId: hash, turns, publicState: { language, topic: "buyer", openQuestion: "none" } });
const user = (text: string) => ({ role: "user" as const, text });
const bot = (text: string) => ({ role: "assistant" as const, text });
const facts = { propertyId: "00000000-0000-4000-8000-000000000069", shortId: 69, publicLink: null, publicAddress: "Сино, Душанбе",
  addressPolicy: "district_city_only" as const, price: "500000", currency: "TJS" as const, availability: "AVAILABLE" as const, builder: null,
  updatedAt: "2026-10-31T00:00:00.000Z", signature: "b".repeat(64),
  characteristics: { type: "APARTMENT" as const, rooms: 2, areaSqm: "65", landAreaSotka: null, floor: 5, totalFloors: 9, condition: "GOOD" as const, marketType: null, stage: null } };
const factEvidence = (kinds: CustomerPropertyFactKind[]): CustomerAgentEvidence => ({ ref: "e0", value: { kind: "facts", kinds, facts } as never });
function render(decision: object, inputText: string, turns: Array<{ role: "user" | "assistant"; text: string }>, evidence: CustomerAgentEvidence[] = [],
  requestedFacts: CustomerPropertyFactKind[] = [], language: "ru" | "tg" = "ru") {
  return renderCustomerAgentDecision({ decision: { social: "none", refs: evidence.map(e => e.ref), ...decision } as never, evidence, language, requestedFacts,
    knownPhoneSource: "none", maxOutputChars: 4000, surface: "dm", inputText, verifiedContext: context(turns, language) });
}

describe("facts said in the last message are not said again under a new question", () => {
  it("the price goes once; the new question goes alone", () => {
    const price = "Цена объекта №69: 500 000 сомони.";
    const text = render({ kind: "reply", question: "budget" }, "понятно", [user("цена"), bot(price)], [factEvidence(["price"])])!;
    expect(text).not.toContain(price);
    expect(text).toContain("Какой бюджет");
  });
  it("a fact asked again is still answered", () => {
    const price = "Цена объекта №69: 500 000 сомони.";
    const text = render({ kind: "reply", question: "budget" }, "цена?", [user("цена"), bot(price)], [factEvidence(["price"])], ["price"])!;
    expect(text).toContain(price);
  });
});

describe("'I want to see it' asks for a showing time", () => {
  it.each(["хочу посмотреть", "Можно посмотреть квартиру?", "хонара медидем", "дидан мехоҳам", "тамошо кардан мехоҳам"])("%s", text => {
    expect(customerShowingWish(text)).toBe(true);
  });
  it.each(["посмотреть фото можно?", "не хочу смотреть", "посмотреть завтра в 14:00", "сколько стоит", "Хорошо, посмотрим",
    "Покажите другие варианты", "Хочу посмотреть варианты двушек", "Фикр карда бинам"])("not a showing wish: %s", text => {
    expect(customerShowingWish(text)).toBe(false);
  });
  it("replaces the phone question and does not repeat the price", () => {
    const price = "Цена объекта №69: 500 000 сомони.";
    const text = render({ kind: "reply", question: "phone" }, "хочу посмотреть", [user("цена"), bot(price)], [factEvidence(["price"])])!;
    expect(text).toBe("Когда вам удобно посмотреть объект? Напишите день и время.");
  });
  it("Tajik", () => {
    const text = render({ kind: "reply", question: "phone" }, "хонара медидем", [user("нархаш")], [factEvidence(["price"])], [], "tg")!;
    expect(text).toContain("Кай барои дидани объект ба шумо қулай аст?");
    expect(text).not.toContain("рақами телефон");
  });
  it("a proposal keeps its confirmation question when re-proposed", () => {
    const proposal: CustomerAgentEvidence = { ref: "p0", value: { kind: "proposal", summary: { ru: "Показ объекта №69: 2 ноября, 16:00.", tg: "Тамошо: 2 ноябр, 16:00." } } };
    const text = render({ kind: "propose", ref: "p0" }, "лучше в 16:00", [bot("Показ объекта №69: 2 ноября, 15:00.\nПодтверждаете?")], [proposal])!;
    expect(text).toContain("Подтверждаете?");
  });
  it("an unknown object is asked first", () => {
    const text = render({ kind: "clarify", question: "property" }, "хочу посмотреть", [user("салом")])!;
    expect(text).toContain("Какой объект вы имеете в виду?");
  });
});

describe("address and photo questions", () => {
  it.each(["адресаш", "адресаш дар кучост?", "суроғааш", "сурогаш куҷост"])("%s is an address question", text => {
    expect(classifyCustomerPropertyFactIntent(text)).toEqual(["address"]);
  });
  it("a lone photo without an object asks for the object number", () => {
    expect(customerAgentAttachmentQuestion({ kinds: ["image"] }, "ru", false)).toContain("Пришлите его номер или ссылку");
    expect(customerAgentAttachmentQuestion({ kinds: ["image"] }, "tg", false)).toContain("Рақам ё пайвандашро фиристед");
  });
  it("Direct gets at most two short cards", () => {
    const args = { type: "APARTMENT" as const, rooms: 2 };
    const cards = [1, 2, 3].map(n => {
      const card = { ...facts, propertyId: `00000000-0000-4000-8000-00000000000${n}`, shortId: 70 + n };
      const data = { type: "APARTMENT" as const, rooms: 2, districtName: "Сино" };
      const listing = { ...data, signature: customerAgentPublicListingSignature(card.signature, data) };
      return { facts: card, listing, match: customerAgentSearchFit(args, listing, { cardTjs: 500000, minTjs: null, maxTjs: null }) };
    });
    const search: CustomerAgentEvidence = { ref: "e0", value: { kind: "property_search", query: args, coverage: "bounded_ranked_pool", poolLimit: 500,
      policyHash: hash, cards } as never };
    const text = render({ kind: "reply", question: "none" }, "двушка в Сино", [], [search])!;
    expect(text).toContain("Объект №71");
    expect(text).toContain("Объект №72");
    expect(text).not.toContain("Объект №73");
    expect(text).not.toMatch(/Этаж|Площадь|Комнат/u);
  });
});

describe("the ad title reaches the core property lookup", () => {
  it("the Meta referral title is kept as ad evidence", () => {
    const evidence = customerPropertyEvidenceFromMeta({ text: "Нархаш чанд?", adId: "ad-1", adPostId: "post-1", adTitle: "3-комн, Сино. Объект №557" } as never);
    expect(evidence).toContainEqual({ kind: "ad", origin: "referral", reference: "ad-1", secondaryReference: "post-1", caption: "3-комн, Сино. Объект №557" });
  });
  it("the resolver hands the title and post id to the registry", async () => {
    const seen: unknown[] = [];
    const registry: CustomerPropertyRegistry = {
      ad: async (id, hint) => { seen.push([id, hint]); return { ids: ["00000000-0000-4000-8000-000000000557"] }; },
      media: async () => [], url: async () => [], reply: async () => [], selector: async () => [],
    };
    const evidence: CustomerPropertyEvidence[] = [{ kind: "ad", origin: "referral", reference: "ad-1", caption: "Объект №557" }];
    const result = await resolveCustomerPropertyEvidence(evidence, { conversationId: "00000000-0000-4000-8000-0000000000aa", scopeKey: hash, accountId: null, channel: "INSTAGRAM" }, registry);
    expect(result.status).toBe("resolved");
    expect(seen).toEqual([["ad-1", { postId: undefined, caption: "Объект №557" }]]);
  });
});
