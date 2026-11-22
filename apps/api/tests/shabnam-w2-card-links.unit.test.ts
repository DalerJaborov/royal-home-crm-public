import { describe, expect, it } from "vitest";
import { createCardLinkEvidence } from "../src/ai/assistant/cardLinkEvidence.js";

/**
 * СТОРОЖ ССЫЛОК НА КАРТОЧКИ: ЛОЖНЫЕ ОТКАЗЫ (журнал прода 10–17.11.2026, 3 из 56 обращений).
 * Сторож создан против выдуманных моделью ссылок на карточки. Обычные просьбы он резать
 * не должен: ссылка на раздел — не карточка; номер из исполненной записи — из базы;
 * неподтверждённая ссылка становится текстом, а не отказом на весь ответ.
 */
describe("ссылки на разделы — не карточки", () => {
  it("«если файл отправлю…» без инструментов: [Новый объект](/properties/new) проходит", () => {
    const guard = createCardLinkEvidence();
    expect(guard.validate("Да, откройте [Новый объект](/properties/new) и загрузите файл.").ok).toBe(true);
    expect(guard.validate("Карта объектов: /properties/map").ok).toBe(true);
  });

  it("«Покажи 2-комнатные до 400 000 с.» — ссылка на список с фильтрами проходит, выдуманная карточка — нет", () => {
    const guard = createCardLinkEvidence();
    expect(guard.validate("Все варианты: [список](/properties?rooms=2&maxPrice=400000&district=Сино)").ok).toBe(true);
    expect(guard.validate("Клиенты: /clients?q=Сино").ok).toBe(true);
    expect(guard.validate("[2-комн](/properties/777)").ok).toBe(false);
    // Запрос к КАРТОЧКЕ (а не к списку) по-прежнему не доверяется.
    guard.observe("get_property_card", { id: "known" });
    expect(guard.validate("[x](/properties/known?redirect=elsewhere)").ok).toBe(false);
  });
});

describe("номер карточки из исполненной записи", () => {
  it("change_property_price done: propertyShortId из базы подтверждает /properties/164", () => {
    const guard = createCardLinkEvidence();
    guard.observe("change_property_price", { done: true, result: { propertyShortId: 164, href: "/properties/164?changeRequest=r1" } });
    expect(guard.validate("[ОБ-000164](/properties/164)").ok).toBe(true);
  });

  it("неподтверждённая карточка (confirmRequired) и записи, собирающие href из аргументов, — не доказательство", () => {
    const guard = createCardLinkEvidence();
    guard.observe("change_property_price", { confirmRequired: true, actionId: "a", preview: { title: "Цена ОБ-000164" } });
    guard.observe("add_client_note", { done: true, result: { clientShortId: 9, href: "/clients/9" } });
    guard.observe("change_property_status", { error: "нет", done: true, result: { propertyShortId: 5 } });
    expect(guard.validate("/properties/164").ok).toBe(false);
    expect(guard.validate("/clients/9").ok).toBe(false);
    expect(guard.validate("/properties/5").ok).toBe(false);
  });
});

describe("sanitize: неподтверждённая ссылка — обычным текстом, ответ не выбрасывается", () => {
  it("«изменить цену, объект 164, новая цена 1 350 000 сомони»: подпись остаётся, ссылки нет", () => {
    const guard = createCardLinkEvidence();
    const cleaned = guard.sanitize("Подготовила заявку: [ОБ-000164 · 3-комн · Сино](/properties/164), новая цена 1 350 000 сомони. Подтвердите.");
    expect(cleaned).toEqual({ text: "Подготовила заявку: ОБ-000164 · 3-комн · Сино, новая цена 1 350 000 сомони. Подтвердите.", removed: 1 });
  });

  it("настоящая выдуманная ссылка человеку ссылкой не уходит — ни markdown, ни голым путём, ни чужим адресом", () => {
    const guard = createCardLinkEvidence();
    guard.observe("search_properties", [{ id: "real", shortId: 42 }]);
    const cleaned = guard.sanitize(
      "Нашла [ОБ-000042](/properties/42) и [квартиру](/properties/00000000-0000-4000-8000-000000000099). " +
      "Ещё /clients/evil и [сайт](https://evil.example/properties/42).",
    );
    expect(cleaned).not.toBeNull();
    expect(cleaned!.text).toContain("[ОБ-000042](/properties/42)");
    expect(cleaned!.text).not.toContain("00000000-0000-4000-8000-000000000099");
    expect(cleaned!.text).not.toContain("/clients/evil");
    expect(cleaned!.text).not.toContain("evil.example");
    expect(cleaned!.text).toContain("квартиру");
    expect(guard.validate(cleaned!.text).ok).toBe(true);
    expect(cleaned!.removed).toBe(3);
  });

  it("закодированная ссылка тоже снимается; слишком длинный ответ — null (прежний отказ)", () => {
    const guard = createCardLinkEvidence();
    const cleaned = guard.sanitize("Смотрите %2Fproperties%2Fhidden тут");
    expect(cleaned?.text).toBe("Смотрите тут");
    expect(guard.sanitize("x".repeat(32_001))).toBeNull();
  });

  it("ответ без ссылок не трогается", () => {
    const guard = createCardLinkEvidence();
    expect(guard.sanitize("Цена 123, площадь 45  |||  2 комнаты")).toEqual({ text: "Цена 123, площадь 45  |||  2 комнаты", removed: 0 });
  });
});
