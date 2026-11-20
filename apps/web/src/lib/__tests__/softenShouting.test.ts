import { describe, expect, it } from "vitest";
import { KNOWN_SHOUTING_LABELS, softenShouting } from "../softenShouting";

describe("заметки без крика", () => {
  it("кадр владельца: известные капс-метки и их значки превращаются в обычный текст", () => {
    const out = softenShouting("📞 ПРОСИТ ПЕРЕЗВОНИТЬ: Хочет продать. Слова клиента: «Салом» ❓ ТИП ОБРАЩЕНИЯ НЕ ОПРЕДЕЛЁН — разобрать вручную");
    expect(out).toBe("Просит перезвонить: Хочет продать. Слова клиента: «Салом» Тип обращения не определён — разобрать вручную");
    expect(out).not.toContain("📞"); expect(out).not.toContain("❓");
  });
  it("названия, сокращения и любой другой текст заглавными не трогаются", () => {
    for (const text of ["Хочет ЖК ДИАМОНД, этаж 5", "Работает в ООО СОМОН ТРЕЙД", "Справка из ГУВД: чисто", "Позвонил в ГК, ИИ оценил на 40", "Ищет дом, район Назди Сомон", "ПРОСИТ СКИДКУ на объект"]) {
      expect(softenShouting(text)).toBe(text);
    }
  });
  it("двоеточие и регистр вокруг метки не меняются", () => {
    expect(softenShouting("Заметка: клиент сказал: «позвоните»")).toBe("Заметка: клиент сказал: «позвоните»");
    expect(softenShouting("ПРОСИТ ПЕРЕЗВОНИТЬ: нужен показ")).toBe("Просит перезвонить: нужен показ");
  });
  it("пустое — пустая строка; список известных меток не пуст", () => {
    expect(softenShouting(null)).toBe(""); expect(softenShouting("")).toBe("");
    expect(KNOWN_SHOUTING_LABELS.length).toBeGreaterThan(0);
  });
});
