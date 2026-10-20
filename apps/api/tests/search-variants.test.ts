import { describe, expect, it } from "vitest";
import { toSearchTokens, toTokenVariants } from "../src/lib/searchTokens.js";

/** Написания, которые поиск обязан считать одним и тем же словом (требование
 *  владельца от 30.07: забытая раскладка, латиница, таджикские буквы). */

describe("Слова запроса", () => {
  it("режутся по любым знакам, а не только по пробелу", () => {
    expect(toSearchTokens("пр. Рудаки, 45")).toEqual(["пр", "Рудаки", "45"]);
  });

  it("запрос из одних знаков препинания слов не даёт — фильтра не будет", () => {
    expect(toSearchTokens(", . -")).toEqual([]);
  });

  it("длинный запрос обрезается — сотня условий ILIKE на строку недопустима", () => {
    expect(toSearchTokens(Array(30).fill("сло").join(" ")).length).toBe(8);
  });
});

describe("Написания одного слова", () => {
  it("забытая раскладка: Helfrb — это Рудаки", () => {
    expect(toTokenVariants("Helfrb")).toContain("рудаки");
  });

  it("забытая раскладка в другую сторону: рудаки даёт latin-набор", () => {
    expect(toTokenVariants("рудаки")).toContain("helfrb");
  });

  it("латиница: Rudaki — это Рудаки", () => {
    expect(toTokenVariants("Rudaki")).toContain("рудаки");
  });

  it("латиница с диграфом: Shohmansur разбирается как Шохмансур, а не с+х", () => {
    expect(toTokenVariants("Shoh")).toContain("шоҳ");
  });

  it("таджикские буквы сворачиваются к простым: Ҳофиз найдётся как Хофиз", () => {
    expect(toTokenVariants("ҳофиз")).toContain("хофиз");
  });

  it("мусорных смешанных вариантов не делаем: перекладка идёт только целым словом", () => {
    // «хофиз» в латинской раскладке дало бы «хjabp» (х не на латинской клавише) —
    // совпасть такая строка ни с чем не может, а условие ILIKE стоило бы столько же.
    expect(toTokenVariants("хофиз").every((v) => !/[а-яё].*[a-z]|[a-z].*[а-яё]/.test(v))).toBe(true);
  });

  it("само слово всегда первое — обычный поиск не страдает", () => {
    expect(toTokenVariants("Рудаки")[0]).toBe("рудаки");
  });

  it("вариантов не больше четырёх на слово", () => {
    expect(toTokenVariants("шохмансур").length).toBeLessThanOrEqual(4);
  });

  it("однобуквенное слово не превращается в вариант, который найдёт пол-базы", () => {
    expect(toTokenVariants("я")).toEqual(["я"]);
  });

  it("цифры остаются цифрами", () => {
    expect(toTokenVariants("45")).toEqual(["45"]);
  });
});
