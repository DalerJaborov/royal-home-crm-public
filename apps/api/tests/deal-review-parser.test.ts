import { describe, expect, it } from "vitest";
import { parseDealReviewReply } from "../src/lib/dealReviewParser.js";

/**
 * Разбор ответа на вопрос «как всё прошло» (Пачка 11, 11.09.2026).
 * Чистая функция — без БД, гоняется в любом окружении.
 */
describe("parseDealReviewReply", () => {
  it("оценка одной цифрой без номера", () => {
    expect(parseDealReviewReply("5")).toEqual({ rating: 5, referralPhone: null });
  });

  it("оценка с текстом и номером (пример из задания)", () => {
    const result = parseDealReviewReply("5, 900000000");
    expect(result?.rating).toBe(5);
    expect(result?.referralPhone).toBe("900000000");
  });

  it("оценка без номера с сопроводительным текстом", () => {
    const result = parseDealReviewReply("Всё отлично, ставлю 5 баллов");
    expect(result?.rating).toBe(5);
    expect(result?.referralPhone).toBeNull();
  });

  it("оценка в середине диапазона", () => {
    expect(parseDealReviewReply("на 3")).toEqual({ rating: 3, referralPhone: null });
  });

  it("нет различимой оценки 1-5 — не считается ответом", () => {
    expect(parseDealReviewReply("Спасибо, всё хорошо")).toBeNull();
  });

  it("число вне диапазона 1-5 не считается оценкой (год, а не балл)", () => {
    expect(parseDealReviewReply("Заехали в 2026 году")).toBeNull();
  });

  it("номер телефона с международным кодом", () => {
    const result = parseDealReviewReply("4, +992 910 00 10 44");
    expect(result?.rating).toBe(4);
    expect(result?.referralPhone).toBe("+992 910 00 10 44");
  });

  it("короткая цифра рядом с номером не путается с оценкой", () => {
    // Номер "89" не должен быть принят за оценку — цифра прилипает к соседним.
    const result = parseDealReviewReply("оценка 4, а телефон 89123456789");
    expect(result?.rating).toBe(4);
    expect(result?.referralPhone).toBe("89123456789");
  });
});
