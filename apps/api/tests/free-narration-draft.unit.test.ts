import { describe, expect, it } from "vitest";
import { adFactsUsable, adScriptViolation, parseAdTextRequest, tidyAdScript } from "../src/ai/assistant/adScript.js";
import { looksLikeNarrationDictation, looksLikeOfferableText, narrationBodyAfterCue } from "../src/telegram/assistantFreeNarration.js";

/**
 * 23.11.2026: рекламный текст из фактов, расшифровка голоса как черновик, кнопка «Озвучить этот текст».
 * Чистые разборы без базы и без платных вызовов. Главное: сторож не пускает выдумку (числа, контакты,
 * валюту), а кнопка не появляется на каждое длинное сообщение.
 */
const FACTS = "RUDAKI TOWER, район Рудаки, рядом дворец Фарханг, свет, канализация, 3 лифта на блок, скидка 10–15%, парковка, детский двор, цена от 6500 смн за кв. м, от 59 кв. м, Сомониён";

describe("просьба «сделай рекламный текст»", () => {
  it("факты в самой просьбе: после двоеточия", () => {
    const r = parseAdTextRequest(`Шабнам, сделай рекламный текст и озвучь: ${FACTS}`);
    expect(r?.facts.startsWith("RUDAKI TOWER")).toBe(true);
  });
  it("без фактов, но с «озвучь»: спросим факты", () => {
    expect(parseAdTextRequest("сделай рекламный текст и озвучь")).toEqual({ facts: "" });
    expect(parseAdTextRequest("напиши рекламный текст для озвучки")).toEqual({ facts: "" });
  });
  it("факты с новой строки без слова про озвучку", () => {
    const r = parseAdTextRequest(`сделай рекламный текст\n${FACTS}`);
    expect(r && adFactsUsable(r.facts)).toBe(true);
  });
  it("таджикский", () => {
    expect(parseAdTextRequest("матни таблиғотӣ навис ва овоз кун")).toEqual({ facts: "" });
    expect(parseAdTextRequest("рекламаи матн навис ва овоз кун")?.facts).toBe("");
  });
  it("не наше: объект из CRM, голое «сделай рекламу», вопрос про рекламу", () => {
    expect(parseAdTextRequest("сделай рекламный текст для ОБ-123 и озвучь")).toBeNull();
    expect(parseAdTextRequest("сделай рекламу")).toBeNull();
    expect(parseAdTextRequest("сколько мы потратили на рекламный текст в октябре")).toBeNull();
    expect(parseAdTextRequest("найди клиента, ему нужен рекламный текст")).toBeNull();
  });
});

describe("живой пример владельца 23.11: «приготовить текст для озвучки» + факты", () => {
  const TJ = "RUDAKI TOWER, ноҳияи Рудаки, наздики қасри Фарҳанг, барқ, канализатсия, 3 лифт дар блок, тахфиф 10–15%, таваққуфгоҳ, ҳавлии кӯдакон, аз 6500 смн барои кв. м, аз 59 кв. м, Сомониён";
  it.each([
    "Надо приготовить текст для озвучки и озвучить вот это",
    "Подготовь текст для озвучки и озвучь",
    "Составь текст для озвучки, потом озвучь:",
    "Напиши текст для озвучки",
  ])("русская просьба «%s» + таджикские факты: путь «реклама из фактов»", (head) => {
    const r = parseAdTextRequest(`${head}

${TJ}`);
    expect(r && adFactsUsable(r.facts)).toBe(true);
    expect(r?.facts.startsWith("RUDAKI TOWER")).toBe(true);
  });
  it("таджикская просьба", () => {
    const r = parseAdTextRequest(`Матнро барои овозонӣ тайёр кунед ва овоз кунед:
${TJ}`);
    expect(r?.facts.startsWith("RUDAKI TOWER")).toBe(true);
  });
  it("«озвучь вот это» + длинный текст: не реклама, а дословно без просьбы", () => {
    const text = `Озвучь вот это:

${TJ}`;
    expect(parseAdTextRequest(text)).toBeNull();
    expect(looksLikeNarrationDictation(text)).toBe(true);
    expect(narrationBodyAfterCue(text).startsWith("RUDAKI TOWER")).toBe(true);
    expect(narrationBodyAfterCue("озвучь это текст добро пожаловать")).toBe("добро пожаловать");
  });
});

describe("сторож рекламного текста: только факты сотрудника", () => {
  const ok = "Жилой комплекс Рудаки Тауэр в районе Рудаки, рядом дворец Фарханг. Свет, канализация, три лифта на блок, парковка и детский двор. Скидка от 10 до 15 процентов, цена от 6500 сомони за квадратный метр, квартиры от 59 метров. Звоните, расскажем подробнее.";
  it("честный текст проходит", () => { expect(adScriptViolation(ok, FACTS, 1500)).toBeNull(); });
  it("выдуманное число", () => {
    expect(adScriptViolation(ok.replace("6500", "5900"), FACTS, 1500)).toMatch(/чисел|числа/);
    expect(adScriptViolation(`${ok} Рассрочка на 24 месяца.`, FACTS, 1500)).toMatch(/24/);
  });
  it("выдуманный контакт или ссылка", () => {
    expect(adScriptViolation(`${ok} Телефон 900123456.`, FACTS, 1500)).toMatch(/чисел|числа/);
    expect(adScriptViolation(`${ok} Наш сайт rudaki.tj`, FACTS, 1500)).toMatch(/ссылк/);
    expect(adScriptViolation(`${ok} Пишите @rudaki_tower`, FACTS, 1500)).toMatch(/ссылк/);
  });
  it("контакт из фактов можно", () => {
    const facts = `${FACTS}, тел 900123456`;
    expect(adScriptViolation(`${ok} Телефон 900123456.`, facts, 1500)).toBeNull();
  });
  it("правила владельца: тире, «брон», Direct, валюта кроме сомони, длина", () => {
    expect(adScriptViolation(ok.replace("Звоните", "Звоните — мы ждём"), FACTS, 1500)).toMatch(/тире/);
    expect(adScriptViolation(`${ok} Бронь квартиры открыта.`, FACTS, 1500)).toMatch(/брон/);
    expect(adScriptViolation(`${ok} Пишите в Direct.`, FACTS, 1500)).toMatch(/Директ/);
    expect(adScriptViolation(ok.replace("сомони", "долларов"), FACTS, 1500)).toMatch(/сомони/);
    expect(adScriptViolation(ok, FACTS, 100)).toMatch(/длиннее/);
    expect(adScriptViolation("Коротко.", FACTS, 1500)).toMatch(/коротк/);
  });
  it("тире и «смн» чистятся без модели", () => {
    const tidy = tidyAdScript("Цена от 6500 смн — за кв. м,  рядом парк", "ru");
    expect(tidy).not.toMatch(/—/);
    expect(tidy).toContain("сомони");
    expect(tidy).toContain("квадратный метр");
    expect(tidyAdScript("нарх 100 смн", "tg")).toContain("сомонӣ");
  });
});

describe("кнопка «Озвучить этот текст»: только на готовый длинный текст", () => {
  const long = Array.from({ length: 34 }, (_, i) => `слово${i}`).join(" ");
  it("длинный набранный текст без вопроса", () => { expect(looksLikeOfferableText(long)).toBe(true); });
  it("короткое, вопрос, команда помощнице, команда /", () => {
    expect(looksLikeOfferableText("слово ".repeat(29))).toBe(false);
    expect(looksLikeOfferableText(`${long}?`)).toBe(false);
    expect(looksLikeOfferableText(`найди ${long}`)).toBe(false);
    expect(looksLikeOfferableText(`Шабнам, покажи ${long}`)).toBe(false);
    expect(looksLikeOfferableText(`внеси расходы ${long}`)).toBe(false);
    expect(looksLikeOfferableText(`/new ${long}`)).toBe(false);
    expect(looksLikeOfferableText(`почему ${long}`)).toBe(false);
  });
});

describe("тело диктовки голосом", () => {
  it("снимает слово-просьбу в начале", () => {
    expect(narrationBodyAfterCue("озвучь, добро пожаловать в наш комплекс")).toBe("добро пожаловать в наш комплекс");
    expect(narrationBodyAfterCue("Озвучь это: привет всем")).toBe("привет всем");
  });
  it("без просьбы в начале текст как есть", () => {
    expect(narrationBodyAfterCue("добро пожаловать")).toBe("добро пожаловать");
  });
});
