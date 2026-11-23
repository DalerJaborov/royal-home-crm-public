import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { PROPERTY_OBJECT_STEM } from "../src/ai/propertyObjectWord.js";
import { propertyNumberSelectors, captionPropertyNumber } from "../src/lib/customerPropertyReferenceText.js";
import { extractMentionedPropertyNumber } from "../src/ai/propertyMentionGuard.js";
import { classifyCustomerPropertyFactIntent } from "../src/lib/customerPropertyFactIntent.js";

/**
 * СТОРОЖ ОДНОГО СЛОВА «ОБЪЕКТ» (разбор суток бота 23.11.2026, комментарии K14–K18: «обьект 117» пять раз подряд
 * получал «Какой объект вы имеете в виду?»). Варианты написания живут в одном месте — ai/propertyObjectWord.ts.
 *
 * Сторож краснит, если в коде сервера (не в комментарии):
 *  1. появился свой список опечаток («обьект», «обект», «обэкт») мимо общего модуля;
 *  2. правило читает число сразу после слова «объект» («объект…\d»), а файл не берёт основу из общего модуля.
 * Исключения — только списком ниже, с причиной. Проверено поломкой: вернуть в propertyMentionGuard.ts
 * `(?:объект|обьект|обект)` — краснеет пункт 1; вернуть `объект[а-яё]*` в customerPropertyReferenceText.ts — пункт 2.
 */
const SRC = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../src");
const DOOR = "ai/propertyObjectWord.ts";
/** Файл → почему число после «объект» здесь читается своим правилом. Пусто — так и держать. */
const ALLOWED_OWN_NUMBER_RULE: Record<string, string> = {
  "telegram/montajerFileNumber.ts": "сотрудник: имя файла монтажёра «объект 213.mp4», не слова клиента",
  "telegram/staffClip.ts": "сотрудник отвечает номером ролика в своём боте, не слова клиента",
  "telegram/assistantGroupParticipation.ts": "рабочая группа сотрудников, код «об-12 / объект 12», не слова клиента",
  "telegram/assistantChatCommands.ts": "помощница сотрудников: тема «объект» и код «об 12» рядом, номер после «объект» не читается",
  "telegram/assistantConfirmationPhotos.ts": "разбор своего же заголовка «Цена объекта ОБ-12», не слова клиента",
};
/** Файл → почему здесь свой список написаний (не правило чтения слов клиента). */
const ALLOWED_OWN_VARIANTS: Record<string, string> = {
  "lib/staffPropertySearch.ts": "стоп-слова поиска по ориентиру (точные слова, не регулярка): «обьект» не ориентир",
};

function files(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) return e.name === "generated" || e.name === "node_modules" ? [] : files(p);
    return /\.ts$/.test(p) ? [p] : [];
  });
}
const rel = (p: string) => path.relative(SRC, p).split(path.sep).join("/");
/** Строки кода без комментариев (строка, начинающаяся с `*`, `//`, `/*`, и хвост `// …`). */
function codeLines(source: string): string[] {
  return source.split(/\r?\n/u).filter((line) => !/^\s*(?:\*|\/\/|\/\*)/u.test(line)).map((line) => line.replace(/\s\/\/\s.*$/u, ""));
}
export function ownVariantList(source: string): boolean {
  return codeLines(source).some((line) => /обьект|обект|обэкт/iu.test(line));
}
export function ownNumberRule(source: string): boolean {
  return codeLines(source).some((line) => /объект[^\n]{0,60}?(?:\\\\d|\\d|\[0-9\]|\[1-9\])/u.test(line)) &&
    !/from\s+["'][./]*(?:ai\/)?propertyObjectWord\.js["']/u.test(source);
}

describe("сторож: слово «объект» — одна дверь", () => {
  it("свой список опечаток «обьект / обект» — только в ai/propertyObjectWord.ts", () => {
    const offenders = files(SRC).filter((f) => rel(f) !== DOOR && !(rel(f) in ALLOWED_OWN_VARIANTS) &&
      ownVariantList(fs.readFileSync(f, "utf8"))).map(rel);
    expect(offenders).toEqual([]);
    for (const file of Object.keys(ALLOWED_OWN_VARIANTS)) expect(ownVariantList(fs.readFileSync(path.join(SRC, file), "utf8")), file).toBe(true);
  });
  it("число после «объект» читается только с основой из общего модуля (или исключение с причиной)", () => {
    const offenders = files(SRC).filter((f) => rel(f) !== DOOR && !(rel(f) in ALLOWED_OWN_NUMBER_RULE) &&
      ownNumberRule(fs.readFileSync(f, "utf8"))).map(rel);
    expect(offenders).toEqual([]);
    // Устаревшее исключение не прикрывает будущий обход: файл исчез или уже пошёл через дверь — убрать строку.
    for (const file of Object.keys(ALLOWED_OWN_NUMBER_RULE)) {
      expect(fs.existsSync(path.join(SRC, file)), file).toBe(true);
      expect(ownNumberRule(fs.readFileSync(path.join(SRC, file), "utf8")), file).toBe(true);
    }
  });
  it("сам сторож ловит поломку, ради которой написан", () => {
    expect(ownVariantList("const OBJECT_WORD = `${BW}(?:объект|обьект|обект)\\\\p{L}*`;")).toBe(true);
    expect(ownVariantList(" * «обьект 117» — живой случай")).toBe(false);
    expect(ownNumberRule("const RX = `${BW}(?:объект[а-яё]*)\\\\s*(\\\\d{1,9})`;")).toBe(true);
    expect(ownNumberRule("import { PROPERTY_OBJECT_STEM } from \"../ai/propertyObjectWord.js\";\nconst RX = `${PROPERTY_OBJECT_STEM}\\\\s*(\\\\d+)`;")).toBe(false);
  });
});

describe("«обьект 117» узнают все три читателя номера (живой случай K14–K18, 23.11.2026)", () => {
  const live = "@royal.home.tj  обьект 117 состоит из 7 комнат я провел медные трубы для кондиционеров  7 штук 240 340";
  it.each([
    "обьект 117", "обект 117", "объект 117", "обьекти №117", "@royal.home.tj  обьект 117",
  ])("%s → 117 во всех читателях", (text) => {
    expect(propertyNumberSelectors(text)).toContain("117");
    expect(extractMentionedPropertyNumber(text)).toBe("117");
  });
  it("живой комментарий целиком: номер 117, а не «Какой объект вы имеете в виду?»", () => {
    expect(propertyNumberSelectors(live)).toContain("117");
    expect(extractMentionedPropertyNumber(live)).toBe("117");
  });
  it("подпись поста «Обьект №178» и выбор номера в вопросе о цене", () => {
    expect(captionPropertyNumber("Квартира в Сино. Обьект №178")).toBe("178");
    expect(classifyCustomerPropertyFactIntent("обьект 117 сколько стоит", { hasPropertyContext: false })).toContain("price");
  });
  it("основа не цепляет чужие слова («объявление», «обед»)", () => {
    const rx = new RegExp(`(?<![\\p{L}])${PROPERTY_OBJECT_STEM}`, "iu");
    expect(rx.test("объявление")).toBe(false);
    expect(rx.test("обед в 12")).toBe(false);
  });
});
