import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { isFunnelEmpty, selectFunnelStages } from "../reportFunnelView";

describe("выбор ступеней по ключам API", () => {
  it("сохраняет смысл показателей при перестановке и добавлении ступени", () => {
    const funnel = [
      { key: "deals", count: 2, commission: null },
      { key: "new-server-stage", count: 999 },
      { key: "negotiations", count: 5 },
      { key: "leads", count: 12 },
      { key: "showings", count: 7 },
    ];
    const result = selectFunnelStages(funnel);
    expect(result.leads?.count).toBe(12);
    expect(result.showings?.count).toBe(7);
    expect(result.negotiations?.count).toBe(5);
    expect(result.deals).toBe(funnel[0]);
    expect(result.deals?.commission).toBeNull();
  });

  it("не подставляет соседнюю ступень вместо отсутствующего показателя", () => {
    const result = selectFunnelStages([{ key: "contacted", count: 8 }, { key: "deals", count: 0 }]);
    expect(result.leads).toBeUndefined();
    expect(result.showings).toBeUndefined();
    expect(result.negotiations).toBeUndefined();
    expect(result.deals?.count).toBe(0);
  });

  it("не придумывает нулевые значения при отсутствии ответа", () => {
    expect(selectFunnelStages([])).toEqual({ leads: undefined, showings: undefined, negotiations: undefined, deals: undefined });
  });
});

/** Аудит 04.10.2026, WEB-PAGES17: отчёт говорил «показов и сделок не было» при реальной сделке. */
describe("пустая воронка отчёта", () => {
  it("лидов 0, но есть показ, сделка и комиссия: воронка не пуста", () => {
    const funnel = [
      { count: 0 },
      { count: 0 },
      { count: 1 },
      { count: 0 },
      { count: 1, commission: 5000 },
    ];
    expect(isFunnelEmpty(funnel)).toBe(false);
  });

  it("всё по нулям: пуста", () => {
    expect(isFunnelEmpty([{ count: 0 }, { count: 0, commission: 0 }, { count: 0, commission: null }])).toBe(true);
    expect(isFunnelEmpty([])).toBe(true);
  });

  it("одна комиссия без счётчиков тоже показывается", () => {
    expect(isFunnelEmpty([{ count: 0 }, { count: 0, commission: 100 }])).toBe(false);
  });
});

describe("Reports", () => {
  it("страница не считает воронку пустой только по нулю лидов", () => {
    const src = readFileSync(fileURLToPath(new URL("../../pages/Reports.tsx", import.meta.url)), "utf8");
    expect(src).toContain("isFunnelEmpty(funnel)");
    expect(src).not.toContain("deals && leads && leads.count === 0");
  });
});
