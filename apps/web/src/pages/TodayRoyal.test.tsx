import { renderToString } from "react-dom/server";
import { MemoryRouter } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
  role: "ADMIN",
  mc: { data: undefined as unknown, isLoading: false, isError: false },
  rows: null as unknown,
  status: { isLoading: false, isError: false },
  analytics: true,
}));
vi.mock("../store/auth", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../store/auth")>();
  return { ...actual, useAuthStore: (select: (s: unknown) => unknown) => select({ agent: { id: "a1", fullName: "Далер Тестов", role: state.role } }) };
});
vi.mock("../lib/permissions", async (importOriginal) => ({ ...await importOriginal<typeof import("../lib/permissions")>(), useCan: () => (permission: string) => permission !== "dashboard.analytics" || state.analytics }));
vi.mock("../lib/navigation", async (importOriginal) => ({
  ...await importOriginal<typeof import("../lib/navigation")>(),
  useNavigation: () => ({ all: ["/", "/clients", "/messages", "/finance", "/team", "/calls", "/oversight", "/sources", "/calendar", "/properties", "/archive", "/health"].map((to) => ({ to, label: to })) }),
}));
vi.mock("../hooks/useMissionControl", async (importOriginal) => ({
  ...await importOriginal<typeof import("../hooks/useMissionControl")>(),
  useMissionControl: () => ({ ...state.mc, refetch: vi.fn() }),
  usePropertiesPendingReview: () => ({ data: [] }),
}));
vi.mock("../hooks/useProperties", async (importOriginal) => ({ ...await importOriginal<typeof import("../hooks/useProperties")>(), useProperties: () => ({ data: undefined }) }));
vi.mock("../components/pult/PultActions", async (importOriginal) => ({ ...await importOriginal<typeof import("../components/pult/PultActions")>(), usePultActionRows: () => state.rows, usePultActionStatus: () => state.status }));
vi.mock("../hooks/useTeamLive", async (importOriginal) => ({ ...await importOriginal<typeof import("../hooks/useTeamLive")>(), useTeamLive: () => ({ data: undefined, isPending: true, isError: false }) }));
vi.mock("../hooks/useDashboard", async (importOriginal) => ({ ...await importOriginal<typeof import("../hooks/useDashboard")>(), useDashboardSummary: () => ({ data: undefined, isPending: false, isError: false }) }));
vi.mock("../hooks/useClients", async (importOriginal) => ({ ...await importOriginal<typeof import("../hooks/useClients")>(), useClients: () => ({ data: { items: [], total: 0 }, isPending: false, isError: false }) }));

import { TodayRoyal } from "./TodayRoyal";
import { channelBrand, greetingFor, monthPace } from "../components/look/home/time";

const render = () => renderToString(
  <QueryClientProvider client={new QueryClient()}><MemoryRouter><TodayRoyal /></MemoryRouter></QueryClientProvider>,
);
const emptySnapshot = { generatedAt: "2026-11-18T00:00:00Z", seesMoney: true, modulesOff: [], hero: {
  commission: { fact: 0, plan: 0, forecastEndOfMonth: 0, forecastPercent: 0, planIsDefault: true }, profit: null,
  leadsToday: { count: 0, deltaVsYesterday: 0 }, firstResponse: { medianMinYesterday: null, noneCountYesterday: 0 },
  missedCallsToday: 0, dealsInPipeline: { count: 0, byStage: [] },
}, firstLine: { items: [], shownCount: 0, totalCount: 0 }, team: { agents: [] }, marketing: { instagramCommentsWaiting: 0, funnel: [], funnelMonth: "2026-11" } };

beforeEach(() => {
  state.role = "ADMIN";
  state.mc = { data: undefined, isLoading: true, isError: false };
  state.rows = null;
  state.status = { isLoading: false, isError: false };
  state.analytics = true;
});

describe("«Сегодня» в новом виде", () => {
  it("рисуется при загрузке и при пустых данных без падения и без выдуманных чисел", () => {
    expect(render()).toContain("Далер");
    state.mc = { data: emptySnapshot, isLoading: false, isError: false };
    state.rows = [];
    const html = render();
    expect(html).toContain("Нужно ваше решение");
    expect(html).toContain("Всё спокойно");
    // План не задан — процента плана нет; выключенные/пустые блоки не рисуются.
    expect(html).not.toContain("плана");
    expect(html).not.toContain("Заявки за месяц");
    expect(html).not.toContain(">Команда<");
  });

  it("показывает ошибку коротко и безлично", () => {
    state.mc = { data: undefined, isLoading: false, isError: true };
    const html = render();
    expect(html).toContain("Не загрузилось");
    expect(html).not.toMatch(/показываю|отправлю/i);
  });

  it("РОП и агент получают свои экраны на пустых данных", () => {
    state.role = "HEAD_OF_SALES";
    expect(render()).toContain("Мои задачи");
    state.role = "AGENT";
    const agent = render();
    expect(agent).toContain("Новых заявок нет");
    expect(agent).toContain("Ждут принятия");
  });

  it("правила приветствия, темпа и каналов", () => {
    expect(greetingFor(8)).toBe("Доброе утро");
    expect(greetingFor(13)).toBe("Добрый день");
    expect(greetingFor(20)).toBe("Добрый вечер");
    expect(greetingFor(2)).toBe("Доброй ночи");
    expect(monthPace("2026-11-15")).toBeCloseTo(0.5);
    expect(channelBrand("WHATSAPP")).toBe("whatsapp");
    expect(channelBrand("instagram_dm")).toBe("instagram");
    expect(channelBrand("unknown")).toBeNull();
  });

  it("упавший запрос очереди решений — «Не загрузилось», а не «Решений нет»", () => {
    state.mc = { data: emptySnapshot, isLoading: false, isError: false };
    state.rows = [];
    state.status = { isLoading: false, isError: true };
    const html = render();
    expect(html).toContain("Не загрузилось");
    expect(html).toContain("Повторить");
    expect(html).not.toContain("Решений нет");
  });

  it("админ без права на аналитику видит прежний текст", () => {
    state.analytics = false;
    expect(render()).toContain("Раздел доступен только руководству.");
  });

  it("подпись графика комиссии для чтеца — целые сомони, без копеек (ревью PR 326)", () => {
    state.mc = { data: { ...emptySnapshot, commission12: { reason: null, months: [{ month: "2026-10", amountTjs: 999.4, deals: 1 }, { month: "2026-11", amountTjs: 1234.6, deals: 2 }], totalTjs: 2234, bestMonth: null, expensesMonthTjs: 0 } }, isLoading: false, isError: false };
    state.rows = [];
    const html = render();
    expect(html).toContain("Комиссия по месяцам");
    expect(html).toContain(`Ноябрь 2026 ${(1235).toLocaleString("ru-RU")}`);
    expect(html).toMatch(/Октябрь 2026 999[,\s]/);
    expect(html).not.toMatch(/234,6|999,4/);
  });
});
