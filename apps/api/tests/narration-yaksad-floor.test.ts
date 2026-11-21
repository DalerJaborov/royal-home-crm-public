import { describe, expect, it } from "vitest";
import {
  narrationDraftText, narrationTemplateError, narrationTotalFloorsError, numberToWords, renderNarrationTemplate, spokenNumbersToDigits,
  suggestedNarration, tajikCardinal, tajikSpeechNumbers, withoutTotalFloors, type NarrationFacts,
} from "@royal-home/shared";

// 21.11.2026, ролик №219 (владелец): «саду ҳашт» → «яксаду ҳашт»; этаж без этажности дома.
const facts: NarrationFacts = { type: "APARTMENT", rooms: 3, areaSqm: "108", floor: 13, totalFloors: 15, district: "Сино", price: "1669000", currency: "TJS" };

describe("сотня по-таджикски — «яксад», везде одинаково", () => {
  const cases: Array<[number, string]> = [
    [100, "яксад"], [108, "яксаду ҳашт"], [115, "яксаду понздаҳ"], [199, "яксаду наваду нӯҳ"], [200, "дусад"],
    [1_108_000, "як миллиону яксаду ҳашт ҳазор"], [1_150_000, "як миллиону яксаду панҷоҳ ҳазор"],
    [1_669_000, "як миллиону шашсаду шасту нӯҳ ҳазор"], [2_100_000, "ду миллиону яксад ҳазор"],
  ];
  it("tajikCardinal: примеры владельца", () => {
    for (const [n, words] of cases) expect(tajikCardinal(n), String(n)).toBe(words);
  });
  it("обе реализации (шаблоны и голос робота) не говорят одинокое «сад» ни на каком числе до двух миллионов", () => {
    const standalone = /(^|[\s])сад(у|\s|$)/u;
    for (let n = 0; n <= 2_000_000; n += n < 2000 ? 1 : 997) {
      expect(standalone.test(tajikCardinal(n)), `cardinal ${n}`).toBe(false);
      expect(standalone.test(numberToWords(n, "tg")), `words ${n}`).toBe(false);
    }
    for (let k = 1; k <= 9; k++) expect(tajikCardinal(k * 100), `сотни ${k}`).toBe(numberToWords(k * 100, "tg"));
    expect(numberToWords(108, "tg")).toBe("яксад ҳашт");
  });
  it("в тексте озвучки: площадь и цена цифрами тоже говорятся «яксаду»", () => {
    expect(tajikSpeechNumbers("Масоҳат 108 м², нарх 1 150 000")).toBe("Масоҳат яксаду ҳашт метри мураббаъ, нарх як миллиону яксаду панҷоҳ ҳазор");
    expect(renderNarrationTemplate({ lang: "tg", text: "Масоҳаташ {площадь} метр. Нархаш {цена}." }, facts)).toBe("Масоҳаташ яксаду ҳашт метр. Нархаш як миллиону шашсаду шасту нӯҳ ҳазор сомонӣ.");
  });
  it("разбор слов в цифры понимает и «яксад», и прежнее «сад» от клиента", () => {
    expect(spokenNumbersToDigits("яксад ҳашт")).toContain("108");
    expect(spokenNumbersToDigits("сад ҳашт")).toContain("108");
  });
});

describe("этаж без этажности дома", () => {
  const apartment = (text: string, lang: "tg" | "ru" = "tg", over: Partial<NarrationFacts> = {}) => renderNarrationTemplate({ lang, text }, { ...facts, ...over });
  it("tg: шаблон библиотеки «ошёнаи {этаж_пор}и бинои {этажей} ошёна» даёт одну грамотную фразу про этаж", () => {
    expect(apartment("[Хона дар ошёнаи {этаж_пор}и бинои {этажей} ошёна ҷойгир шудааст.]")).toBe("Хона дар ошёнаи сенздаҳум ҷойгир шудааст.");
    expect(apartment("[Дар ошёнаи {этаж_пор}и бинои {этажей} ошёна ҷойгир аст.]")).toBe("Дар ошёнаи сенздаҳум ҷойгир аст.");
    expect(apartment("[Ҷой дар ошёнаи {этаж_пор}и бинои {этажей} ошёна ҷойгир мебошад.]")).toBe("Ҷой дар ошёнаи сенздаҳум ҷойгир мебошад.");
  });
  it("tg: «аз {этажей}» и «{этаж}ум бинои {этажей}-ошёна» тоже снимаются", () => {
    expect(apartment("Ошёнаи {этаж_пор} аз {этажей}.")).toBe("Ошёнаи сенздаҳум.");
    expect(apartment("Ошёнаи {этаж_пор} аз {этажей} ошёна.")).toBe("Ошёнаи сенздаҳум.");
    expect(apartment("Дар ошёнаи {этаж}уми бинои {этажей}-ошёна.")).not.toMatch(/бино|ошёнаи сенздаҳ(?!ум)/u);
  });
  it("ru: «из {этажей}» и «в {этажей}-этажном доме» снимаются, этаж остаётся", () => {
    expect(apartment("{этаж_пор} этаж из {этажей}.", "ru")).toBe("Тринадцатый этаж.");
    expect(apartment("Квартира, {этаж_пор} этаж в {этажей}-этажном доме. Звоните!", "ru")).toBe("Квартира, тринадцатый этаж. Звоните!");
  });
  it("ни в одном тексте не остаётся ни этажности, ни цифр, ни скобок; нет этажа — фраза про этаж выпадает", () => {
    const text = apartment("[Хона дар ошёнаи {этаж_пор}и бинои {этажей} ошёна ҷойгир шудааст.] Нархаш {цена}.");
    expect(text).not.toMatch(/чордаҳ|понздаҳ|пан[зҷ]даҳ|\d|[{}[\]]/u);
    expect(apartment("[Хона дар ошёнаи {этаж_пор}и бинои {этажей} ошёна ҷойгир шудааст.] Нархаш {цена}.", "tg", { floor: null })).toBe("Нархаш як миллиону шашсаду шасту нӯҳ ҳазор сомонӣ.");
  });
  it("фраза только про этажность дома (дом: «Хона {этажей} ошёна дорад») выпадает целиком, а не читается обрубком", () => {
    expect(apartment("Хона барои фурӯш. Хона {этажей} ошёна дорад. Нависед!", "tg", { type: "HOUSE", floor: null, totalFloors: 2 })).toBe("Хона барои фурӯш. Нависед!");
    expect(apartment("[Бинои асосӣ {этажей} ошёна дорад.] Нависед!", "tg", { type: "HOUSE", floor: null, totalFloors: 2 })).toBe("Нависед!");
    expect(apartment("Дом {этажей}-этажный. Цена {цена}.", "ru")).toBe("Цена один миллион шестьсот шестьдесят девять тысяч сомони.");
  });
  it("полный текст ролика №219 из шаблона библиотеки: без «чордаҳ ошёна» и «аз», с «яксаду ҳашт»", () => {
    const text = narrationDraftText({
      templates: [{ id: "t", name: "t", lang: "tg", text: "[Масоҳати умумии хона {площадь} метри мураббаъ аст.] [Хона дар ошёнаи {этаж_пор}и бинои {этажей} ошёна ҷойгир аст.] Нархи хона {цена}." }],
      endings: [], defaultTemplateId: "t",
    }, { ...facts, totalFloors: 14, price: "1669000" }).text;
    expect(text).toBe("Масоҳати умумии хона яксаду ҳашт метри мураббаъ аст. Хона дар ошёнаи сенздаҳум ҷойгир аст. Нархи хона як миллиону шашсаду шасту нӯҳ ҳазор сомонӣ.");
  });
  it("запасной текст по фактам и withoutTotalFloors без {этажей} не трогают текст", () => {
    expect(suggestedNarration(facts)).toContain("Этаж 13.");
    expect(suggestedNarration(facts)).not.toMatch(/из 15/u);
    expect(withoutTotalFloors("Хона {район} аст.")).toBe("Хона {район} аст.");
  });
});

describe("сторож шаблона: {этажей} в новом тексте не принимается", () => {
  it("понятная ошибка; обычный этаж принимается; старый текст (проверка правил) читается как раньше", () => {
    expect(narrationTotalFloorsError("Ошёнаи {этаж_пор}и бинои {этажей} ошёна.")).toMatch(/Этажность дома в озвучке не называем/u);
    expect(narrationTotalFloorsError("Ошёнаи {этаж_пор}.")).toBeNull();
    // Структурные правила прежние: {этажей} — известное слово, старые шаблоны из Настроек читаются.
    expect(narrationTemplateError("Ошёнаи {этаж_пор}и бинои {этажей} ошёна.", "tg")).toBeNull();
  });
});
