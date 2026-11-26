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
  hidden: new Set<string>(),
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
vi.mock("./prefs", () => ({ useHomeLayoutPrefs: () => ({ order: undefined, hidden: h.hidden }) }));
vi.mock("../../home/HomeAsk", () => ({ HomeAsk: ({ placeholder }: { placeholder: string }) => <input aria-label="ask" placeholder={placeholder} /> }));
vi.mock("../../../hooks/useTeamLive", async (importOriginal) => ({
  ...await importOriginal<typeof import("../../../hooks/useTeamLive")>(), useTeamLive: () => ({ ...h.live, refetch: vi.fn() }),
}));

import { agentStatus, commissionTrend, previousMonthPeriod, waitLabel } from "./leader";
import { DirectorMoney, DirectorCommission } from "./blocks/director";
import { LeaderTeam } from "./blocks/leader";
import { RopTiles } from "./blocks/rop";
import { HOME_LAYOUT, HOME_BLOCKS } from "./registry";
import { homeBlocksFor, RoyalHomeCore } from "./core";

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
    bot: { ai: {}, guardHitsToday: 0, outboundShieldToday: 0,
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
  h.hidden = new Set();
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

  it("период сравнения по Душанбе — до той же минуты, что считает сервер; короткий прошлый месяц — целиком", () => {
    expect(previousMonthPeriod(tj("2026-11-20T14:00:00"))).toEqual({ range: "1–20 октября до 14:00", month: "октябрь" });
    expect(previousMonthPeriod(tj("2027-03-31T10:00:00")).range).toBe("1–28 февраля");
    expect(previousMonthPeriod(tj("2027-03-28T10:00:00")).range).toBe("1–28 февраля до 10:00");
    expect(previousMonthPeriod(tj("2026-12-01T09:00:00")).range).toBe("1 ноября до 09:00");
    // 30 ноября 20:00 UTC — в Душанбе уже 1 декабря, 01:00.
    expect(previousMonthPeriod(new Date(Date.UTC(2026, 10, 30, 20))).range).toBe("1 ноября до 01:00");
  });

  it("сколько ждёт — минуты, часы, дни", () => {
    expect(waitLabel(40)).toBe("40 мин");
    expect(waitLabel(80)).toBe("1 ч 20 мин");
    expect(waitLabel(120)).toBe("2 ч");
    expect(waitLabel(3000)).toBe("2 дн.");
  });

  it("сотрудник: «не принял вовремя» и «сегодня не заходил» — тревога; до начала дня, в выходной и на паузе — нет", () => {
    const now = new Date(NOW);
    const base = { activeLoad: 4, pendingAccept: 0, actionsToday: 0 };
    const started = tj("2026-11-20T09:30:00").toISOString();
    const yesterday = tj("2026-11-19T17:00:00").toISOString();
    expect(agentStatus({ ...base, lastSeenAt: yesterday }, { lateLeads: 2, workdayStartAt: started, now }).flag)
      .toEqual({ tone: "crit", text: "не принял вовремя: 2 заявки" });
    const absent = agentStatus({ ...base, lastSeenAt: yesterday }, { lateLeads: 0, workdayStartAt: started, now });
    expect(absent.flag).toEqual({ tone: "crit", text: "сегодня не заходил" });
    expect(absent.seen).toBe("заходил 19 ноября");
    // Рабочий день ещё не начался — молчим.
    expect(agentStatus({ ...base, lastSeenAt: yesterday }, { lateLeads: 0, workdayStartAt: tj("2026-11-20T15:00:00").toISOString(), now }).flag).toBeNull();
    // Начало дня — вчерашнее (снимок пролежал в кэше вкладки за полночь): ночью не тревожим.
    expect(agentStatus({ ...base, lastSeenAt: yesterday }, { lateLeads: 0, workdayStartAt: tj("2026-11-19T09:30:00").toISOString(), now: tj("2026-11-20T02:00:00") }).flag).toBeNull();
    // Выходной агента (общий, личный, праздник) — «не заходил» не тревога.
    expect(agentStatus({ ...base, lastSeenAt: yesterday, dayOffToday: true }, { lateLeads: 0, workdayStartAt: started, now }).flag).toBeNull();
    // Без часа начала дня (старый ответ сервера) — тоже молчим.
    expect(agentStatus({ ...base, lastSeenAt: yesterday }, { lateLeads: 0, now }).flag).toBeNull();
    // Дела за сегодня неизвестны (старый ответ сервера) — не обвиняем.
    expect(agentStatus({ activeLoad: 4, pendingAccept: 0, lastSeenAt: yesterday }, { lateLeads: 0, workdayStartAt: started, now }).flag).toBeNull();
    // Записал звонок с телефона, в CRM не заходил — работал.
    expect(agentStatus({ ...base, actionsToday: 3, lastSeenAt: yesterday }, { lateLeads: 0, workdayStartAt: started, now }).flag).toBeNull();
    expect(agentStatus({ ...base, lastSeenAt: yesterday, takesLeads: false }, { lateLeads: 0, workdayStartAt: started, now }).flag)
      .toEqual({ tone: "muted", text: "приём заявок на паузе" });
    expect(agentStatus({ ...base, lastSeenAt: tj("2026-11-20T09:40:00").toISOString(), overdueTasks: 3 }, { lateLeads: 0, workdayStartAt: started, now }))
      .toMatchObject({ seen: "заходил в 09:40", flag: { tone: "warn", text: "просрочено: 3 задачи" } });
    expect(agentStatus({ ...base, lastSeenAt: new Date(NOW - 5 * 60_000).toISOString() }, { lateLeads: 0, now }).seen).toBe("сейчас в CRM");
    expect(agentStatus({ ...base, lastSeenAt: null }, { lateLeads: 0, now }).seen).toBe("ещё не заходил в CRM");
  });
});

describe("плита денег и плитки директора", () => {
  it("сравнение с прошлым месяцем, ожидаемое по сделкам, заявки против вчера; плана нет — процента нет", () => {
    const { container } = wrap(<DirectorMoney role="DIRECTOR" />);
    const hero = container.querySelector('[data-hero="money"]')!;
    expect(hero.textContent).toContain("Комиссия за ноябрь");
    expect(hero.textContent).toContain("больше на 29%, чем за 1–20 октября до 14:00");
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

const agent = (id: string, fullName: string, over: Record<string, unknown> = {}) => ({
  id, fullName, avatarUrl: null, activeLoad: 1, pendingAccept: 0, acceptedToday: 0, buyerCount: 0, sellerCount: 0,
  lastSeenAt: tj("2026-11-20T13:58:00").toISOString(), callsToday: 0, actionsToday: 0, ...over,
});

describe("«Команда» руководителя", () => {
  it("тревоги сверху: не принял вовремя и не заходил; звонки сегодня и нагрузка в строке", () => {
    const yesterday = tj("2026-11-19T17:00:00").toISOString();
    h.mc = { ...h.mc, data: snapshot({
      workdayStartAt: tj("2026-11-20T09:30:00").toISOString(),
      agents: [
        agent("g1", "Бону Саидова", { activeLoad: 9, callsToday: 5, actionsToday: 5 }),
        agent("g2", "Далер Сафаров", { activeLoad: 2, lastSeenAt: yesterday }),
        agent("g3", "Мадина Каримова", { activeLoad: 5, pendingAccept: 1, overdueTasks: 2, lastSeenAt: tj("2026-11-20T09:40:00").toISOString() }),
      ],
    }) };
    h.live = { ...h.live, data: { agents: [{ id: "g3", fullName: "Мадина", avatarUrl: null, activeLoad: 5, pendingAccept: 1, acceptedToday: 0, escalated: 2 }], unaccepted: [], unacceptedTotal: 1, escalatedTotal: 2, queuedTotal: 0 } };
    const { container } = wrap(<LeaderTeam />);
    const rows = [...container.querySelectorAll(".ry-row")];
    expect(rows.map((r) => r.querySelector(".ry-row-title")?.textContent)).toEqual(["Мадина Каримова", "Далер Сафаров", "Бону Саидова"]);
    expect(rows[0].textContent).toContain("не принял вовремя: 2 заявки");
    // Плитка «Просрочки агентов» ведёт сюда — число видно и когда пометка справа о другом.
    expect(rows[0].textContent).toContain("просрочено задач 2");
    expect(rows[1].textContent).toContain("сегодня не заходил");
    expect(rows[2].textContent).toContain("сейчас в CRM · звонков 5 · в работе 9");
    expect(rows[2].querySelector(".ry-home-chip")).toBeNull();
  });

  it("«не заходил» — по делам агента из сервера, а не по обрезанному списку «Дня команды» (буква фамилии не важна)", () => {
    const yesterday = tj("2026-11-19T17:00:00").toISOString();
    // «День команды» отдаёт 12 строк по числу дел; Яхё с нулём дел и фамилией на «Я» в него не попал.
    const rows = Array.from({ length: 12 }, (_, i) => ({ agentId: `a${i}`, name: `Агент ${i}`, calls: 1, showings: 0, tasksDone: 0, messages: 0, total: 1 }));
    h.mc = { ...h.mc, data: snapshot({
      workdayStartAt: tj("2026-11-20T09:30:00").toISOString(),
      agents: [agent("z1", "Яхё Яхёев", { lastSeenAt: yesterday, actionsToday: 0, callsToday: 0 })],
      day: { reason: null, calls: 12, showings: 0, tasksDone: 0, messages: 0, rows },
    }) };
    const { container } = wrap(<LeaderTeam />);
    expect(container.querySelector(".ry-row")?.textContent).toContain("сегодня не заходил");
    expect(container.querySelector(".ry-row")?.textContent).toContain("звонков 0");
  });

  it("выходной агента — без тревоги «не заходил»", () => {
    h.mc = { ...h.mc, data: snapshot({
      workdayStartAt: tj("2026-11-20T09:30:00").toISOString(),
      agents: [agent("z1", "Яхё Яхёев", { lastSeenAt: tj("2026-11-19T17:00:00").toISOString(), dayOffToday: true })],
    }) };
    const { container } = wrap(<LeaderTeam />);
    expect(container.textContent).not.toContain("сегодня не заходил");
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
    const { container } = wrap(<RopTiles role="HEAD_OF_SALES" />);
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

describe("РОП: плитки только с источником и ссылки только туда, где та же цифра", () => {
  const ropData = () => {
    const data = snapshot({ commission: null, seesMoney: false, agents: [agent("g1", "Бону", { overdueTasks: 1 })] }) as Record<string, unknown>;
    return data;
  };
  beforeEach(() => {
    h.role = "HEAD_OF_SALES";
    h.perms = new Set(["dashboard.analytics", "team.viewFull"]);
    h.live = { ...h.live, data: { agents: [], unaccepted: [], unacceptedTotal: 0, escalatedTotal: 1, queuedTotal: 0 } };
  });

  it("модуль бота выключен — плитки «Ждут ответа» нет вовсе (а не «—»)", () => {
    const data = ropData();
    delete data.bot;
    h.mc = { ...h.mc, data };
    const { container } = wrap(<RopTiles role="HEAD_OF_SALES" />);
    expect(container.textContent).not.toContain("Ждут ответа");
    expect(container.textContent).not.toContain("—");
    expect(container.querySelectorAll(".ry-tile")).toHaveLength(3);
  });

  it("«Просрочки» и «Не приняли вовремя» ведут к «Команде сегодня», пока она на главной; выключена — без ссылки", () => {
    h.mc = { ...h.mc, data: ropData() };
    const shown = wrap(<RopTiles role="HEAD_OF_SALES" />);
    const link = (label: string) => [...shown.container.querySelectorAll(".ry-tile")].find((t) => t.textContent?.includes(label));
    expect(link("Не приняли вовремя")?.getAttribute("href")).toBe("#ry-leader-team");
    expect(link("Просрочки агентов")?.getAttribute("href")).toBe("#ry-leader-team");
    cleanup();
    h.hidden = new Set(["ropTeam"]);
    const hiddenTeam = wrap(<RopTiles role="HEAD_OF_SALES" />);
    for (const label of ["Не приняли вовремя", "Просрочки агентов"]) {
      const tile = [...hiddenTeam.container.querySelectorAll(".ry-tile")].find((t) => t.textContent?.includes(label));
      expect(tile?.tagName, label).toBe("DIV");
    }
    cleanup();
    h.hidden = new Set();
    h.perms = new Set(["dashboard.analytics"]);
    const noTeam = wrap(<RopTiles role="HEAD_OF_SALES" />);
    expect([...noTeam.container.querySelectorAll("a.ry-tile")].map((a) => a.getAttribute("href"))).not.toContain("#ry-leader-team");
  });

  it("нет пути в меню — нет ссылки у плитки", async () => {
    h.mc = { ...h.mc, data: ropData() };
    const nav = await import("../../../lib/navigation");
    const spy = vi.spyOn(nav, "useNavigation").mockReturnValue({ all: [] } as never);
    const { container } = wrap(<RopTiles role="HEAD_OF_SALES" />);
    for (const label of ["Ждут ответа", "Пропущенные звонки"]) {
      const tile = [...container.querySelectorAll(".ry-tile")].find((t) => t.textContent?.includes(label));
      expect(tile?.tagName, label).toBe("DIV");
    }
    spy.mockRestore();
  });
});

describe("акционер: деньги есть, действий нет", () => {
  it("главная акционера — плита денег, графики и вопрос помощнику; ни одной кнопки действия", () => {
    h.role = "SHAREHOLDER";
    h.perms = new Set(["dashboard.analytics", "finance.view", "team.viewFull"]);
    const { container } = wrap(<RoyalHomeCore role="SHAREHOLDER" registry={HOME_BLOCKS} layout={HOME_LAYOUT} />);
    expect(container.querySelector('[data-hero="money"]')).not.toBeNull();
    expect(container.querySelector('[data-block="decisions"]')).toBeNull();
    expect(container.querySelector('[data-block="managerTiles"]')).toBeNull();
    expect(container.textContent).not.toMatch(/Передать|Принять|Разобрать|Ждут ответа|Пропущенные/);
    expect(container.querySelectorAll("button")).toHaveLength(0);
  });
});

describe("раскладка ролей", () => {
  it("акционер — деньги и тренды без операционных блоков; РОП — свой набор", () => {
    const ids = (role: string) => homeBlocksFor(role, HOME_BLOCKS, HOME_LAYOUT).map((b) => b.id);
    expect(ids("SHAREHOLDER")).toEqual(["money", "commission", "pulse", "channels", "ask"]);
    expect(ids("HEAD_OF_SALES")).toEqual(["ropTiles", "agentFirstCalls", "ropTasks", "ropSpread", "ropTeam", "ropLosses", "teamCharts", "full"]);
    expect(ids("MANAGER")).not.toContain("money");
  });
});
