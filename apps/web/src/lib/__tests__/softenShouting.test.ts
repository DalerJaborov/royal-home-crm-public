import { describe, expect, it } from "vitest";
import { softenShouting } from "../softenShouting";

describe("заметки без крика", () => {
  it("кадр владельца: капс и значки превращаются в обычный текст", () => {
    const out = softenShouting("📞 ПРОСИТ ПЕРЕЗВОНИТЬ: Хочет продать. Слова клиента: «Салом» ❓ ТИП ОБРАЩЕНИЯ НЕ ОПРЕДЕЛЁН — разобрать вручную");
    expect(out).toBe("Просит перезвонить: Хочет продать. Слова клиента: «Салом» Тип обращения не определён — разобрать вручную");
    expect(out).not.toMatch(/[А-ЯЁ]{4,}/); expect(out).not.toContain("📞"); expect(out).not.toContain("❓");
  });
  it("короткие сокращения и обычный текст не трогаются", () => {
    expect(softenShouting("Позвонил в ГК, ИИ оценил на 40")).toBe("Позвонил в ГК, ИИ оценил на 40");
    expect(softenShouting("Ищет дом, район Назди Сомон")).toBe("Ищет дом, район Назди Сомон");
    expect(softenShouting(null)).toBe(""); expect(softenShouting("")).toBe("");
  });
  it("строки сохраняются, у каждой своя заглавная", () => {
    expect(softenShouting("❓ ТИП ОБРАЩЕНИЯ НЕ ОПРЕДЕЛЁН — уточните\nвторая строка")).toBe("Тип обращения не определён — уточните\nвторая строка");
  });
});
