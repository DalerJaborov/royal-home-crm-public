// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * ГЛАВНЫЕ РУКОВОДИТЕЛЕЙ (20.11.2026): правила (тренд, период, состояние сотрудника) и
 * блоки директора, акционера и РОП на подменённом снимке пульта.
 */
const NOW = Date.parse("2026-11-20T09:00:00Z"); // 14:00 по Душанбе
const h = vi.hoisted(() => ({
  role: "DIRECTOR",
  perms: new Set<string>(["dashboard.analytics", "finance.view", "team.viewFull", "settings.manage"]),
  mc: { data: undefined as unknown, isLoading: false, isError: false },
  live: { data: undefined as unknown, isPending: false, isError: false },
}));
vi.mock("../../../store/auth", async (importOriginal) => ({
  ...await importOriginal<typeof import("../../../store/auth")>(),
  useAuthStore: (select: (s: unknown) => unknown) => select({ agent: { id: "a1", fullName: "Фарход Назаров", role: h.role } }),
}));
vi.mock("../../../lib/permissions", async (importOriginal) => ({
  ...await importOriginal<typeof import("../../../lib/permissions")>(), useCan: () => (p: string) => h.perms.has(p),
}));
vi.mock("../../../lib/navigation", async (importOriginal) => ({
  ...await importOriginal<typeof import("../../../lib/navigation")>(),
  useNavigation: () => ({ all: ["/finance", "/settings", "/messages", "/calls", "/team", "/deals", "/clients", "/sources"].map((to) => ({ to })) }),
}));
vi.mock("../../../hooks/useMissionControl", async (importOriginal) => ({
  ...await importOriginal<typeof import("../../../hooks/useMissionControl")>(),
  useMissionControl: () => ({ ...h.mc, refetch: vi.fn() }),
}));
vi.mock("../../../hooks/useTeamLive", async (importOriginal) => ({
  ...await importOriginal<typeof import("../../../hooks/useTeamLive")>(), useTeamLive: () => ({ ...h.live, refetch: vi.fn() }),
}));

import { agentStatus, commissionTrend, previousMonthPeriod, waitLabel } from "./leader";
import { DirectorMoney, DirectorCommission } from "./blocks/director";
import { LeaderTeam } from "./blocks/leader";
import { RopTiles } from "./blocks/rop";
import { HOME_LAYOUT, HOME_BLOCKS } from "./registry";
import { homeBlocksFor } from "./core";

const wrap = (node: React.ReactNode) => render(
  <QueryClientProvider client={new QueryClient()}><MemoryRouter>{node}</MemoryRouter></QueryClientProvider>,
);
const tj = (iso: string) => new Date(Date.parse(`${iso}+05:00`));

function snapshot(over: { commission?: Record<string, unknown> | null; seesMoney?: boolean; agents?: unknown[]; day?: unknown; workdayStartAt?: string } = {}) {
  return {
    generatedAt: new Date(NOW).toISOString(), seesMoney: over.seesMoney ?? true, modulesOff: [],
    hero: {
      commission: over.commission === null ? null : {
        fact: 15_510, plan: 8000, planIsDefault: true, forecastEndOfMonth: 0, forecastPercent: 0,
        previousMonthToDate: 12_000, previousMonthTotal: 31_000, pipeline: { deals: 3, expectedTjs: 8200 }, ...over.commission,
      },
      profit: null, leadsToday: { count: 10, deltaVsYesterday: 3 }, firstResponse: { medianMinYesterday: 12, noneCountYesterday: 0 },
      missedCallsToday: 3, dealsInPipeline: { count: 9, byStage: [] },
    },
    bot: { ai: {}, guardHitsToday: 0, outboundShieldToday: 0, unresolvedFindings: null,
      attention: { silent: { count: 0, items: [], reason: null }, waitingHuman: { count: 0, items: [], reason: null }, liveCount: 0, items: [] } },
    team: { agents: over.agents ?? [], day: over.day, workdayStartAt: over.workdayStartAt },
    marketing: { funnel: [{ source: "site", label: "Сайт", leadsMonth: 4, dealsClosedMonth: 1 }] },
    commission12: { reason: null, months: [{ month: "2026-10", amountTjs: 0, deals: 0 }, { month: "2026-11", amountTjs: 15_510, deals: 2 }], totalTjs: 15_510, bestMonth: null, expensesMonthTjs: 4000 },
  };
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(NOW);
  h.role = "DIRECTOR";
  h.perms = new Set(["dashboard.analytics", "finance.view", "team.viewFull", "settings.manage"]);
  h.mc = { data: snapshot(), isLoading: false, isError: false };
  h.live = { data: { agents: [], unaccepted: [], unacceptedTotal: 0, escalatedTotal: 0, queuedTotal: 0 }, isPending: false, isError: false };
});
afterEach(() => { cleanup(); vi.useRealTimers(); });

describe("правила главной руководителя", () => {
  it("тренд к прошлому месяцу: рост, падение, ровно; ноль в прошлом — рост без процента; нечего сравнивать — нет тренда", () => {
    expect(commissionTrend(120, 100)).toEqual({ dir: "up", pct: 20 });
    expect(commissionTrend(80, 100)).toEqual({ dir: "down", pct: 20 });
    expect(commissionTrend(100, 100)).toEqual({ dir: "flat", pct: 0 });
    expect(commissionTrend(5, 0)).toEqual({ dir: "up", pct: null });
    expect(commissionTrend(0, 0)).toBeNull();
    expect(commissionTrend(10, null)).toBeNull();
    expect(commissionTrend(10, undefined)).toBeNull();
  });

  it("период сравнения по Душанбе: «1–20 октября», короткий февраль, 1-е число и граница суток", () => {
    expect(previousMonthPeriod(tj("2026-11-20T14:00:00"))).toEqual({ range: "1–20 октября", month: "октябрь" });
    expect(previousMonthPeriod(tj("2027-03-31T10:00:00")).range).toBe("1–28 февраля");
    expect(previousMonthPeriod(tj("2026-12-01T09:00:00")).range).toBe("1 ноября");
    // 30 ноября 20:00 UTC — в Душанбе уже 1 декабря.
    expect(previousMonthPeriod(new Date(Date.UTC(2026, 10, 30, 20))).range).toBe("1 ноября");
  });

  it("сколько ждёт — минуты, часы, дни", () => {
    expect(waitLabel(40)).toBe("40 мин");
    expect(waitLabel(80)).toBe("1 ч 20 мин");
    expect(waitLabel(120)).toBe("2 ч");
    expect(waitLabel(3000)).toBe("2 дн.");
  });

  it("сотрудник: «не принял вовремя» и «сегодня не заходил» — тревога; до начала дня и на паузе — нет", () => {
    const now = new Date(NOW);
    const base = { activeLoad: 4, pendingAccept: 0 };
    const started = tj("2026-11-20T09:30:00").toISOString();
    const yesterday = tj("2026-11-19T17:00:00").toISOString();
    expect(agentStatus({ ...base, lastSeenAt: yesterday }, { lateLeads: 2, actionsToday: 0, workdayStartAt: started, now }).flag)
      .toEqual({ tone: "crit", text: "не принял вовремя: 2 заявки" });
    const absent = agentStatus({ ...base, lastSeenAt: yesterday }, { lateLeads: 0, actionsToday: 0, workdayStartAt: started, now });
    expect(absent.flag).toEqual({ tone: "crit", text: "сегодня не заходил" });
    expect(absent.seen).toBe("заходил 19 ноября");
    // Рабочий день ещё не начался — молчим.
    expect(agentStatus({ ...base, lastSeenAt: yesterday }, { lateLeads: 0, actionsToday: 0, workdayStartAt: tj("2026-11-20T15:00:00").toISOString(), now }).flag).toBeNull();
    // Без часа начала дня (старый ответ сервера) — тоже молчим.
    expect(agentStatus({ ...base, lastSeenAt: yesterday }, { lateLeads: 0, actionsToday: 0, now }).flag).toBeNull();
    // Дела за сегодня неизвестны — не обвиняем.
    expect(agentStatus({ ...base, lastSeenAt: yesterday }, { lateLeads: 0, actionsToday: null, workdayStartAt: started, now }).flag).toBeNull();
    // Записал звонок с телефона, в CRM не заходил — работал.
    expect(agentStatus({ ...base, lastSeenAt: yesterday }, { lateLeads: 0, actionsToday: 3, workdayStartAt: started, now }).flag).toBeNull();
    expect(agentStatus({ ...base, lastSeenAt: yesterday, takesLeads: false }, { lateLeads: 0, actionsToday: 0, workdayStartAt: started, now }).flag)
      .toEqual({ tone: "muted", text: "приём заявок на паузе" });
    expect(agentStatus({ ...base, lastSeenAt: tj("2026-11-20T09:40:00").toISOString(), overdueTasks: 3 }, { lateLeads: 0, actionsToday: 0, workdayStartAt: started, now }))
      .toMatchObject({ seen: "заходил в 09:40", flag: { tone: "warn", text: "просрочено: 3 задачи" } });
    expect(agentStatus({ ...base, lastSeenAt: new Date(NOW - 5 * 60_000).toISOString() }, { lateLeads: 0, actionsToday: 0, now }).seen).toBe("сейчас в CRM");
    expect(agentStatus({ ...base, lastSeenAt: null }, { lateLeads: 0, actionsToday: 0, now }).seen).toBe("ещё не заходил в CRM");
  });
});

describe("плита денег и плитки директора", () => {
  it("сравнение с прошлым месяцем, ожидаемое по сделкам, заявки против вчера; плана нет — процента нет", () => {
    const { container } = wrap(<DirectorMoney role="DIRECTOR" />);
    const hero = container.querySelector('[data-hero="money"]')!;
    expect(hero.textContent).toContain("Комиссия за ноябрь");
    expect(hero.textContent).toContain("больше на 29%, чем за 1–20 октября");
    expect(hero.textContent).toContain("ожидается ≈");
    expect(hero.textContent).toContain("по 3 сделкам в работе");
    expect(hero.textContent).toContain("октябрь целиком");
    expect(hero.textContent).toContain("10 заявок сегодня · вчера 7");
    expect(hero.textContent).not.toContain("плана");
    expect(hero.querySelector(".ry-hero-bar")).toBeNull();
    expect(screen.getByRole("link", { name: "Задать план месяца" }).getAttribute("href")).toBe("/settings?tab=money");
    // «Сделки идут» были покупателями в работе — такой подписи больше нет.
    expect(container.textContent).not.toContain("сделок идут");
  });

  it("план задан — полоса и процент; без права на настройки — ссылки «Задать план» нет", () => {
    h.mc = { ...h.mc, data: snapshot({ commission: { plan: 25_000, planIsDefault: false } }) };
    h.perms.delete("settings.manage");
    const { container } = wrap(<DirectorMoney role="DIRECTOR" />);
    expect(container.querySelector(".ry-hero-bar")).not.toBeNull();
    expect(container.textContent).toContain("62% плана");
    expect(screen.queryByRole("link", { name: "Задать план месяца" })).toBeNull();
  });

  it("плитки по смыслу: «Ждут ответа 0» — серая, «Пропущенные звонки 3» — красная; плитки «Горит» нет", () => {
    const { container } = wrap(<DirectorMoney role="DIRECTOR" />);
    const tile = (label: string) => [...container.querySelectorAll(".ry-tile")].find((t) => t.textContent?.includes(label));
    expect(tile("Ждут ответа")?.getAttribute("data-variant")).toBe("calm");
    expect(tile("Пропущенные звонки")?.getAttribute("data-variant")).toBe("crit");
    expect(tile("Пропущенные звонки")?.textContent).toContain("сегодня");
    expect(tile("Горит")).toBeUndefined();
    expect(container.querySelector('.ry-tile[data-variant="ink"]')).toBeNull();
  });

  it("без права на деньги денег нет: вместо плиты — «Покупатели в работе»", () => {
    h.mc = { ...h.mc, data: snapshot({ commission: null, seesMoney: false }) };
    const { container } = wrap(<DirectorMoney role="DIRECTOR" />);
    expect(container.querySelector('[data-hero="money"]')).toBeNull();
    expect(container.textContent).toContain("Покупатели в работе");
    expect(container.textContent).not.toMatch(/сомони|\d с\./);
  });

  it("акционер: деньги и тренды, без «Ждут ответа» и звонков", () => {
    h.role = "SHAREHOLDER";
    const { container } = wrap(<DirectorMoney role="SHAREHOLDER" />);
    expect(container.querySelector('[data-hero="money"]')).not.toBeNull();
    expect(container.textContent).not.toContain("Ждут ответа");
    expect(container.textContent).not.toContain("Пропущенные");
    expect(container.textContent).not.toContain("заявок сегодня");
    const deals = [...container.querySelectorAll(".ry-tile")].find((t) => t.textContent?.includes("Сделки закрыты"));
    expect(deals?.getAttribute("data-variant")).toBe("ok");
    expect(container.textContent).toContain("Расходы");
  });

  it("комиссия по месяцам с одним месяцем — тихая строка, а не график из одного столбика", () => {
    const { container } = wrap(<DirectorCommission />);
    expect(container.querySelector(".ry-home-chart")).toBeNull();
    expect(container.querySelector(".ry-home-quiet")?.textContent).toContain("пока только один месяц");
  });
});

describe("«Команда» руководителя", () => {
  it("тревоги сверху: не принял вовремя и не заходил; звонки сегодня и нагрузка в строке", () => {
    const yesterday = tj("2026-11-19T17:00:00").toISOString();
    h.mc = { ...h.mc, data: snapshot({
      workdayStartAt: tj("2026-11-20T09:30:00").toISOString(),
      agents: [
        { id: "g1", fullName: "Бону Саидова", avatarUrl: null, activeLoad: 9, pendingAccept: 0, acceptedToday: 1, buyerCount: 0, sellerCount: 0, lastSeenAt: tj("2026-11-20T13:58:00").toISOString() },
        { id: "g2", fullName: "Далер Сафаров", avatarUrl: null, activeLoad: 2, pendingAccept: 0, acceptedToday: 0, buyerCount: 0, sellerCount: 0, lastSeenAt: yesterday },
        { id: "g3", fullName: "Мадина Каримова", avatarUrl: null, activeLoad: 5, pendingAccept: 1, acceptedToday: 0, buyerCount: 0, sellerCount: 0, lastSeenAt: tj("2026-11-20T09:40:00").toISOString() },
      ],
      day: { reason: null, calls: 5, showings: 0, tasksDone: 0, messages: 0, rows: [
        { agentId: "g1", name: "Бону", calls: 5, showings: 0, tasksDone: 0, messages: 0, total: 5 },
        { agentId: "g3", name: "Мадина", calls: 0, showings: 0, tasksDone: 0, messages: 0, total: 0 },
      ] },
    }) };
    h.live = { ...h.live, data: { agents: [{ id: "g3", fullName: "Мадина", avatarUrl: null, activeLoad: 5, pendingAccept: 1, acceptedToday: 0, escalated: 2 }], unaccepted: [], unacceptedTotal: 1, escalatedTotal: 2, queuedTotal: 0 } };
    const { container } = wrap(<LeaderTeam />);
    const rows = [...container.querySelectorAll(".ry-row")];
    expect(rows.map((r) => r.querySelector(".ry-row-title")?.textContent)).toEqual(["Мадина Каримова", "Далер Сафаров", "Бону Саидова"]);
    expect(rows[0].textContent).toContain("не принял вовремя: 2 заявки");
    expect(rows[1].textContent).toContain("сегодня не заходил");
    expect(rows[2].textContent).toContain("сейчас в CRM · звонков 5 · в работе 9");
    expect(rows[2].querySelector(".ry-home-chip")).toBeNull();
  });
});

describe("РОП: свой набор плиток", () => {
  it("ждут ответа, пропущенные, просрочки агентов, не приняли вовремя — срочное красным, ноль серым", () => {
    h.role = "HEAD_OF_SALES";
    h.perms = new Set(["dashboard.analytics", "team.viewFull"]);
    const data = snapshot({ commission: null, seesMoney: false, agents: [
      { id: "g1", fullName: "Бону", avatarUrl: null, activeLoad: 1, pendingAccept: 0, acceptedToday: 0, buyerCount: 0, sellerCount: 0, overdueTasks: 2 },
      { id: "g2", fullName: "Далер", avatarUrl: null, activeLoad: 1, pendingAccept: 0, acceptedToday: 0, buyerCount: 0, sellerCount: 0, overdueTasks: 1 },
    ] }) as ReturnType<typeof snapshot>;
    data.bot.attention.waitingHuman = { count: 2, reason: null, items: [{ waitingMinutes: 80 }, { waitingMinutes: 15 }] } as never;
    h.mc = { ...h.mc, data };
    h.live = { ...h.live, data: { agents: [], unaccepted: [], unacceptedTotal: 0, escalatedTotal: 0, queuedTotal: 0 } };
    const { container } = wrap(<RopTiles />);
    const tiles = [...container.querySelectorAll(".ry-tile")].map((t) => [t.querySelector(".ry-tile-label")?.textContent, t.getAttribute("data-variant"), t.querySelector(".ry-tile-value")?.textContent]);
    expect(tiles).toEqual([
      ["Ждут ответа", "crit", "2"],
      ["Пропущенные звонки", "crit", "3"],
      ["Просрочки агентов", "crit", "3"],
      ["Не приняли вовремя", "calm", "0"],
    ]);
    expect(container.textContent).toContain("дольше всех 1 ч 20 мин");
  });
});

describe("раскладка ролей", () => {
  it("акционер — деньги и тренды без операционных блоков; РОП — свой набор", () => {
    const ids = (role: string) => homeBlocksFor(role, HOME_BLOCKS, HOME_LAYOUT).map((b) => b.id);
    expect(ids("SHAREHOLDER")).toEqual(["money", "commission", "pulse", "channels", "ask"]);
    expect(ids("HEAD_OF_SALES")).toEqual(["ropTiles", "ropSpread", "ropTeam", "ropTasks", "ropLosses", "teamCharts", "full"]);
    expect(ids("MANAGER")).not.toContain("money");
  });
});
