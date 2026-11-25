import { describe, expect, it } from "vitest";
import { continuationPrefill, findContinuationCode, operatorContactAsk, planOperatorContactButton, stripContinuationMarker,
  type ContactButtonPolicy } from "../src/ai/operator/contactButton.js";
import { OPERATOR_CONTACT_BUTTON_TEXTS } from "../src/ai/operator/phrases.js";
import { buildSendRequest } from "../src/messengers/meta.js";
import { customerDeliveryPayloadSchema } from "../src/lib/customerDeliveryContracts.js";
import { supportsCustomerDeliveryPayload } from "../src/lib/customerDeliveryAdapters.js";
import type { CustomerOutboxRow } from "../src/lib/customerDeliveryContracts.js";
import { continuationSeedState, newWhatsappContinuationCode } from "../src/lib/whatsappContinuation.js";
import { initialOperatorState } from "../src/ai/operator/decide.js";
import type { MetaCredentials } from "../src/messengers/metaTypes.js";

/**
 * КНОПКА ЗВОНКА В WHATSAPP И ССЫЛКА ИЗ INSTAGRAM В WHATSAPP (владелец 25.11.2026) — чистые части: кто просит связаться, когда
 * кнопка уходит, какая у неё форма для Meta, что пропускает очередь отправки, код продолжения. Путь через базу —
 * wa-continuation-postgres.test.ts.
 */
const ON: ContactButtonPolicy = { waCallButton: true, waCallReady: true, withinHours: true, igWhatsappLink: true, waNumber: "992446501414" };
const base = { language: "ru" as const, text: "Вы хотите купить или продать недвижимость?", contactAsk: true, leadAcceptedNow: false,
  closed: false, mainBrand: true, policy: ON, code: "RH-7K3QZP" };

describe("просьба связаться — код, не модель (кириллица через ai/wordBoundary.ts)", () => {
  it.each([
    "Как с вами связаться?", "Дайте ваш номер телефона", "какой у вас номер?", "Можно вам позвонить?", "позвоните мне",
    "номер агента скиньте", "Контакты", "Рақами телефонатонро диҳед", "Чӣ тавр бо шумо тамос гирам?", "Рақами шумо чанд аст",
    "ба шумо занг занам?", "занг занед", "куда звонить?",
  ])("«%s» — просьба", text => expect(operatorContactAsk(text)).toBe(true));
  it.each([
    "Не звоните, пишите", "занг назанед", "мой номер 93 555 44 33", "Хочу купить квартиру", "Сколько стоит?", "Салом",
    "Рақамамро навиштам", "+992935554433", "Какой номер объекта?", "Не позвоните мне, лучше пишите", "Мой телефон для связи",
  ])("«%s» — не просьба", text => expect(operatorContactAsk(text)).toBe(false));
});

describe("когда кнопка уходит", () => {
  it("WhatsApp: просьба связаться — кнопка звонка, строка «кнопка ниже» дописана к ответу", () => {
    const plan = planOperatorContactButton({ ...base, channel: "WHATSAPP" });
    expect(plan?.button).toEqual({ type: "voice_call", displayText: "Позвонить", ttlMinutes: expect.any(Number) });
    expect(plan?.text.startsWith(base.text)).toBe(true);
    expect(OPERATOR_CONTACT_BUTTON_TEXTS.callLine.ru.some(line => plan?.text.endsWith(line))).toBe(true);
  });
  it("WhatsApp: заявка принята этим ходом — кнопка и без просьбы", () => {
    expect(planOperatorContactButton({ ...base, channel: "WHATSAPP", contactAsk: false, leadAcceptedNow: true })?.button.type).toBe("voice_call");
  });
  it.each([
    ["рубильник выключен", { waCallButton: false }],
    ["звонки не готовы (сторож)", { waCallReady: false }],
    ["ночь", { withinHours: false }],
  ])("WhatsApp: %s — обычный текст", (_why, patch) => {
    expect(planOperatorContactButton({ ...base, channel: "WHATSAPP", policy: { ...ON, ...patch } })).toBeNull();
  });
  it("WhatsApp: без просьбы и без заявки, тишина, закрытый жалобой разговор — кнопки нет", () => {
    expect(planOperatorContactButton({ ...base, channel: "WHATSAPP", contactAsk: false })).toBeNull();
    expect(planOperatorContactButton({ ...base, channel: "WHATSAPP", text: null })).toBeNull();
    expect(planOperatorContactButton({ ...base, channel: "WHATSAPP", closed: true })).toBeNull();
  });
  it("Instagram: просьба номера — кнопка wa.me на наш номер с приветствием и кодом в предзаполненном тексте", () => {
    const plan = planOperatorContactButton({ ...base, channel: "INSTAGRAM", language: "tg" });
    expect(plan?.button.type).toBe("web_url");
    const url = plan?.button.type === "web_url" ? plan.button.url : "";
    expect(url.startsWith("https://wa.me/992446501414?text=")).toBe(true);
    expect(decodeURIComponent(url.split("?text=")[1]!)).toBe("Салом! Идома аз Instagram #RH-7K3QZP");
    expect(plan?.button.type === "web_url" && plan.button.title).toBe(OPERATOR_CONTACT_BUTTON_TEXTS.linkTitle.tg);
  });
  it.each([
    ["рубильник выключен", { policy: { ...ON, igWhatsappLink: false } }],
    ["номер WhatsApp не известен", { policy: { ...ON, waNumber: null } }],
    ["чужой бренд (Арван)", { mainBrand: false }],
    ["кода нет", { code: null }],
    ["без просьбы", { contactAsk: false, leadAcceptedNow: true }],
  ])("Instagram: %s — обычный текст", (_why, patch) => {
    expect(planOperatorContactButton({ ...base, channel: "INSTAGRAM", ...patch })).toBeNull();
  });
  it("Facebook: та же ссылка, в тексте ссылки — Facebook", () => {
    const plan = planOperatorContactButton({ ...base, channel: "FACEBOOK" });
    const url = plan?.button.type === "web_url" ? plan.button.url : "";
    expect(decodeURIComponent(url.split("?text=")[1]!)).toBe("Здравствуйте! Продолжение из Facebook #RH-7K3QZP");
  });
  it("тексты кнопок: название ≤ 20 знаков, без «—» и «?», без «қулай»", () => {
    const all = [...OPERATOR_CONTACT_BUTTON_TEXTS.callLine.ru, ...OPERATOR_CONTACT_BUTTON_TEXTS.callLine.tg,
      ...OPERATOR_CONTACT_BUTTON_TEXTS.linkLine.ru, ...OPERATOR_CONTACT_BUTTON_TEXTS.linkLine.tg];
    for (const line of all) { expect(line).not.toMatch(/[—?]/u); expect(line).not.toMatch(/қулай/iu); }
    for (const title of [...Object.values(OPERATOR_CONTACT_BUTTON_TEXTS.callTitle), ...Object.values(OPERATOR_CONTACT_BUTTON_TEXTS.linkTitle)]) {
      expect([...title].length).toBeLessThanOrEqual(20);
    }
  });
});

describe("форма для Meta — та же дверь отправки, что у текста", () => {
  const creds = { waPhoneId: "111", waToken: "t", pageId: "222", pageToken: "p", igToken: "i" } as MetaCredentials;
  it("WhatsApp: interactive voice_call", () => {
    const { body } = buildSendRequest(creds, "WHATSAPP", "992935554433", "Текст", { type: "voice_call", displayText: "Позвонить", ttlMinutes: 240 });
    expect(body).toEqual({ messaging_product: "whatsapp", recipient_type: "individual", to: "992935554433", type: "interactive",
      interactive: { type: "voice_call", body: { text: "Текст" }, action: { name: "voice_call", parameters: { display_text: "Позвонить", ttl_minutes: 240 } } } });
  });
  it("Instagram и Facebook: шаблон button с web_url; Facebook — с messaging_type RESPONSE", () => {
    const button = { type: "web_url" as const, title: "Написать в WhatsApp", url: "https://wa.me/992446501414?text=%D0%A1" };
    const ig = buildSendRequest(creds, "INSTAGRAM", "peer", "Текст", button).body as { message: unknown };
    expect(ig.message).toEqual({ attachment: { type: "template", payload: { template_type: "button", text: "Текст",
      buttons: [{ type: "web_url", url: button.url, title: button.title }] } } });
    expect(buildSendRequest(creds, "FACEBOOK", "peer", "Текст", button).body).toMatchObject({ messaging_type: "RESPONSE" });
  });
  it("без кнопки — прежний текст", () => {
    expect(buildSendRequest(creds, "WHATSAPP", "992935554433", "Текст").body).toEqual({ messaging_product: "whatsapp", to: "992935554433",
      type: "text", text: { body: "Текст" } });
  });
  it("защита по умолчанию: чужая ссылка, кнопка звонка не в WhatsApp, ссылка в WhatsApp, длинное название — отказ до запроса", () => {
    expect(() => buildSendRequest(creds, "INSTAGRAM", "p", "Т", { type: "web_url", title: "Сайт", url: "https://evil.example/992" })).toThrow();
    expect(() => buildSendRequest(creds, "INSTAGRAM", "p", "Т", { type: "voice_call", displayText: "Позвонить", ttlMinutes: 60 })).toThrow();
    expect(() => buildSendRequest(creds, "WHATSAPP", "992935554433", "Т", { type: "web_url", title: "WA", url: "https://wa.me/992446501414" })).toThrow();
    expect(() => buildSendRequest(creds, "WHATSAPP", "992935554433", "Т", { type: "voice_call", displayText: "Очень длинная кнопка звонка", ttlMinutes: 60 })).toThrow();
  });
});

describe("очередь отправки пропускает кнопку только в свой канал", () => {
  const row = (channel: string) => ({ channel } as CustomerOutboxRow);
  it("схема: wa.me — да, другая ссылка — нет", () => {
    expect(customerDeliveryPayloadSchema.safeParse({ kind: "text", text: "Т", button: { type: "web_url", title: "WA", url: "https://wa.me/992446501414?text=a" } }).success).toBe(true);
    expect(customerDeliveryPayloadSchema.safeParse({ kind: "text", text: "Т", button: { type: "web_url", title: "WA", url: "https://example.com/x" } }).success).toBe(false);
    expect(customerDeliveryPayloadSchema.safeParse({ kind: "text", text: "Т" }).success).toBe(true);
  });
  it("адаптер: звонок — только WhatsApp, ссылка — только Instagram/Facebook", () => {
    const call = { kind: "text" as const, text: "Т", button: { type: "voice_call" as const, displayText: "Позвонить", ttlMinutes: 60 } };
    const link = { kind: "text" as const, text: "Т", button: { type: "web_url" as const, title: "WA", url: "https://wa.me/992446501414" } };
    expect(supportsCustomerDeliveryPayload(row("WHATSAPP"), call)).toBe(true);
    expect(supportsCustomerDeliveryPayload(row("INSTAGRAM"), call)).toBe(false);
    expect(supportsCustomerDeliveryPayload(row("INSTAGRAM"), link)).toBe(true);
    expect(supportsCustomerDeliveryPayload(row("FACEBOOK"), link)).toBe(true);
    expect(supportsCustomerDeliveryPayload(row("WHATSAPP"), link)).toBe(false);
    expect(supportsCustomerDeliveryPayload(row("WEBSITE"), link)).toBe(false);
  });
});

describe("код продолжения", () => {
  it("новый код: RH- и шесть знаков без похожих символов", () => {
    for (let i = 0; i < 50; i++) expect(newWhatsappContinuationCode()).toMatch(/^RH-[2-9A-HJKMNP-Z]{6}$/u);
  });
  it("находится в предзаполненном тексте, в любом регистре, и вырезается вместе с нашим началом", () => {
    const text = continuationPrefill("tg", "INSTAGRAM", "RH-7K3QZP");
    expect(findContinuationCode(text)).toBe("RH-7K3QZP");
    expect(findContinuationCode("салом #rh-7k3qzp")).toBe("RH-7K3QZP");
    expect(stripContinuationMarker(text)).toBe("Салом!");
    expect(stripContinuationMarker("Здравствуйте! Продолжение из Instagram #RH-7K3QZP хочу 2 комнаты")).toBe("Здравствуйте! хочу 2 комнаты");
  });
  it("обрывки и чужие метки кодом не считаются", () => {
    for (const text of ["RH-123", "BRH-7K3QZP", "RH-7K3QZP1", "RH-OOOOOO", "номер RH 7K3QZP"]) expect(findContinuationCode(text)).toBeNull();
  });
  it("память для WhatsApp: роль и детали переносятся, служебное — нет; разговор, закрытый жалобой, — без продолжения", () => {
    const source = { ...initialOperatorState(), role: "buyer" as const, step: "contact" as const, language: "tg" as const,
      asked: { role: 1, details: 1, phone: 1 }, staffCalled: true };
    const seed = continuationSeedState(source, false);
    expect(seed).toMatchObject({ role: "buyer", step: "details", language: "tg", leadAccepted: false, staffCalled: false });
    expect(seed?.flags.signaled).toEqual([]);
    expect(continuationSeedState(source, true)).toMatchObject({ step: "done", leadAccepted: true });
    expect(continuationSeedState({ ...source, closed: true }, false)).toBeNull();
  });
});
