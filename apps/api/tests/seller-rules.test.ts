import { describe, expect, it } from "vitest";
import { buildSellerRules } from "../src/ai/salesPlaybook.js";

/**
 * Настройки продавца: предел вопросов, чем мы не занимаемся, чем мы лучше.
 *
 * Каждый рычаг появился из живой жалобы, а не из фантазии: «бот допрашивает»,
 * «пообещал поискать землю, которой у нас нет», «на „почему вы?“ отвечает общими
 * словами». Проверяем, что настройка доезжает до промта, а пустая — не оставляет
 * пустых заголовков.
 */

describe("Правила продавца собираются из настроек", () => {
  it("предел вопросов называется числом и запрещает переспрашивать", () => {
    const out = buildSellerRules({ maxQuestions: 2, notSelling: "", advantages: "" });
    expect(out).toContain("не больше 2");
    expect(out).toContain("НЕ ПЕРЕСПРАШИВАЙ");
  });

  it("список «не занимаемся» разбирается построчно", () => {
    const out = buildSellerRules({ maxQuestions: 2, notSelling: "Земля и участки\nАренда", advantages: "" });
    expect(out).toContain("Земля и участки; Аренда");
    // Главное — запрет тянуть время: ложная надежда стоит дороже честного отказа.
    expect(out).toContain("без «уточню»");
  });

  it("пустые поля не оставляют пустых разделов в промте", () => {
    const out = buildSellerRules({ maxQuestions: 2, notSelling: "   \n  ", advantages: "  " });
    expect(out).not.toContain("ЧЕМ МЫ НЕ ЗАНИМАЕМСЯ");
    expect(out).not.toContain("ЧЕМ МЫ ЛУЧШЕ");
  });

  it("ноль вопросов — бот не расспрашивает вовсе", () => {
    expect(buildSellerRules({ maxQuestions: 0, notSelling: "", advantages: "" })).toContain("не больше 0");
  });

  it("преимущества попадают в промт как есть", () => {
    const out = buildSellerRules({ maxQuestions: 1, notSelling: "", advantages: "Проверяем документы до показа" });
    expect(out).toContain("Проверяем документы до показа");
  });
});
