import { describe, expect, it } from "vitest";
import { contactProfileBlock, type ContactProfileForPrompt } from "../src/ai/contactProfileBlock.js";

/**
 * БЛОК ДОСЬЕ В ПРОМТЕ — чистая функция, стенд не нужен.
 *
 * Проверяется то, чем этот блок опасен, а не то, что он вообще печатается:
 * блок на пустом досье («фальшивое знакомство»), телефон в промте и потеря
 * оговорки «это прошлое». Всё остальное — текст, и его правят без страха.
 */

const EMPTY: ContactProfileForPrompt = {
  category: "UNKNOWN",
  previousCategories: [],
  selfName: null,
  language: null,
  history: null,
  buyer: [],
  seller: [],
  job: [],
  crm: null,
};

describe("блок досье собеседника", () => {
  it("на пустом досье не печатает НИЧЕГО", () => {
    expect(contactProfileBlock(EMPTY)).toBe("");
    expect(contactProfileBlock(null)).toBe("");
    expect(contactProfileBlock(undefined)).toBe("");
  });

  it("печатает роль, имя, язык и историю человеческими словами", () => {
    const block = contactProfileBlock({
      ...EMPTY,
      category: "SELLER",
      selfName: "Далер",
      language: "tg",
      history: "пишет нам с 12.08.2026, 14 сообщений; последнее — 5 дн. назад",
    });
    expect(block).toContain("Кто это: Продавец");
    expect(block).toContain("Далер");
    expect(block).toContain("по-таджикски");
    expect(block).toContain("14 сообщений");
  });

  it("прошлые роли идут с оговоркой «раньше», а не наравне с нынешней", () => {
    const block = contactProfileBlock({
      ...EMPTY,
      category: "BUYER",
      previousCategories: [{ category: "SELLER", when: "01.08.2026" }],
    });
    expect(block).toContain("Кто это: Покупатель");
    expect(block).toContain("раньше: Продавец (01.08.2026)");
  });

  it("сказанное в прошлых разговорах помечено прошлым — иначе модель примет его за нынешний объект", () => {
    const block = contactProfileBlock({ ...EMPTY, seller: ["площадь", "этаж"] });
    expect(block).toContain("называл раньше");
    expect(block).toContain("верь новому");
  });

  it("не печатает номер телефона ни при каких значениях", () => {
    const block = contactProfileBlock({
      ...EMPTY,
      category: "BUYER",
      selfName: "Далер",
      buyer: ["бюджет до 500000"],
      crm: "ПК-000312, агент Умед",
      history: "пишет нам с 12.08.2026, 3 сообщений; последнее — вчера",
    });
    // Девять и больше цифр подряд — это уже номер. Суммы бюджета столько не
    // занимают, а вот подставленный телефон занял бы.
    expect(block).not.toMatch(/\d{9}/);
    expect(block).toContain("не делай вид, что знаешь его");
  });
});
