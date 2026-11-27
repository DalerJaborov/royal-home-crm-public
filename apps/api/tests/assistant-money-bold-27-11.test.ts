import { describe, expect, it } from "vitest";
import { decorateHtml, renderAssistantHtml, sanitizeAssistantReply } from "../src/telegram/assistantReply.js";

/**
 * ЖИРНЫЙ НЕ РВЁТСЯ НА РАЗДЕЛИТЕЛЕ СУММЫ (27.11.2026, скриншот владельца: «3 561,**25 TJS**»).
 * Класс: сумма с пробелами-разделителями тысяч И дробной частью. Правило одно на жирный и на
 * защиту суммы от маски телефонов (MONEY_AMOUNT) — проверяем оба потребителя.
 */
const cases: Array<[string, string]> = [
  ["Доход 3 561,25 TJS", "3 561,25 TJS"],
  ["Расход 1 638,75 TJS", "1 638,75 TJS"],
  ["Итого 12\u00a0000 сомони", "12\u00a0000 сомони"],
  ["Курс 1\u202f234.5 USD", "1\u202f234.5 USD"],
  ["Прибыль 250 TJS", "250 TJS"],
  ["Комиссия 1 000 000,5 TJS", "1 000 000,5 TJS"],
];

describe("сумма жирным целиком", () => {
  it.each(cases)("%s", (text, amount) => {
    expect(decorateHtml(text)).toContain(`<b>${amount}</b>`);
    // Не появляется второго, «оторванного» жирного куска.
    expect(decorateHtml(text).match(/<b>/g)?.length).toBe(1);
  });

  it("ответ помощницы целиком: две суммы — два целых жирных куска", () => {
    const html = renderAssistantHtml("Доходы: **3 561,25 TJS**, расходы: 1 638,75 TJS.", { maskPhones: true });
    expect(html).toContain("<b>3 561,25 TJS</b>");
    expect(html).toContain("<b>1 638,75 TJS</b>");
    expect(html).not.toMatch(/\d,<b>/);
  });

  it("не начинает сумму посреди числа и не трогает телефон", () => {
    expect(decorateHtml("год 2026, 300 TJS")).toContain("<b>300 TJS</b>");
    expect(decorateHtml("+992900000001")).not.toContain("<b>");
  });

  it("маска телефонов не портит сумму с дробной частью", () => {
    expect(sanitizeAssistantReply("Итого 3 561,25 TJS", true)).toContain("3 561,25 TJS");
  });
});

describe("тысячи только группами по три (ревью #506)", () => {
  it("телефон перед суммой не прячется от маски: «927001122 500 TJS»", () => {
    const safe = sanitizeAssistantReply("Позвоните 927001122 500 TJS задаток", true);
    expect(safe).not.toContain("927001122");
    expect(safe).toContain("500 TJS");
    expect(decorateHtml("927001122 500 TJS")).toContain("<b>500 TJS</b>");
    expect(decorateHtml("927001122 500 TJS")).not.toContain("<b>927001122");
  });

  it("сплошная сумма без разделителей — жирным целиком", () => {
    expect(decorateHtml("Расход 1638 TJS")).toContain("<b>1638 TJS</b>");
  });
});
