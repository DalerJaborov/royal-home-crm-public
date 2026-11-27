// @vitest-environment jsdom
import { cleanup, render, screen, within } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DirectorDashboardResponse } from "@royal-home/shared";

/**
 * ГЛАВНАЯ РУКОВОДИТЕЛЯ «КАК В МАКЕТЕ» (пачка home2, 27.11.2026): настоящие блоки реестра на
 * подменённых запросах. Верхняя часть рисуется на пустых данных и при упавших запросах (ни один
 * блок не падает целиком), «Аналитика» стоит под ней всегда, порядок и выключатели — личные.
 */
const h = vi.hoisted(() => ({
  role: "DIRECTOR",
  perms: new Set<string>(["reports.view", "dashboard.analytics", "finance.view", "team.viewFull", "clients.viewAll", "settings.manage"]),
  mc: {} as Record<string, unknown>,
  live: {} as Record<string, unknown>,
  dd: {} as Record<string, unknown>,
  rows: [] as unknown[] | null,
  rowsError: false,
  apiFails: false,
  hidden: [] as string[],
  order: undefined as string[] | undefined,
}));
vi.mock("../../../store/auth", async (importOriginal) => ({
  ...await importOriginal<typeof import("../../../store/auth")>(),
  useAuthStore: (select: (s: unknown) => unknown) => select({ agent: { id: "a1", fullName: "Фарход Назаров", role: h.role } }),
}));
vi.mock("../../../lib/permissions", async (importOriginal) => ({
  ...await importOriginal<typeof import("../../../lib/permissions")>(),
  useCan: () => (p: string) => h.perms.has(p),
  useIsReadOnly: () => false,
  useCanCreateProperty: () => true,
}));
vi.mock("../../../lib/navigation", async (importOriginal) => ({
  ...await importOriginal<typeof import("../../../lib/navigation")>(),
  useNavigation: () => ({ all: ["/", "/clients", "/messages", "/calls", "/oversight", "/team", "/finance", "/deals", "/settings", "/calendar", "/properties"].map((to) => ({ to })) }),
}));
vi.mock("../../../lib/api", async (importOriginal) => ({
  ...await importOriginal<typeof import("../../../lib/api")>(),
  api: () => (h.apiFails ? Promise.reject(new Error("нет сети")) : Promise.resolve({ tasks: [] })),
}));
vi.mock("../../../hooks/useMissionControl", async (importOriginal) => ({
  ...await importOriginal<typeof import("../../../hooks/useMissionControl")>(),
  useMissionControl: () => h.mc,
  usePropertiesPendingReview: () => ({ data: h.apiFails ? undefined : [] }),
}));
vi.mock("../../../hooks/useTeamLive", async (importOriginal) => ({
  ...await importOriginal<typeof import("../../../hooks/useTeamLive")>(),
  useTeamLive: () => h.live,
}));
vi.mock("../../../hooks/useProperties", async (importOriginal) => ({
  ...await importOriginal<typeof import("../../../hooks/useProperties")>(),
  useProperties: () => ({ data: undefined }),
}));
vi.mock("../../../hooks/useDirectorDashboard", async (importOriginal) => ({
  ...await importOriginal<typeof import("../../../hooks/useDirectorDashboard")>(),
  useDirectorDashboard: () => h.dd,
}));
vi.mock("../../pult/PultActions", async (importOriginal) => ({
  ...await importOriginal<typeof import("../../pult/PultActions")>(),
  usePultActionRows: () => h.rows,
  usePultActionStatus: () => ({ isError: h.rowsError, isLoading: false }),
}));
vi.mock("../home/prefs", async (importOriginal) => ({
  ...await importOriginal<typeof import("../home/prefs")>(),
  useHomeLayoutPrefs: () => ({ order: h.order, hidden: new Set(h.hidden) }),
}));
vi.mock("../home/blocks/dashboardHome", () => ({ DashboardHomeBlock: () => <p>дашборд целиком</p> }));

import { RoyalRoleHome, LEADER_LAYOUT } from "../home/registry";

const refetch = () => Promise.resolve();
const ready = (data: unknown) => ({ data, isError: false, isLoading: false, fetchStatus: "idle", refetch });
const failed = () => ({ data: undefined, isError: true, isLoading: false, fetchStatus: "idle", refetch, error: new Error("500") });

/** Снимок пульта «всё по нулям»: пустая команда, тишина в чатах и в первой линии. */
const EMPTY_MC = {
  generatedAt: "2026-11-27T10:00:00Z", seesMoney: true, modulesOff: [],
  hero: {
    commission: { fact: 0, plan: 8000, forecastEndOfMonth: 0, forecastPercent: 0, planIsDefault: true, previousMonthToDate: null, previousMonthTotal: null, pipeline: null },
    profit: null, leadsToday: { count: 0, deltaVsYesterday: 0 }, firstResponse: { medianMinYesterday: null, noneCountYesterday: 0 },
    missedCallsToday: 0, dealsInPipeline: { count: 0, byStage: [], items: [], stuckTotal: 0 },
  },
  firstLine: { items: [], shownCount: 0, totalCount: 0 },
  team: { agents: [] },
  bot: { ai: { requestsToday: 0, errorsToday: 0, errorRatePercent: 0, costUsdToday: null, avgMs: 0 }, guardHitsToday: 0, outboundShieldToday: 0,
    attention: { silent: { reason: null, count: 0, items: [] }, waitingHuman: { reason: null, count: 0, items: [] }, liveCount: 0 } },
};
const EMPTY_DD: Partial<DirectorDashboardResponse> = { sources: [], lossReasons: [], kpis: [], agents: [] };

const renderHome = () => render(
  <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
    <MemoryRouter><RoyalRoleHome /></MemoryRouter>
  </QueryClientProvider>,
);
/** Блоки в порядке телефона: ячейки колонок идут по свойству order, «Аналитика» — последней. */
const blocks = (container: HTMLElement) => [...container.querySelectorAll<HTMLElement>("[data-block]")]
  .sort((a, b) => (a.style.order === "" ? 1e6 : Number(a.style.order)) - (b.style.order === "" ? 1e6 : Number(b.style.order)))
  .map((el) => el.getAttribute("data-block"));

beforeEach(() => {
  h.role = "DIRECTOR";
  h.mc = ready(EMPTY_MC);
  h.live = ready({ agents: [], unaccepted: [], unacceptedTotal: 0, escalatedTotal: 0, queuedTotal: 0 });
  h.dd = ready(EMPTY_DD);
  h.rows = [];
  h.rowsError = false;
  h.apiFails = false;
  h.hidden = [];
  h.order = undefined;
});
afterEach(cleanup);

describe("главная руководителя как в макете", () => {
  it.each(["DIRECTOR", "ADMIN", "HEAD_OF_SALES"])("%s: блоки макета сверху в порядке раскладки, ниже «Аналитика»", (role) => {
    h.role = role;
    const { container } = renderHome();
    expect(blocks(container)).toEqual([...LEADER_LAYOUT[role], "analytics"]);
    // Колонки ПК: решения у РОП справа, у директора слева (как LAYOUT макета).
    const col = (id: string) => container.querySelector(`[data-block="${id}"]`)!.closest("[data-col]")!.getAttribute("data-col");
    expect(col("decisions")).toBe(role === "HEAD_OF_SALES" ? "b" : "a");
    expect(col("tiles")).toBe("b");
    screen.getByText("дашборд целиком");
    // Старой полосы и прежней главной директора здесь нет.
    expect(container.querySelector('[data-block="attention"], [data-block="money"], [data-hero="money"]')).toBeNull();
  });

  it("пустые данные: каждый блок рисуется спокойно, без падения и без выдуманных чисел", () => {
    const { container } = renderHome();
    expect(container.querySelector(".ry-block-failed")).toBeNull();
    const plate = container.querySelector('[data-block-body="plate"]') as HTMLElement;
    expect(plate).not.toBeNull();
    expect(plate.textContent).toContain("0");
    // План не задан (умолчание) — процента нет, вместо него ссылка задать план.
    expect(plate.textContent).not.toMatch(/\d+%/);
    within(plate).getByRole("link", { name: /План/ });
    const tiles = container.querySelector('[data-block-body="tiles"]') as HTMLElement;
    within(tiles).getByText("Ждут ответа");
    within(tiles).getByText("Горит");
    // Нулевые «пропущенные» и «ждут принятия» строками не ставятся.
    expect(tiles.textContent).not.toContain("Пропущенные звонки");
    screen.getByText("Решений нет");
    screen.getByText("Всё спокойно");
    screen.getByText("За месяц заявок нет");
    screen.getByText("Потеряно");
    // Скорости нет — нет медианы: блока нет, а не «0 мин».
    expect(container.querySelector('[data-block-body="speed"]')).toBeNull();
    expect(screen.queryByText("Не загрузилось")).toBeNull();
  });

  it("упавшие запросы: блоки показывают «Не загрузилось», главная и «Аналитика» живы", () => {
    h.mc = failed();
    h.live = failed();
    h.dd = failed();
    h.rows = null;
    h.rowsError = true;
    h.apiFails = true;
    const { container } = renderHome();
    expect(container.querySelector(".ry-block-failed")).toBeNull();
    expect(screen.getAllByText("Не загрузилось").length).toBeGreaterThan(1);
    screen.getByText("дашборд целиком");
    for (const role of ["ADMIN", "HEAD_OF_SALES"]) {
      cleanup();
      h.role = role;
      const again = renderHome();
      expect(again.container.querySelector(".ry-block-failed")).toBeNull();
      screen.getByText("дашборд целиком");
    }
  });

  it("числа есть: плита, плитки, строки срочного, шкала скорости и столбики — из ответа сервера", () => {
    h.mc = ready({
      ...EMPTY_MC,
      hero: {
        ...EMPTY_MC.hero,
        commission: { fact: 48200, plan: 60000, forecastEndOfMonth: 0, forecastPercent: 0, planIsDefault: false, previousMonthToDate: 40000, previousMonthTotal: 70000, pipeline: { deals: 3, expectedTjs: 21000 } },
        firstResponse: { medianMinYesterday: 13, noneCountYesterday: 2 }, missedCallsToday: 3,
        dealsInPipeline: { count: 9, byStage: [], items: [], stuckTotal: 2 },
      },
      firstLine: { items: [{ id: "f1", severity: "critical", text: "Клиент ждёт 2 ч", href: "/messages" }], shownCount: 1, totalCount: 5 },
      bot: { ...EMPTY_MC.bot, attention: { ...EMPTY_MC.bot.attention, waitingHuman: { reason: null, count: 4, items: [{ id: "d", kind: "BOT", channel: "IG", title: "x", clientId: null, lastMessageAt: "", waitingMinutes: 40 }] } } },
    });
    h.live = ready({ agents: [], unaccepted: [], unacceptedTotal: 2, escalatedTotal: 1, queuedTotal: 0 });
    h.dd = ready({ ...EMPTY_DD, sources: [
      { source: "INSTAGRAM", label: "Instagram", leads: 21, deals: 1, commission: null },
      { source: "WEBSITE", label: "Сайт", leads: 14, deals: 0, commission: null },
      { source: "WHATSAPP", label: "WhatsApp", leads: 9, deals: 0, commission: null },
      { source: "PHONE", label: "Звонки", leads: 7, deals: 0, commission: null },
      { source: "OFFICE", label: "Офис", leads: 2, deals: 0, commission: null },
    ], lossReasons: [{ reason: "PRICE", label: "Цена", count: 7 }] });
    const { container } = renderHome();
    const plate = container.querySelector('[data-block-body="plate"]') as HTMLElement;
    expect(plate.textContent).toMatch(/48\s200/);
    expect(plate.textContent).toContain("80%");
    expect(plate.textContent).toContain("в сделках");
    expect(plate.textContent).toContain("не связывались");
    const tiles = container.querySelector('[data-block-body="tiles"]') as HTMLElement;
    expect(tiles.textContent).toContain("4");
    expect(tiles.textContent).toContain("дольше всех 40 мин");
    expect(tiles.textContent).toContain("Пропущенные звонки");
    expect(tiles.textContent).toContain("время вышло: 1");
    const speed = container.querySelector('[data-block-body="speed"]') as HTMLElement;
    expect(speed.textContent).toContain("13");
    expect(speed.textContent).toContain("быстрее часа");
    expect(speed.textContent).toContain("без ответа 2");
    const sources = container.querySelector('[data-block-body="sources"]') as HTMLElement;
    expect(within(sources).getByRole("img").getAttribute("aria-label")).toBe("Instagram: 21, Сайт: 14, WhatsApp: 9, Звонки: 7");
    // Пятый источник не пропал: строкой «Другие источники».
    expect(sources.textContent).toContain("Другие источники");
    expect(sources.textContent).toContain("7");
  });

  it("личные выключатели и порядок «Оформления» действуют на верхнюю часть, «Аналитика» остаётся", () => {
    h.hidden = ["quick", "crew"];
    h.order = ["sources", "plate"];
    const { container } = renderHome();
    const ids = blocks(container);
    expect(ids).not.toContain("quick");
    expect(ids).not.toContain("crew");
    expect(ids[ids.length - 1]).toBe("analytics");
    // Порядок телефона — свойство order ячеек: «Заявки» первыми.
    const order = (id: string) => Number((container.querySelector(`[data-block="${id}"]`) as HTMLElement).style.order);
    expect(order("sources")).toBeLessThan(order("plate"));
  });

  it("руководитель без права на отчёты — прежняя главная, без блоков макета и без «Аналитики»", () => {
    h.perms.delete("reports.view");
    const { container } = renderHome();
    expect(container.querySelector('[data-testid="leader-home"]')).toBeNull();
    expect(blocks(container)).toContain("money");
    h.perms.add("reports.view");
  });
});
