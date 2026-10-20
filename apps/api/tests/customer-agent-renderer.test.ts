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
