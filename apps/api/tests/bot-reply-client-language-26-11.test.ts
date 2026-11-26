import { describe, expect, it, vi } from "vitest";

// Живых вызовов модели нет: транспорт (callAiText) подменён и падает; перевод — подставной моделью в каждом тесте.
const callAiText = vi.fn(async (): Promise<unknown> => { throw new Error("нет ключа на стенде"); });
vi.mock("../src/ai/client.js", async (importOriginal) => ({ ...(await importOriginal<typeof import("../src/ai/client.js")>()), callAiText }));

const { runOperatorTurn } = await import("../src/ai/operator/index.js");
const { checkTranslatedReply, foreignClientLanguage, foreignReplyLanguage, translateClientReply } = await import("../src/ai/clientReplyLanguage.js");
type Ctx = import("../src/ai/operator/types.js").OperatorContext;
type Model = import("../src/ai/leadOnlyIntent.js").LeadOnlyIntentModel;

/**
 * ЯЗЫК ОТВЕТА = ЯЗЫК КЛИЕНТА (решение владельца 26.11.2026). До правки (ФАКТ, прогон runOperatorTurn 26.11): английский,
 * узбекский, испанский и арабский клиент получал русскую фразу. Теперь: русский и таджикский — готовые фразы как раньше; любой
 * другой — русская фраза переводом на язык клиента (одна дверь ai/clientReplyLanguage.ts); перевод не удался — русская фраза.
 */
const ctx: Ctx = { channel: "INSTAGRAM", phoneKnown: false, leadExists: false, leadPending: false, cardAgentActive: true,
  noAgentWhen: { ru: "завтра с 09:30", tg: "пагоҳ аз соати 09:30" }, recruiterPath: false, ad: { topic: null, propertyId: null },
  focus: null, callbackWhen: { ru: "в ближайшее время", tg: "ба зудӣ" }, maxPhoneAsks: 2,
  vacancies: { open: [], contactPhone: "+992 00 000 00 01" }, brandName: "Royal Home", officePhone: "+992 00 000 00 02",
  sellerCommissionPercent: 2, outOfArea: false };
/** Понимание лежит — запасные правила кода (язык решает код в любом случае). */
const down: Model = async () => { throw new Error("down"); };
const ASK_ROLE_RU = "Вы хотите купить или продать недвижимость?";
const TRANSLATIONS: Record<string, Record<string, string>> = {
  English: { [ASK_ROLE_RU]: "Would you like to buy or sell a property?" },
  Uzbek: { [ASK_ROLE_RU]: "Siz koʻchmas mulk sotib olmoqchimisiz yoki sotmoqchimisiz?" },
};
/** Подставной переводчик: запоминает, на какой язык просили, и отвечает переводом из таблицы. */
function translator() {
  const asked: string[] = [];
  const model: Model = async request => {
    const user = JSON.parse(request.user) as { targetLanguage: string; sample: string };
    asked.push(user.targetLanguage);
    const table = Object.entries(TRANSLATIONS).find(([name]) => user.targetLanguage.startsWith(name))?.[1];
    return { reply: table?.[user.sample] ?? "" };
  };
  return { model, asked };
}
const turn = (current: string, opts: { stored?: unknown; recent?: { role: "user" | "assistant"; text: string }[]; model?: Model } = {}) =>
  runOperatorTurn({ storedState: opts.stored ?? null, input: { current, ...(opts.recent ? { recent: opts.recent } : {}) }, ctx, model: down,
    ...(opts.model ? { translateModel: opts.model } : {}) });

describe("определение другого языка (код, не модель)", () => {
  it.each([
    ["Hello, I want to buy an apartment, how much is it?", "en"],
    ["Do you have houses for sale in the center?", "en"],
    ["Assalomu alaykum, uy sotib olmoqchiman, qancha turadi?", "uz"],
    ["Ассалому алайкум, уй сотиб олмоқчиман, қанча туради?", "uz"],
    ["Hola, quiero comprar un piso", "other"],
    ["مرحبا أريد شراء شقة", "other"],
    ["Сәлеметсіз бе, пәтер сатып алғым келеді", "other"],
  ] as const)("«%s» → %s", (text, expected) => {
    expect(foreignClientLanguage(text)).toBe(expected);
  });

  it.each([
    "Хочу купить квартиру в Сино", "Мехоҳам хона харам дар Сино", "salom, men khona kharidan mekhoham, chand pul?",
    "Салом, цена квартиры?", "Skolko stoit kvartira?", "Kvartira price?", "ok", "Thank you", "Hello", "Рахмат", "+992 90 123 45 67",
    // Кнопка рекламы Meta на узбекском — не слова клиента (ai/adTemplatePhrase.ts): языка не задаёт.
    "Bu haqida yana maʼlumot olsam boʻladimi?",
    // «һ» и «ү» вместо «ҳ» и «ӯ» на чужой раскладке — всё ещё таджикский.
    "Меһоҳам хона харам, нархаш чанд?", "Хонаро мефүрӯшам",
  ])("«%s» → не другой язык (решают прежние правила ru/tg)", text => {
    expect(foreignClientLanguage(text)).toBeNull();
  });

  it("смена посреди разговора: короткое «ok» держит другой язык, ясная русская фраза его снимает", () => {
    expect(foreignReplyLanguage("ok", ["Hello, do you have apartments in Sino?"])).toBe("en");
    expect(foreignReplyLanguage("Хочу купить квартиру", ["Hello, do you have apartments in Sino?"])).toBeNull();
    expect(foreignReplyLanguage("Thank you", ["Хочу купить квартиру", "Hello, do you have apartments?"])).toBe("en");
    expect(foreignReplyLanguage("спасибо", ["Hello, do you have apartments?", "Мехоҳам хона харам"])).toBeNull();
  });
});

describe("оператор: ответ на языке клиента", () => {
  it("русский — русская готовая фраза, переводчик не зовётся", async () => {
    const t = translator();
    const r = await turn("Хочу купить квартиру в Сино", { model: t.model });
    expect(r).toMatchObject({ language: "ru", foreign: null });
    expect(r.text).toBe("Напишите, пожалуйста, сколько комнат и бюджет, и расскажем подробнее.");
    expect(t.asked).toEqual([]);
  });

  it("таджикский кириллицей и латиницей — таджикская фраза кириллицей, переводчик не зовётся", async () => {
    const t = translator();
    for (const text of ["Мехоҳам хона харам дар Сино", "salom, men khona kharidan mekhoham, chand pul?"]) {
      const r = await turn(text, { model: t.model });
      expect(r, text).toMatchObject({ language: "tg", foreign: null });
      expect(r.text, text).toMatch(/[ҳҷӣӯқғ]/u);
    }
    expect(t.asked).toEqual([]);
  });

  it("смесь русского и таджикского — язык, которого больше; не «другой язык»", async () => {
    const t = translator();
    expect(await turn("Салом, цена квартиры?", { model: t.model })).toMatchObject({ language: "ru", foreign: null });
    expect(await turn("Ман квартира мехоҳам дар Сино, нархаш чанд?", { model: t.model })).toMatchObject({ language: "tg", foreign: null });
    expect(t.asked).toEqual([]);
  });

  it("английский — перевод русской фразы на английский", async () => {
    const t = translator();
    const r = await turn("Hello, I want to buy an apartment, how much is it?", { model: t.model });
    expect(r).toMatchObject({ foreign: "en", translated: true, text: "Would you like to buy or sell a property?" });
    expect(r.parts).toEqual(["Would you like to buy or sell a property?"]);
    expect(t.asked).toEqual(["English"]);
    expect(r.stored).toMatchObject({ foreign: "en" });
  });

  it("узбекский (латиница) — перевод на узбекский", async () => {
    const t = translator();
    const r = await turn("Assalomu alaykum, uy sotib olmoqchiman, qancha turadi?", { model: t.model });
    expect(r).toMatchObject({ foreign: "uz", translated: true, text: TRANSLATIONS.Uzbek![ASK_ROLE_RU] });
    expect(t.asked[0]).toMatch(/^Uzbek/u);
  });

  it("модель перевода лежит — русская фраза (страховка), язык в памяти остаётся", async () => {
    const r = await turn("Hello, I want to buy an apartment, how much is it?", { model: down });
    expect(r).toMatchObject({ foreign: "en", translated: false, language: "ru", text: ASK_ROLE_RU });
    expect(r.stored).toMatchObject({ foreign: "en" });
  });

  it("смена языка посреди разговора: английский → русский → «ок» по-русски → узбекский", async () => {
    const t = translator();
    const first = await turn("Hello, do you have apartments for sale in Sino?", { model: t.model });
    expect(first).toMatchObject({ foreign: "en", translated: true });
    const recent1 = [{ role: "user" as const, text: "Hello, do you have apartments for sale in Sino?" }, { role: "assistant" as const, text: first.text! }];
    const second = await turn("Хочу купить квартиру в Сино", { stored: JSON.parse(JSON.stringify(first.stored)), recent: recent1, model: t.model });
    expect(second).toMatchObject({ foreign: null, language: "ru" });
    expect(second.text).not.toBe(first.text);
    expect(second.stored).toMatchObject({ foreign: null });
    const recent2 = [...recent1, { role: "user" as const, text: "Хочу купить квартиру в Сино" }, { role: "assistant" as const, text: second.text! }];
    const third = await turn("ок", { stored: JSON.parse(JSON.stringify(second.stored)), recent: recent2, model: t.model });
    expect(third.foreign).toBeNull();
    expect(t.asked).toEqual(["English"]);
    const fourth = await turn("Assalomu alaykum, uy sotib olmoqchiman, qancha turadi?", { stored: { ...JSON.parse(JSON.stringify(third.stored)), role: "unknown" },
      model: t.model });
    expect(fourth.foreign).toBe("uz");
  });

  it("«Thank you» посреди английского разговора язык не сбрасывает; переводчик зовётся", async () => {
    const t = translator();
    const first = await turn("Hello, I want to buy an apartment, how much is it?", { model: t.model });
    const next = await turn("Thank you", { stored: JSON.parse(JSON.stringify(first.stored)),
      recent: [{ role: "user", text: "Hello, I want to buy an apartment, how much is it?" }, { role: "assistant", text: first.text! }], model: t.model });
    expect(next.foreign).toBe("en");
    expect(next.stored).toMatchObject({ foreign: "en" });
  });

  it("память до правки (без поля foreign) читается и работает как раньше", async () => {
    const first = await turn("Хочу купить квартиру");
    const { foreign: _drop, ...old } = JSON.parse(JSON.stringify(first.stored)) as Record<string, unknown>;
    const next = await turn("Мехоҳам хона харам дар Сино", { stored: old });
    expect(next).toMatchObject({ foreign: null });
  });
});

describe("проверка перевода кодом: ничего сверх русской фразы", () => {
  const client = "Hello, I want to buy an apartment";
  it.each([
    ["Would you like to buy or sell a property?", null],
    ["Would you like to buy or sell a property? Our agent will call you today.", "time"],
    ["Would you like to buy or sell a property? Our agent will call you.", "promise"],
    ["Is it to buy? Or to sell?", "question"],
    ["Would you like to buy or sell 2 properties?", "digits"],
    ["Would you like to buy or sell a property today?", "time"],
    ["Хотите купить или продать?", "script"],
    ["Would you like to buy or sell — a property?", "banned"],
    ["Buy or sell property", "question_dropped"],
  ] as const)("«%s» → %s", (reply, expected) => {
    expect(checkTranslatedReply(reply, ASK_ROLE_RU, "en", client)).toBe(expected);
  });

  it("цена, проценты и номер — без изменений; новая цена или обещание звонка — отказ", () => {
    const template = "Для покупателя услуги бесплатны, продавцу комиссия 2%.";
    expect(checkTranslatedReply("Our services are free for buyers; sellers pay a 2% commission.", template, "en", client)).toBeNull();
    expect(checkTranslatedReply("Our services are free for buyers; sellers pay a 3% commission.", template, "en", client)).toBe("digits");
    expect(checkTranslatedReply("Thanks, I passed it on.", "Спасибо, передал.", "en", client)).toBeNull();
    expect(checkTranslatedReply("Thanks, the agent will call you.", "Спасибо, передал.", "en", client)).toBe("promise");
    expect(checkTranslatedReply("Thanks, it is free.", "Спасибо, передал.", "en", client)).toBe("money");
  });

  it("узбекский: обращение на «sen» — отказ; ответ кириллицей клиенту, писавшему латиницей, — отказ", () => {
    const uz = "Assalomu alaykum, uy sotib olmoqchiman";
    expect(checkTranslatedReply("Sen uy sotib olmoqchimisan yoki sotmoqchimisan?", ASK_ROLE_RU, "uz", uz)).toBe("informal");
    expect(checkTranslatedReply("Сиз уй сотиб олмоқчимисиз ёки сотмоқчимисиз?", ASK_ROLE_RU, "uz", uz)).toBe("script");
  });

  it("рубильник BOT_FOREIGN_REPLY=off — модель не зовётся, уходит русская фраза", async () => {
    const model = vi.fn(async () => ({ reply: "Would you like to buy or sell a property?" }));
    const result = await translateClientReply({ template: ASK_ROLE_RU, language: "en", clientText: client, model, env: { BOT_FOREIGN_REPLY: "off" } });
    expect(result).toEqual({ text: ASK_ROLE_RU, source: "template", rejected: "off" });
    expect(model).not.toHaveBeenCalled();
  });
});
