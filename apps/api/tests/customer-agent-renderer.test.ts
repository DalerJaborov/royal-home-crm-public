import { describe, expect, it } from "vitest";
import { renderCustomerAgentDecision, type CustomerAgentEvidence } from "../src/ai/customerAgentRenderer.js";
import { PUBLIC_AGENCY_CONTACT } from "../src/lib/publicAgencyContact.js";

const facts = { propertyId: "00000000-0000-4000-8000-000000000001", shortId: 123, price: "123456.78", currency: "TJS" as const,
  availability: "AVAILABLE" as const, publicAddress: "Synthetic district, Душанбе", addressPolicy: "district_city_only" as const,
  builder: null, publicLink: null, updatedAt: "2026-10-15T00:00:00.000Z", signature: "a".repeat(64) };
function render(evidence: CustomerAgentEvidence[], extra = {}) {
  return renderCustomerAgentDecision({ decision: { kind: "reply", refs: ["e0"], social: "none", question: "none" },
    evidence, language: "ru", requestedFacts: [], knownPhoneSource: "none", maxOutputChars: 2000, surface: "dm", ...extra });
}
describe("CustomerAgentRenderer draft verified-segment obligations", () => {
  it.each(["Здравствуйте", "🔥🔥👏", "Сколько стоит?", "Позвоните мне", "Мой номер +992000000000", "номер квартиры 123", "Номер не нужен", "Не присылайте телефон", "Не отправляйте номер", "Ваш телефон не работает?", "Номертон кор намекунад", "Мне не звонили"])("does not publish the agency number on %s, even if the model selected its evidence", inputText => {
    const text = render([{ ref: "e0", value: { kind: "agency_contact", contact: { ...PUBLIC_AGENCY_CONTACT } } }], {
      inputText, decision: { kind: "reply", refs: ["e0"], social: "greet", question: "none" },
    });
    expect(text).toBe("Здравствуйте!");
  });
  it.each(["Номер?", "Как с вами связаться?", "Напишите ваш телефон", "Можно номер телефона?", "номер телефона чанд боша", "Рақаматон чанд?", "Номертонро нависед", "Как вам позвонить?", "Ваш WhatsApp?", "Цена и ваш номер?"])("preserves an explicit contact request: %s", inputText => {
    expect(render([{ ref: "e0", value: { kind: "agency_contact", contact: { ...PUBLIC_AGENCY_CONTACT } } }], { inputText }))
      .toBe(`Позвоните: ${PUBLIC_AGENCY_CONTACT.phone}.`);
  });
  it("keeps exact decimal currency and only public geography", () => {
    const text = render([{ ref: "e0", value: { kind: "facts", facts, kinds: ["price", "address", "builder"] } }]);
    expect(text).toContain("123 456.78 сомони"); expect(text).toContain(facts.publicAddress);
    expect(text).toContain("Нет подтверждённых данных о застройщике");
    expect(text).not.toContain(facts.propertyId); expect(text).not.toContain(facts.signature);
  });
  it("does not pretend an absent price is zero or infer a builder", () => {
    expect(render([{ ref: "e0", value: { kind: "facts", facts: { ...facts, price: null }, kinds: ["price", "builder"] } }]))
      .toBe("Точную цену пока не могу подтвердить.\nНет подтверждённых данных о застройщике.");
  });
  it("keeps USD instead of silently converting at an invented rate", () => {
    expect(render([{ ref: "e0", value: { kind: "facts", facts: { ...facts, currency: "USD" }, kinds: ["price"] } }]))
      .toContain("123 456.78 USD");
  });
  it("never truncates a critical amount to satisfy the text cap", () => {
    expect(render([{ ref: "e0", value: { kind: "facts", facts, kinds: ["price"] } }], { maxOutputChars: 5 })).toBeNull();
  });
  it("a server-validated proposal gets one confirmation question without claiming execution", () => {
    const text = render([{ ref: "e0", value: { kind: "proposal", summary: { ru: "Предложение: показ указанного объекта в указанное время.", tg: "Пешниҳод барои тамошо." } } }],
      { decision: { kind: "propose", ref: "e0", social: "acknowledge" } });
    expect(text).toContain("Предложение"); expect(text).toContain("Подтверждаете?");
    expect(text?.match(/[?？]/gu)).toHaveLength(1); expect(text).not.toContain("создана");
  });
  it("fabricated proposal reference has no customer output", () => {
    expect(render([], { decision: { kind: "propose", ref: "e0", social: "none" } })).toBeNull();
  });
  it("known-phone suppression preserves the local receipt instead of erasing the answer", () => {
    expect(render([{ ref: "e0", value: { kind: "receipt", outcome: "contact_saved" } }],
      { knownPhoneSource: "scoped_contact", decision: { kind: "reply", refs: ["e0"], social: "none", question: "phone" } }))
      .toBe("Контактные данные сохранены.");
  });
  it("unknown transport/API phone cannot become the agency number", () => {
    expect(render([{ ref: "e0", value: { kind: "agency_contact", contact: { phone: "+992 77 777 6001", digits: "992777776001", channel: "telephone" } } }])).toBeNull();
  });
  it.each(["phone", "name", "callback_consent"])("public %s request renders only actual server agency telephone", question => {
    const text = render([{ ref: "e0", value: { kind: "agency_contact", contact: { ...PUBLIC_AGENCY_CONTACT } } }], {
      surface: "public_comment", inputText: "Номер телефона?", decision: { kind: "reply", refs: [], social: "none", question },
    });
    expect(text).toBe(`Позвоните: ${PUBLIC_AGENCY_CONTACT.phone}.`);
  });
});

describe("grounded free phrase (say) in the rendered answer (24.10)", () => {
  const evidence: CustomerAgentEvidence[] = [{ ref: "e0", value: { kind: "facts", facts, kinds: ["price"] } }];
  const withSay = (say: string | undefined, extra: Record<string, unknown> = {}, decision: Record<string, unknown> = {}) => render(evidence, {
    inputText: "Здравствуйте, сколько стоит объект 123",
    decision: { kind: "reply", refs: ["e0"], social: "none", question: "none", ...(say === undefined ? {} : { say }), ...decision }, ...extra });
  const price = "Цена объекта №123: 123 456.78 сомони.";
  it("puts the phrase before the facts and nothing else changes", () => {
    expect(withSay("Понял, вас интересует этот объект.")).toBe(`Понял, вас интересует этот объект.\n${price}`);
    expect(withSay(undefined)).toBe(price);
  });
  it("replaces the stock acknowledgement «Понял.» instead of adding to it", () => {
    expect(withSay(undefined, {}, { social: "acknowledge" })).toBe(`Понял.\n${price}`);
    expect(withSay("Спасибо, что рассказали о своей ситуации.", {}, { social: "acknowledge" })).toBe(`Спасибо, что рассказали о своей ситуации.\n${price}`);
    expect(withSay("Спасибо, что рассказали о своей ситуации.", {}, { social: "thank" })).not.toContain("Спасибо!");
  });
  it("keeps the greeting first, then the phrase, then the facts, and the one template question last", () => {
    const text = withSay("Давайте разберёмся вместе.", {}, { social: "greet", question: "location" }) ?? "";
    expect(text.split("\n")).toEqual(["Здравствуйте!", "Давайте разберёмся вместе.", price, "Какой район вам подходит?"]);
  });
  it("drops a refused phrase silently: the template reply is unchanged, never empty or held", () => {
    for (const say of ["Это стоит пять тысяч.", "Мы вам позвоним.", "Какой район вам нужен?", "Я бот компании.", "Пишите в вотсап."]) {
      expect(withSay(say)).toBe(price);
      expect(withSay(say, {}, { social: "acknowledge" })).toBe(`Понял.\n${price}`);
    }
  });
  it("re-validates deterministically: the same inputs always give the same text", () => {
    const first = withSay("Понял, вас интересует этот объект.");
    for (let i = 0; i < 5; i++) expect(withSay("Понял, вас интересует этот объект.")).toBe(first);
  });
  it("ignores the phrase outside a private message and for Tajik (off in v1)", () => {
    expect(withSay("Понял, вас интересует этот объект.", { surface: "public_comment" })).toBe(price);
    expect(withSay("Фаҳмидам, шуморо ин объект ҷалб кардааст.", { language: "tg" })).not.toContain("Фаҳмидам");
  });
  it("checks the phrase against the customer's words and earlier bot turns carried in the context", () => {
    const verifiedContext = { surface: "dm" as const, revisionId: "a".repeat(64), publicState: { topic: "unknown" } as never,
      turns: [{ role: "assistant" as const, text: "Понял, вас интересует этот объект." }] };
    expect(withSay("Понял, вас интересует этот объект.", { verifiedContext })).toBe(price);
    expect(withSay("Хорошо, давайте разберёмся.", { verifiedContext })).toBe(`Хорошо, давайте разберёмся.\n${price}`);
  });
  it("lets a call word through only when the decision points at a callback receipt", () => {
    const receipt: CustomerAgentEvidence = { ref: "e1", value: { kind: "receipt", outcome: "callback_requested" } };
    const decision = { kind: "reply" as const, refs: ["e0", "e1"], social: "none" as const, question: "none" as const, say: "Хорошо, мы вам позвоним." };
    const rendered = (refs: string[]) => render([...evidence, receipt], { decision: { ...decision, refs }, inputText: "Перезвоните мне, пожалуйста" });
    expect(rendered(["e0", "e1"])).toContain("Хорошо, мы вам позвоним.");
    expect(rendered(["e0"])).not.toContain("позвоним");
  });
  it("does not make a say-only answer out of nothing: no evidence, no question, no social act is still empty", () => {
    expect(render([], { decision: { kind: "reply", refs: [], social: "none", question: "none", say: "Понял, вас интересует этот объект." }, inputText: "Привет" })).toBeNull();
  });
});
