// @vitest-environment jsdom
/**
 * Главная не падает целиком из-за одного блока (20.11.2026).
 *
 * Случай 18.11, 10:04 UTC: телефон владельца держал сборку до #220, она рисовала
 * плитку «На лимите нагрузки» (`control.atLimit`), которой сервер уже не отдавал,
 * — `undefined is not an object (evaluating 't.count')`, и вся главная ушла в
 * «Что-то пошло не так». Здесь проверяется весь класс: ответ сервера без ЛЮБОГО
 * поля роняет не больше одного блока, остальная главная остаётся на месте — и в
 * новом виде («Сегодня»), и в прежнем (пульт).
 */
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
  role: "ADMIN",
  mc: { data: undefined as unknown, isLoading: false, isError: false },
  /** Ответы сервера для экрана РОП (`api(path)`). */
  api: {} as Record<string, unknown>,
  /** Заявки, ждущие принятия, — экран агента. */
  pendingClients: [] as unknown[],
}));

vi.mock("../store/auth", async (importOriginal) => ({
  ...await importOriginal<typeof import("../store/auth")>(),
  useAuthStore: (select: (s: unknown) => unknown) => select({ agent: { id: "a1", fullName: "Далер Тестов", role: state.role } }),
}));
vi.mock("../lib/permissions", async (importOriginal) => ({
  ...await importOriginal<typeof import("../lib/permissions")>(),
  useCan: () => () => true,
  useCanCreateProperty: () => true,
}));
vi.mock("../lib/navigation", async (importOriginal) => ({
  ...await importOriginal<typeof import("../lib/navigation")>(),
  useNavigation: () => ({ all: ["/", "/clients", "/messages", "/finance", "/team", "/calls", "/oversight", "/sources", "/calendar", "/properties", "/archive", "/health", "/deals", "/reports", "/insights", "/notifications"].map((to) => ({ to, label: to })) }),
}));
vi.mock("../hooks/useMissionControl", async (importOriginal) => ({
  ...await importOriginal<typeof import("../hooks/useMissionControl")>(),
  useMissionControl: () => ({ ...state.mc, refetch: vi.fn(), refetchSection: vi.fn() }),
  usePropertiesPendingReview: () => ({ data: [], isLoading: false, isError: false }),
}));
vi.mock("../hooks/useProperties", async (importOriginal) => ({
  ...await importOriginal<typeof import("../hooks/useProperties")>(),
  useProperties: () => ({ data: { items: [] }, isLoading: false, isError: false }),
  useProperty: () => ({ data: undefined, isLoading: false }),
}));
vi.mock("../components/pult/PultActions", async (importOriginal) => ({
  ...await importOriginal<typeof import("../components/pult/PultActions")>(),
  usePultActionRows: () => [],
  usePultActionStatus: () => ({ isLoading: false, isError: false }),
}));
vi.mock("../lib/api", async (importOriginal) => ({
  ...await importOriginal<typeof import("../lib/api")>(),
  api: async (path: string) => {
    if (path in state.api) return state.api[path];
    throw new Error(`нет ответа для ${path}`);
  },
}));
vi.mock("../hooks/useTeamLive", async (importOriginal) => ({
  ...await importOriginal<typeof import("../hooks/useTeamLive")>(),
  useTeamLive: () => ({ data: { agents: [{ id: "ag1", fullName: "Ноза Агентова", avatarUrl: null, activeLoad: 5, pendingAccept: 1 }] }, isPending: false, isError: false, refetch: vi.fn() }),
}));
vi.mock("../hooks/useDashboard", async (importOriginal) => ({
  ...await importOriginal<typeof import("../hooks/useDashboard")>(),
  useDashboardSummary: () => ({ data: { tasksToday: [] }, isPending: false, isError: false, refetch: vi.fn() }),
}));
vi.mock("../hooks/useClients", async (importOriginal) => ({
  ...await importOriginal<typeof import("../hooks/useClients")>(),
  useClients: () => ({ data: { items: state.pendingClients, total: state.pendingClients.length }, isPending: false, isError: false, refetch: vi.fn() }),
}));
// Блоки со своими запросами к серверу — к проверяемому классу не относятся.
vi.mock("../components/clean/CleanPultInbox", async (importOriginal) => ({ ...await importOriginal<typeof import("../components/clean/CleanPultInbox")>(), CleanPultInbox: () => null }));
vi.mock("../components/clean/CleanReminderActions", async (importOriginal) => ({ ...await importOriginal<typeof import("../components/clean/CleanReminderActions")>(), CleanCallbackRows: () => null }));
vi.mock("../components/clean/CleanDirectorAi", async (importOriginal) => ({ ...await importOriginal<typeof import("../components/clean/CleanDirectorAi")>(), CleanDirectorAi: () => null }));
vi.mock("../components/clean/CleanPultExtras", async (importOriginal) => ({ ...await importOriginal<typeof import("../components/clean/CleanPultExtras")>(), CleanPultExtras: () => null }));
vi.mock("../components/clean/CleanCommissionChartLazy", async (importOriginal) => ({ ...await importOriginal<typeof import("../components/clean/CleanCommissionChartLazy")>(), CleanCommissionChartLazy: () => null }));

import { TodayRoyal } from "./TodayRoyal";
import { PultClean } from "./PultClean";

const NOW = "2026-11-18T10:00:00Z";

/** Что граница отправила в журнал (ErrorBoundary шлёт ErrorEvent в window). */
const journal: string[] = [];
function captureJournal(event: ErrorEvent) {
  journal.push(event.message);
  // В браузере событие уходит в errorReporter; здесь гасим, иначе jsdom считает его непойманным.
  event.preventDefault();
  event.stopImmediatePropagation();
}
const zone = (count: number) => ({ count, items: [], reason: null });

/** Полный снимок /mission-control: каждый блок главной получает свои данные. */
function fullSnapshot() {
  return {
    generatedAt: NOW, seesMoney: true, modulesOff: [],
    hero: {
      commission: { fact: 12000, plan: 30000, forecastEndOfMonth: 25000, forecastPercent: 83, planIsDefault: false },
      profit: { todayTjs: 500, previousTodayTjs: 300 },
      leadsToday: { count: 7, deltaVsYesterday: 2 },
      firstResponse: { medianMinYesterday: 6, noneCountYesterday: 0 },
      missedCallsToday: 2,
      dealsInPipeline: { count: 4, byStage: [{ status: "NEW", count: 4 }] },
    },
    firstLine: { items: [{ id: "f1", severity: "critical", text: "Клиент ждёт ответа", href: "/clients/1" }], shownCount: 1, totalCount: 1 },
    team: {
      agents: [{ id: "ag1", fullName: "Ноза Агентова", avatarUrl: null, activeLoad: 5, pendingAccept: 1, acceptedToday: 0, buyerCount: 3, sellerCount: 2, lastSeenAt: NOW }],
      day: { rows: [{ agentId: "ag1", name: "Ноза", calls: 3, showings: 1, tasksDone: 2, messages: 4, total: 10 }], calls: 3, showings: 1, tasksDone: 2, messages: 4, reason: null },
      showingsToday: { count: 1, confirmed: 0, reason: null, items: [{ id: "s1", at: NOW, clientName: "Фарход", clientHref: "/clients/2", propertyTitle: "Квартира", agentName: "Ноза", confirmed: false }] },
    },
    system: {
      crons: [{ name: "backup", lastRunAt: NOW, lastOkAt: NOW, lastError: null, healthy: true }],
      jobsRunning: 0, jobsGivenUp: 0, jobsGivenUpLast24h: 0, newApplications: 1, errorsToday: 1, unresolvedTotal: 2,
      control: {
        phones: { total: 1, online: 1, items: [], reason: null },
        overdueTasks: { count: 3, items: [], reason: null },
        silentAfterShowing: { count: 1, reason: null },
      },
    },
    bot: {
      ai: { requestsToday: 10, errorsToday: 0, errorRatePercent: 0, costUsdToday: 0.1, avgMs: 900 },
      guardHitsToday: 0, outboundShieldToday: 0, unresolvedFindings: 0,
      attention: { silent: zone(0), waitingHuman: zone(2), liveCount: 1 },
    },
    marketing: {
      instagramCommentsWaiting: 0, funnelMonth: "2026-11",
      funnel: [{ source: "whatsapp", label: "WhatsApp", leadsMonth: 12, showingsMonth: 3, dealsClosedMonth: 1, spendMonthTjs: null, commissionMonthTjs: null, costPerLeadTjs: null, leadsToday: 1, leadsTrailing7Avg: 1, anomalyLeadsDown: false }],
      pulse30: { reason: null, leadsTotal: 7, showingsTotal: 2, days: [{ date: "2026-11-17", leads: 3, showings: 1 }, { date: "2026-11-18", leads: 4, showings: 1 }] },
    },
    clientsZone: {
      attentionClient: { id: null, reason: "Все клиенты на связи." },
      returned: { count: 0, items: [], reason: null },
      deleteRequests: { total: 1, clients: 1, items: [] },
    },
    commission12: { totalTjs: 50000, months: [{ month: "2026-10", amountTjs: 20000 }, { month: "2026-11", amountTjs: 30000 }] },
    properties: { available: 69, newThisWeek: 2, reserved: 1, portfolioValueTjs: null },
  };
}

type Snapshot = ReturnType<typeof fullSnapshot>;

/** Каждый вариант ответа «сервер не прислал одно поле» — на первом и втором уровне секции. */
function droppedFieldVariants(): { label: string; data: Snapshot }[] {
  const base = fullSnapshot() as unknown as Record<string, Record<string, unknown>>;
  const out: { label: string; data: Snapshot }[] = [];
  for (const [section, value] of Object.entries(base)) {
    if (!value || typeof value !== "object" || Array.isArray(value)) continue;
    for (const [field, inner] of Object.entries(value)) {
      const drop = structuredClone(base);
      delete drop[section][field];
      out.push({ label: `${section}.${field}`, data: drop as unknown as Snapshot });
      if (!inner || typeof inner !== "object" || Array.isArray(inner)) continue;
      for (const leaf of Object.keys(inner)) {
        const deep = structuredClone(base);
        delete (deep[section][field] as Record<string, unknown>)[leaf];
        out.push({ label: `${section}.${field}.${leaf}`, data: deep as unknown as Snapshot });
      }
    }
  }
  return out;
}

function renderPage(page: "today" | "pult") {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const tree = () => (
    <QueryClientProvider client={client}>
      <MemoryRouter>{page === "today" ? <TodayRoyal /> : <PultClean />}</MemoryRouter>
    </QueryClientProvider>
  );
  const view = render(tree());
  return { ...view, redraw: () => view.rerender(tree()) };
}

beforeEach(() => {
  journal.length = 0;
  state.role = "ADMIN";
  state.api = {};
  state.pendingClients = [];
  window.addEventListener("error", captureJournal, true);
  state.mc = { data: fullSnapshot(), isLoading: false, isError: false };
  // Границы честно пишут пойманную ошибку в консоль — в этом тесте это шум.
  vi.spyOn(console, "error").mockImplementation(() => undefined);
});
afterEach(() => {
  window.removeEventListener("error", captureJournal, true);
  cleanup();
  vi.restoreAllMocks();
});

describe("главная: один блок без данных не роняет экран", () => {
  it("полный снимок рисуется без единой заглушки «Не загрузилось»", () => {
    renderPage("today");
    expect(screen.queryByText("Не загрузилось")).toBeNull();
    expect(screen.getByText("Нужно ваше решение")).toBeTruthy();
    cleanup();
    renderPage("pult");
    expect(screen.queryByText(/Не загрузилось/)).toBeNull();
    expect(screen.getByLabelText("Контроль руководителя")).toBeTruthy();
  });

  it("случай 18.11: плитка «Контроля» без своих данных не рисуется, пульт живёт", () => {
    const data = fullSnapshot() as unknown as { system: { control: Record<string, unknown> } };
    delete data.system.control.silentAfterShowing;
    state.mc = { data, isLoading: false, isError: false };
    renderPage("pult");
    expect(screen.getByText("Просроченные задачи")).toBeTruthy();
    expect(screen.queryByText("Без ответа после показа")).toBeNull();
    expect(screen.getByText("Сегодня в Royal Home")).toBeTruthy();
    expect(screen.queryByText(/Не загрузилось/)).toBeNull();
  });

  it("новый вид: упал блок денег — «Не загрузилось» и «Повторить» только в нём, «Повторить» возвращает блок", async () => {
    const broken = fullSnapshot() as unknown as { hero: Record<string, unknown> };
    delete broken.hero.dealsInPipeline;
    state.mc = { data: broken, isLoading: false, isError: false };
    const view = renderPage("today");
    expect(screen.getAllByText("Не загрузилось")).toHaveLength(1);
    expect(screen.getByText("Нужно ваше решение")).toBeTruthy();
    expect(screen.getByText("Горит сейчас")).toBeTruthy();
    expect(screen.getByText("Далер", { exact: false })).toBeTruthy();
    // Ошибка ушла в журнал с именем блока.
    expect(journal.some((message) => message.startsWith("[блок today.money]"))).toBe(true);

    // Свежий ответ сервера пришёл (экран перерисован), блок ждёт «Повторить».
    state.mc = { data: fullSnapshot(), isLoading: false, isError: false };
    view.redraw();
    expect(screen.getAllByText("Не загрузилось")).toHaveLength(1);
    fireEvent.click(screen.getByRole("button", { name: "Повторить" }));
    await waitFor(() => expect(screen.queryByText("Не загрузилось")).toBeNull());
    expect(screen.getByText(/Комиссия/)).toBeTruthy();
  });

  it("прежний вид: упал блок показателей — остальной пульт на месте", () => {
    const broken = fullSnapshot() as unknown as { hero: Record<string, unknown> };
    delete broken.hero.leadsToday;
    state.mc = { data: broken, isLoading: false, isError: false };
    renderPage("pult");
    expect(screen.getByLabelText("Показатели дня").textContent).toContain("Не загрузилось");
    expect(screen.getAllByRole("button", { name: "Повторить" }).length).toBeGreaterThan(0);
    expect(screen.getByText("Нужны ваши решения")).toBeTruthy();
    expect(screen.getByText("Напоминания")).toBeTruthy();
    expect(screen.getByText("Просроченные задачи")).toBeTruthy();
  });

  // Сторож класса: КАЖДОЕ выпавшее поле ответа. Падение страницы целиком здесь —
  // это `render` с исключением; заглушка в одном блоке — допустимый исход.
  const variants = droppedFieldVariants();
  it(`ответ без любого из ${variants.length} полей не роняет ни «Сегодня», ни пульт`, () => {
    expect(variants.length).toBeGreaterThan(60);
    const crashed: string[] = [];
    for (const variant of variants) {
      state.mc = { data: variant.data, isLoading: false, isError: false };
      for (const page of ["today", "pult"] as const) {
        try {
          renderPage(page);
          const anchor = page === "today" ? screen.queryByText("Далер", { exact: false }) : screen.queryByText("Сегодня в Royal Home");
          if (!anchor) crashed.push(`${page}: ${variant.label} (нет заголовка)`);
        } catch (error) {
          crashed.push(`${page}: ${variant.label} — ${(error as Error).message}`);
        } finally {
          cleanup();
        }
      }
    }
    expect(crashed).toEqual([]);
  }, 120_000);

  it("РОП: упал блок «Где теряем клиентов» — остальной экран РОП на месте", async () => {
    state.role = "HEAD_OF_SALES";
    state.api = {
      "/dashboard/sales-control": { tasks: [{ id: "t1", clientName: "Фарход", clientShortId: 2, responseAction: "ACTION", dueAt: null, title: "Позвонить" }] },
      // Сервер прислал раздел без списка метрик — блок читает `metrics.length`.
      "/reports/problems?period=week": [{ id: "r1", metrics: { sections: [{ key: "clients", metrics: null }] } }],
    };
    renderPage("today");
    await waitFor(() => expect(screen.getByText("Фарход")).toBeTruthy());
    await waitFor(() => expect(journal.some((m) => m.startsWith("[блок today.ropLosses]"))).toBe(true));
    expect(screen.getAllByText("Не загрузилось")).toHaveLength(1);
    expect(screen.getByText("Требуют ответа")).toBeTruthy();
    expect(screen.getByText("Ноза Агентова")).toBeTruthy();
  });

  it("агент: битая заявка роняет только блок «Ждут принятия», показы и плитки на месте", () => {
    state.role = "AGENT";
    state.pendingClients = [null];
    renderPage("today");
    expect(journal.some((m) => m.startsWith("[блок today.agentPending]"))).toBe(true);
    expect(screen.getAllByText("Не загрузилось")).toHaveLength(1);
    expect(screen.getByText("Показов нет")).toBeTruthy();
    expect(screen.getByText("Дела сегодня")).toBeTruthy();
  });
});
