import { describe, expect, it } from "vitest";
import { buildPropertyOfferText } from "../src/lib/propertyOfferText.js";

/**
 * Текст подборки, которую агент отправляет клиенту из карточки.
 *
 * До 02.08.2026 заголовок был зашит по-русски: клиент, весь диалог писавший
 * по-таджикски, получал «Посмотрите объекты:». Бот язык держит, агент — нет.
 */

const ONE = [{ shortId: 1042, title: "2-комн, Сино", price: "650 000 с.", url: "https://royalhome.tj/listing/by-crm/uuid-1" }];
const TWO = [
  ...ONE,
  { shortId: 77, title: "3-комн, Фирдавсӣ", price: "$95 000", url: "https://royalhome.tj/listing/by-crm/uuid-2" },
];

describe("Текст подборки объектов клиенту", () => {
  it("таджикский клиент получает таджикский заголовок", () => {
    expect(buildPropertyOfferText(ONE, "tg")).toContain("Ана ин вариант:");
    expect(buildPropertyOfferText(TWO, "tg")).toContain("Ана ин вариантҳо:");
  });

  it("русский клиент — русский", () => {
    expect(buildPropertyOfferText(ONE, "ru")).toContain("Посмотрите объект:");
    expect(buildPropertyOfferText(TWO, "ru")).toContain("Посмотрите объекты:");
  });

  it("смесь языков и неопределённый — русский: он понятен всем", () => {
    expect(buildPropertyOfferText(ONE, "mixed")).toContain("Посмотрите объект:");
    expect(buildPropertyOfferText(ONE, "unknown")).toContain("Посмотрите объект:");
  });

  /** Ссылка by-crm — это тридцать шесть случайных символов. Номер объекта рядом
   *  даёт человеку то, что он может назвать вслух: «а покажите номер 1042». */
  it("номер объекта стоит рядом со ссылкой", () => {
    const text = buildPropertyOfferText(ONE, "ru");
    expect(text).toContain("№1042");
    expect(text).toContain("https://royalhome.tj/listing/by-crm/uuid-1");
  });

  it("несколько объектов нумеруются, один — нет", () => {
    expect(buildPropertyOfferText(TWO, "ru")).toContain("1) №1042");
    expect(buildPropertyOfferText(ONE, "ru")).not.toContain("1) ");
  });
});
