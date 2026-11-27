import { describe, expect, it } from "vitest";
import { attentionCount } from "../attentionCount";

/** Метка «Сегодня» (макет 27.11.2026) считает ровно пункты полосы «Требует внимания сейчас», а не сумму чисел. */
describe("attentionCount", () => {
  it("считает пункты, у которых есть что делать", () => {
    expect(attentionCount({ waitingHuman: 4, missedCallsToday: 2, unaccepted: 1 })).toBe(3);
    expect(attentionCount({ waitingHuman: 4, missedCallsToday: 0, unaccepted: 0 })).toBe(1);
  });
  it("нет данных или всё спокойно — ноль (метки нет)", () => {
    expect(attentionCount({})).toBe(0);
    expect(attentionCount({ waitingHuman: null, missedCallsToday: undefined, unaccepted: 0 })).toBe(0);
  });
});
