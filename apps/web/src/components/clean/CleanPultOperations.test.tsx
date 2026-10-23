import type { ReactNode } from "react";
import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router-dom";
import type { McBot, McControlGaps, McHero, McSystem } from "../../hooks/useMissionControl";
import { CleanControlTiles, CleanFinancialPulse, CleanSystemBotDetails } from "./CleanPultOperations";
import { CleanFeaturedProperty } from "./CleanFeaturedProperty";

const render = (node: ReactNode) => renderToStaticMarkup(<MemoryRouter>{node}</MemoryRouter>);
const control: McControlGaps = {
  phones: { total: 0, online: 0, items: [], reason: null },
  overdueTasks: { count: 7, items: [], reason: null },
  atLimit: { count: 2, items: [], reason: null },
  silentAfterShowing: { count: 3, reason: null },
};
const hero: McHero = {
  profit: { todayTjs: -1200, previousTodayTjs: 900 },
  commission: { fact: 600, plan: 8000, forecastEndOfMonth: 2800, forecastPercent: 35 },
  leadsToday: { count: 0, deltaVsYesterday: 0 }, firstResponse: { medianMinYesterday: null, noneCountYesterday: 0 },
  missedCallsToday: 0, dealsInPipeline: { count: 0, byStage: [] },
};
const system: McSystem = { crons: [], jobsRunning: 2, jobsGivenUp: 3, jobsGivenUpLast24h: 1, newApplications: 0, errorsToday: 4 };
const bot: McBot = {
  ai: { requestsToday: 12, errorsToday: 1, errorRatePercent: 8, costUsdToday: 0.75, avgMs: 1300 },
  guardHitsToday: 3, outboundShieldToday: 1, unresolvedFindings: null,
};

describe("Clean operational dashboard", () => {
  it("keeps control counters separate and respects destination permission", () => {
    const html = render(<CleanControlTiles control={control} allowed />);
    for (const slice of ["slice-overdue-tasks", "slice-agents-at-limit", "slice-silent-after-showing"])
      expect(html.match(new RegExp(`href="/oversight#${slice}"`, "g")) ?? []).toHaveLength(1);
    for (const value of [7, 2, 3]) expect(html).toContain(`>${value}</strong>`);
    expect(html).toContain("Без ответа после показа");
    expect(render(<CleanControlTiles control={control} allowed={false} />)).toBe("");
    expect(render(<CleanControlTiles control={undefined} allowed />)).toBe("");
  });

  it("shows actual cash balance and forecast without claiming received profit", () => {
    const html = render(<CleanFinancialPulse hero={hero} canSeeMoney moneyRoute />).replace(/\s/g, " ");
    expect(html).toContain("Баланс дня · сегодня");
    expect(html).toContain("-1 200");
    expect(html).toContain("Предыдущий день: 900");
    expect(html).toContain("2 800");
    expect(html).toContain("35% плана");
    expect(html).toContain("Это прогноз, а не полученные деньги");
    expect(html).toContain('href="/finance"');
    expect(render(<CleanFinancialPulse hero={hero} canSeeMoney={false} moneyRoute />)).toBe("");
    expect(render(<CleanFinancialPulse hero={{ ...hero, profit: null, commission: null }} canSeeMoney moneyRoute />)).toBe("");
  });

  it("does not turn absent health checks or failed bot audit into a healthy zero", () => {
    const html = render(<CleanSystemBotDetails system={system} bot={bot} canHealth canMessages canBotLearning canSeeMoney={false} />);
    expect(html).toContain("Нет данных");
    expect(html).toContain("Проверка недоступна");
    expect(html).not.toContain("Расход на ИИ");
    expect(html).toContain("Брошено за 24 часа");
    expect(html).toContain('href="/messages"');
    expect(render(<CleanSystemBotDetails system={system} bot={null} canHealth={false} canMessages={false} canBotLearning={false} canSeeMoney={false} />)).toBe("");
  });

  it("uses a compact property card when no photo exists, preserving the actual destination", () => {
    const html = render(<CleanFeaturedProperty to="/properties/42" title="Дом" subtitle="Сомони · 1200 с." featured showings={0} />);
    expect(html).toContain('href="/properties/42"');
    expect(html).toContain("min-height:0");
    expect(html).toContain("Фото пока недоступно · показов: 0");
    expect(html).toContain('src="/illustrations/property-empty.png"');
    expect(html).toContain('alt="" aria-hidden="true"');
    expect(html).not.toContain("clean-hero-copy");
  });
});
