import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
// Чистые правила текста: до базы не доходим (setup.ts сбрасывает настройки только у настоящей базы).
vi.mock("../src/db.js", async (importOriginal) => ({ ...await importOriginal<typeof import("../src/db.js")>(), prisma: { $disconnect: async () => {} } }));
import {
  narrationConfigSchema, narrationDraftText, narrationSpeechText, narrationTemplateError, narrationTemplateSchema,
  narrationModelError, narrationPriceWords, narrationPriceProblem, narrationSpokenPriceTjs, narrationCurrencyError, apartmentPriceCurrencySuspect, convertToTjs, pickNarrationTemplate, pickNarrationVoice, renderNarrationTemplate, tajikCardinal, tajikOrdinal, type NarrationFacts,
} from "@royal-home/shared";
import { generateNarrationAudio, NARRATION_QUOTA_EXCEEDED, narrationScriptError } from "../src/lib/propertyNarration.js";
import { tajikSpeechNumbers } from "../src/telegram/tajikSpeechNumbers.js";

const apartment: NarrationFacts = { type: "APARTMENT", rooms: 3, areaSqm: "86.4", floor: 5, totalFloors: 9, district: "Сино", price: "85000", currency: "USD" };
const house: NarrationFacts = { type: "HOUSE", rooms: null, areaSqm: "240", floor: null, totalFloors: null, district: null };
const tg = { lang: "tg" as const, text: "Ассалому алейкум! {вид} барои фурӯш[, ноҳияи {район}]. [{комнаты} ҳуҷра.] Масоҳаташ {площадь} метри мураббаъ. [Ошёнаи {этаж_пор}[ аз {этажей}].] Нарх дар тавсиф." };

// Стартовые шаблоны лежат в миграции (текст владельца живёт в настройках, не в коде).
const migration = readFileSync(new URL("../prisma/migrations/20261111120000_narration_flow/migration.sql", import.meta.url), "utf8");
const firstSeed = narrationTemplateSchema.array().parse(JSON.parse(migration.split("$json$")[1]));
// Решение владельца 11.11.2026 «Да, говорить цену»: все стартовые шаблоны (3 таджикских, 3 русских) говорят цену.
const seeded = firstSeed;

describe("narration text rules (one builder for CRM wizard, Shabnam and server)", () => {
  it("spells Tajik numbers as words and drops optional fragments with missing facts", () => {
    expect(renderNarrationTemplate(tg, apartment)).toBe("Ассалому алейкум! Квартира барои фурӯш, ноҳияи Сино. Се ҳуҷра. Масоҳаташ ҳаштоду шаш метри мураббаъ. Ошёнаи панҷум аз нӯҳ. Нарх дар тавсиф.");
    const forHouse = renderNarrationTemplate(tg, house);
    expect(forHouse).toBe("Ассалому алейкум! Ҳавлӣ барои фурӯш. Масоҳаташ дусаду чил метри мураббаъ. Нарх дар тавсиф.");
    expect(renderNarrationTemplate(tg, { ...apartment, totalFloors: null })).toContain("Ошёнаи панҷум.");
    expect(/\d/u.test(renderNarrationTemplate(tg, apartment))).toBe(false);
  });
  it("Russian is spoken in words too (owner 17.11.2026) and capitalises sentence starts", () => {
    expect(renderNarrationTemplate({ lang: "ru", text: "в продаже {вид}. [комнат: {комнаты}.] площадь {площадь} метров." }, apartment)).toBe("В продаже квартира. Комнат: три. Площадь восемьдесят шесть метров.");
  });
  it("ordinals and the moved speech-number module agree", () => {
    expect([1, 2, 3, 4, 10, 30, 31].map(tajikOrdinal)).toEqual(["якум", "дуюм", "сеюм", "чорум", "даҳум", "сиюм", "сиву якум"]);
    expect(tajikCardinal(86)).toBe("ҳаштоду шаш");
    expect(tajikSpeechNumbers("3 ҳуҷра")).toBe("се ҳуҷра");
    expect(narrationSpeechText("3 ҳуҷра, 86 м²", "tg")).toBe("се ҳуҷра, ҳаштоду шаш метри мураббаъ");
    expect(narrationSpeechText("3 комнаты", "ru")).toBe("три комнаты");
  });
  it("rejects unknown placeholders, unbalanced brackets and long dashes in owner templates", () => {
    expect(narrationTemplateError("{стоимость} сомонӣ")).toMatch(/Неизвестное/);
    expect(narrationTemplateError("[{район}")).toMatch(/Не закрыта/);
    expect(narrationTemplateError("{район}]")).toMatch(/Лишняя/);
    expect(narrationTemplateError("Квартира — хорошая")).toMatch(/тире/);
    expect(narrationTemplateError(tg.text)).toBeNull();
  });
  it("seeded starter templates are valid, speak the price and speak Tajik without digits", () => {
    expect(seeded.map((t) => t.id)).toEqual(["tg-short", "tg-family", "tg-offer", "ru-short", "ru-family", "ru-offer"]);
    for (const template of seeded) expect(template.text).toContain("{цена}");
    for (const template of seeded) {
      expect(narrationTemplateError(template.text)).toBeNull();
      for (const facts of [apartment, house]) {
        const text = renderNarrationTemplate(template, facts);
        expect(narrationScriptError(text)).toBeNull();
        if (template.lang === "tg") expect(/\d/u.test(text)).toBe(false);
      }
    }
  });
  it("picks the requested, then default, then first Tajik template; falls back to the legacy text without templates", () => {
    const config = { templates: seeded, defaultTemplateId: "tg-family" };
    expect(pickNarrationTemplate(config, "ru-short")?.id).toBe("ru-short");
    expect(pickNarrationTemplate(config, "missing")?.id).toBe("tg-family");
    expect(pickNarrationTemplate({ templates: seeded }, null)?.id).toBe("tg-short");
    expect(narrationDraftText({}, apartment)).toMatchObject({ templateId: null, lang: "ru" });
    expect(narrationDraftText(config, apartment, "ru-short").lang).toBe("ru");
  });
  it("voice falls back to the owner's default, then the first voice", () => {
    const voices = [{ id: "a", name: "A" }, { id: "b", name: "B", gender: "female" as const }];
    expect(pickNarrationVoice({ voices, defaultVoiceId: "b" }, "zzz")).toBe("b");
    expect(pickNarrationVoice({ voices }, undefined)).toBe("a");
    expect(pickNarrationVoice({ voices: [] }, "a")).toBeNull();
  });
  it("old saved configs stay valid and duplicate template ids are refused", () => {
    expect(narrationConfigSchema.safeParse({ modelId: "m", voices: [{ id: "v", name: "V" }] }).success).toBe(true);
    expect(narrationConfigSchema.safeParse({ modelId: "m", voices: [], templates: [seeded[0], seeded[0]] }).success).toBe(false);
  });
  it("Tajik templates need a Tajik-capable model (v4 or v4 Turbo)", () => {
    expect(narrationModelError({ modelId: "eleven_v4", templates: seeded })).toBeNull();
    expect(narrationModelError({ modelId: "eleven_v4_turbo", templates: seeded })).toBeNull();
    expect(narrationModelError({ modelId: "eleven_multilingual_v2", templates: seeded })).toMatch(/таджикского/u);
    expect(narrationModelError({ modelId: "eleven_flash_v2_5", templates: seeded.filter((t) => t.lang === "ru") })).toBeNull();
  });
  it("speaks the price only in somoni: USD is converted by the shared rule, never spoken as dollars (owner 21.11.2026)", () => {
    // 85 000 $ × 9.27 = 787 950 сомони → округление до тысячи.
    expect(narrationPriceWords({ ...apartment, usdToTjs: 9.27 }, "tg")).toBe("ҳафтсаду ҳаштоду ҳашт ҳазор сомонӣ");
    expect(narrationPriceWords({ ...apartment, usdToTjs: 9.27 }, "ru")).toBe("семьсот восемьдесят восемь тысяч сомони");
    expect(narrationSpokenPriceTjs("85000", "USD", 9.27)).toBe(Math.round(convertToTjs(85000, "USD", 9.27) / 1000) * 1000);
    expect(narrationPriceWords({ ...apartment, price: "390000.00", currency: "TJS" }, "tg")).toBe("сесаду навад ҳазор сомонӣ");
    expect(narrationPriceWords({ ...apartment, price: "390000", currency: "TJS" }, "ru")).toBe("триста девяносто тысяч сомони");
    expect(narrationPriceWords({ ...apartment, price: null }, "tg")).toBe("бо мувофиқа");
    expect(narrationPriceWords({ ...apartment, price: "0", currency: "TJS" }, "ru")).toBe("договорная");
    expect(renderNarrationTemplate({ lang: "tg", text: "Нархаш {цена}." }, { ...apartment, usdToTjs: 9.27 })).toBe("Нархаш ҳафтсаду ҳаштоду ҳашт ҳазор сомонӣ.");
    for (const template of seeded) {
      const text = renderNarrationTemplate(template, { ...apartment, usdToTjs: 9.27 });
      expect(text).not.toMatch(/доллар/iu);
      expect(narrationScriptError(text)).toBeNull();
    }
  });
  it("without a rate the dollar price is not spoken at all: the sentence with {цена} drops, no guessed rate", () => {
    expect(narrationPriceWords(apartment, "ru")).toBe("");
    expect(narrationPriceProblem(apartment)).toBe("NO_RATE");
    expect(renderNarrationTemplate({ lang: "tg", text: "Квартира дар {район}. Нархаш {цена}. Занг занед!" }, apartment)).toBe("Квартира дар Сино. Занг занед!");
    expect(renderNarrationTemplate({ lang: "ru", text: "Квартира. [Цена {цена}.] Звоните!" }, apartment)).toBe("Квартира. Звоните!");
  });
  it("an apartment price that looks like the wrong currency is not spoken (object 213: 107 400 «сомони» for 89.5 m²)", () => {
    const mixedUp: NarrationFacts = { type: "APARTMENT", rooms: 2, areaSqm: "89.5", floor: 20, totalFloors: 24, district: "Исмоили Сомони", price: "107400", currency: "TJS" };
    expect(apartmentPriceCurrencySuspect({ type: "APARTMENT", price: "107400", currency: "TJS", areaSqm: "89.5" })).toBe("LOOKS_USD");
    expect(narrationPriceProblem(mixedUp)).toBe("CURRENCY_SUSPECT");
    expect(renderNarrationTemplate({ lang: "tg", text: "Нархи хона {цена}. Нависед!" }, mixedUp)).toBe("Нависед!");
    // Шаблоны прода: «[…предложение.] Нархи хона {цена}.» — выпадает только цена, остальное на месте.
    expect(renderNarrationTemplate({ lang: "tg", text: "Хонаи худро меҷӯед? [Хона {комнаты} ҳуҷра дорад.] [Хона дар ошёнаи {этаж_пор}и бинои {этажей} ошёна ҷойгир аст.] Нархи хона {цена}. Нависед!" }, mixedUp))
      .toBe("Хонаи худро меҷӯед? Хона ду ҳуҷра дорад. Хона дар ошёнаи бистуми бинои бисту чор ошёна ҷойгир аст. Нависед!");
    // Настоящие цены продолжают звучать: 788 000 сомони за 77,5 м², 127 200 $ за 106 м².
    expect(apartmentPriceCurrencySuspect({ type: "APARTMENT", price: "788000", currency: "TJS", areaSqm: "77.5" })).toBeNull();
    expect(apartmentPriceCurrencySuspect({ type: "APARTMENT", price: "127200", currency: "USD", areaSqm: "106" })).toBeNull();
    expect(apartmentPriceCurrencySuspect({ type: "APARTMENT", price: "788000", currency: "USD", areaSqm: "77.5" })).toBe("LOOKS_TJS");
    expect(apartmentPriceCurrencySuspect({ type: "HOUSE", price: "107400", currency: "TJS", areaSqm: "240" })).toBeNull();
  });
  it("the dollar guard stops dollars before ElevenLabs: hand-written text and owner templates", () => {
    for (const text of ["Нархаш саду бисту ҳафт ҳазор доллар.", "Цена 85 000 $", "Цена 85000 USD", "Цена сто тысяч долларов"]) {
      expect(narrationScriptError(text)).toMatch(/только в сомони/u);
      expect(narrationCurrencyError(text)).not.toBeNull();
    }
    expect(narrationTemplateError("Нархаш {цена} доллар.", "tg")).toMatch(/только в сомони/u);
    expect(narrationScriptError("Нархаш ҳафтсад ҳазор сомонӣ. Ба Исмоили Сомони наздик.")).toBeNull();
  });
  it("ElevenLabs «credits are over» gets its own code (no retry, no charge)", async () => {
    const config = { modelId: "eleven_v4", voices: [{ id: "voice", name: "V" }] };
    const quota = vi.fn().mockResolvedValue(new Response(JSON.stringify({ detail: { status: "quota_exceeded", message: "This request exceeds your quota" } }), { status: 401, headers: { "content-type": "application/json" } }));
    expect(await generateNarrationAudio({ script: "Квартира барои фурӯш.", voiceId: "voice", config, apiKey: "test-key" }, quota)).toEqual({ status: "FAILED", errorCode: NARRATION_QUOTA_EXCEEDED });
    expect(quota).toHaveBeenCalledTimes(1);
    const other = vi.fn().mockResolvedValue(new Response(JSON.stringify({ detail: { status: "invalid_api_key" } }), { status: 401 }));
    expect(await generateNarrationAudio({ script: "Квартира барои фурӯш.", voiceId: "voice", config, apiKey: "test-key" }, other)).toEqual({ status: "FAILED", errorCode: "PROVIDER_HTTP_401" });
  });
});

/** 17.11.2026, правки к #252 (оба языка): телефон по группам, «N из M» и этаж в нужном падеже, дроби до целого. */
describe("цифры в речи: телефоны, этажи, дроби", () => {
  it("слитный номер — по группам, как диктуют, а не «девятьсот миллионов»", () => {
    expect(narrationSpeechText("Звоните 900123456.", "ru")).toBe("Звоните девяносто, ноль двенадцать, тридцать четыре, пятьдесят шесть.");
    expect(narrationSpeechText("Занг занед 900123456.", "tg")).toBe("Занг занед навад, сифр дувоздаҳ, сиву чор, панҷоҳу шаш.");
    expect(narrationSpeechText("Номер +992 90 123 45 67.", "ru")).toBe("Номер плюс девятьсот девяносто два, девяносто, сто двадцать три, сорок пять, шестьдесят семь.");
    expect(narrationSpeechText("Рақам 90-123-45-67.", "tg")).toBe("Рақам навад, саду бисту се, чилу панҷ, шасту ҳафт.");
    for (const [text, lang] of [["Звоните 900123456", "ru"], ["Занг занед 900123456", "tg"]] as const) expect(narrationSpeechText(text, lang)).not.toMatch(/миллион/u);
  });
  it("цена с пробелами тысяч и цена с валютой — по-прежнему числом", () => {
    expect(narrationSpeechText("Цена 1 200 000 сомони.", "ru")).toBe("Цена один миллион двести тысяч сомони.");
    expect(narrationSpeechText("Нархаш 1 200 000 сомонӣ.", "tg")).toBe("Нархаш як миллиону дусад ҳазор сомонӣ.");
    expect(narrationSpeechText("Цена 120000000 сомони.", "ru")).toBe("Цена сто двадцать миллионов сомони.");
    expect(narrationSpeechText("Нархаш 120000000 сомонӣ.", "tg")).toBe("Нархаш саду бист миллион сомонӣ.");
  });
  it("этаж и «из N» по-человечески", () => {
    expect(narrationSpeechText("14 этаж из 20.", "ru")).toBe("четырнадцатый этаж из двадцати.");
    expect(narrationSpeechText("Квартира на 14 этаже, вид с 21-го этажа.", "ru")).toBe("Квартира на четырнадцатом этаже, вид с двадцать первого этажа.");
    expect(narrationSpeechText("Ошёнаи 14 аз 20.", "tg")).toBe("Ошёнаи чордаҳум аз бист.");
  });
  it("дробная площадь и крупная сумма — до целого; мелкая дробная сумма и дата остаются (текстом, не голосом)", () => {
    expect(narrationSpeechText("Площадь 117,85 м².", "ru")).toBe("Площадь сто восемнадцать квадратных метров.");
    expect(narrationSpeechText("Масоҳат 117,85 м².", "tg")).toBe("Масоҳат саду ҳаждаҳ метри мураббаъ.");
    expect(narrationSpeechText("Цена 85000,50 долларов.", "ru")).toBe("Цена восемьдесят пять тысяч долларов.");
    expect(tajikSpeechNumbers("Нарх 99,5 сомонӣ.")).toBeNull();
    expect(narrationSpeechText("Показ 03.11.2026.", "ru")).toBe("Показ 03.11.2026.");
  });
});
