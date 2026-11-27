import { describe, expect, it } from "vitest";
import { attentionCount, attentionSources } from "../attentionCount";

/**
 * Метка «Сегодня» (макет 27.11.2026) считает ровно пункты, которые главная руководителя показывает
 * плитками «Ждут ответа»/«Горит» и строками «Ещё срочно» (home2/blocks.tsx → PulseTiles), а не сумму чисел.
 * Обе стороны берут числа одной функцией attentionSources.
 */
describe("attentionCount", () => {
  it("считает пункты, у которых есть что делать", () => {
    expect(attentionCount({ waitingHuman: 4, burning: 1, missedCallsToday: 2, unaccepted: 1, overdueTasks: 3 })).toBe(5);
    expect(attentionCount({ waitingHuman: 4, missedCallsToday: 0, unaccepted: 0 })).toBe(1);
  });
  it("нет данных или всё спокойно — ноль (метки нет)", () => {
    expect(attentionCount({})).toBe(0);
    expect(attentionCount({ waitingHuman: null, missedCallsToday: undefined, unaccepted: 0, burning: 0 })).toBe(0);
  });
});

describe("attentionSources", () => {
  const snap = {
    hero: { missedCallsToday: 2 },
    bot: { attention: { waitingHuman: { count: 4 } } },
    firstLine: { totalCount: 1 },
    team: { agents: [{ overdueTasks: 2 }, { overdueTasks: undefined }, { overdueTasks: 1 }] },
    live: { unacceptedTotal: 3 },
  };

  it("просрочки агентов — пункт только у РОП, как на главной", () => {
    expect(attentionSources({ ...snap, role: "HEAD_OF_SALES" }).overdueTasks).toBe(3);
    expect(attentionSources({ ...snap, role: "DIRECTOR" }).overdueTasks).toBeNull();
    expect(attentionCount(attentionSources({ ...snap, role: "HEAD_OF_SALES" }))).toBe(5);
    expect(attentionCount(attentionSources({ ...snap, role: "DIRECTOR" }))).toBe(4);
  });

  it("нет источника — null, а не ноль", () => {
    expect(attentionSources({ role: "DIRECTOR" })).toEqual({
      waitingHuman: null, burning: null, missedCallsToday: null, unaccepted: null, overdueTasks: null,
    });
  });
});
