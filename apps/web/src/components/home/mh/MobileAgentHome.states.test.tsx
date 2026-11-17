import { beforeEach, describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import type { ReactNode } from "react";

/**
 * «Главная» агента на телефоне (17.11.2026, аудит F2-1): пока сводка грузится или
 * если она не загрузилась, экран НЕ говорит «на сегодня всё сделано», «Показов
 * на сегодня нет», «Все ваши клиенты на связи». Настоящий ноль — говорит.
 */
type Q = { data: unknown; isLoading: boolean; isError: boolean; error?: unknown; refetch: () => void };
const q = (over: Partial<Q>): Q => ({ data: undefined, isLoading: false, isError: false, refetch: () => {}, ...over });
const state = vi.hoisted(() => ({
  summary: null as unknown as Q,
  pending: null as unknown as Q,
  clients: null as unknown as Q,
}));

vi.mock("react-router-dom", async (importOriginal) => ({
  ...(await importOriginal<typeof import("react-router-dom")>()),
  useNavigate: () => () => {},
}));
vi.mock("../../../store/auth", () => ({
  useAuthStore: (select: (s: { agent: { fullName: string; role: string } }) => unknown) =>
    select({ agent: { fullName: "Агент Тестовый", role: "AGENT" } }),
}));
vi.mock("../../../hooks/useDashboard", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../../hooks/useDashboard")>()),
  useDashboardSummary: () => state.summary,
}));
vi.mock("../../../hooks/useClients", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../../hooks/useClients")>()),
  useClients: (params: { pendingAcceptance?: boolean }) => (params.pendingAcceptance ? state.pending : state.clients),
  useReactivationOffers: () => ({ data: [] }),
  useDuplicateReviews: () => ({ data: [] }),
}));
vi.mock("../../../hooks/useSettings", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../../hooks/useSettings")>()),
  useSettings: () => ({ data: { leadAcceptMinutes: 15 } }),
}));
vi.mock("../../../hooks/useCounters", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../../hooks/useCounters")>()),
  useCounters: () => ({ data: undefined }),
}));
vi.mock("../../../hooks/usePendingAccept", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../../hooks/usePendingAccept")>()),
  usePendingAcceptAlert: () => false,
}));
vi.mock("../../../lib/permissions", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../../lib/permissions")>()),
  useCan: () => () => false,
}));
vi.mock("./MhScreen", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./MhScreen")>()),
  MhScreen: ({ children }: { children: ReactNode }) => <div>{children}</div>,
}));

const { MobileAgentHome } = await import("./MobileAgentHome");

const EMPTY_SUMMARY = {
  tasksToday: [],
  firstCallDue: [],
  assignedBySupervisor: [],
  kpis: { commissionPlan: 0, commissionMonth: 0, commissionScope: "own" },
};
const ALL_DONE_TEXTS = ["на сегодня всё сделано", "Больше дел на сегодня нет", "Показов на сегодня нет", "Все ваши клиенты на связи"];

const render = () => renderToStaticMarkup(<MobileAgentHome />);

describe("MobileAgentHome: загрузка, отказ и настоящий ноль", () => {
  beforeEach(() => {
    state.summary = q({ data: EMPTY_SUMMARY });
    state.pending = q({ data: { items: [], total: 0 } });
    state.clients = q({ data: { items: [], total: 0 } });
  });

  it("настоящий ноль: говорит «всё сделано»", () => {
    const html = render();
    for (const text of ALL_DONE_TEXTS) expect(html).toContain(text);
  });

  it("сводка не загрузилась: ни одного «всё сделано», есть «Повторить»", () => {
    state.summary = q({ isError: true, error: new Error("Сеть пропала") });
    const html = render();
    for (const text of ALL_DONE_TEXTS.slice(0, 3)) expect(html).not.toContain(text);
    expect(html).toContain("сводка не загрузилась");
    expect(html).toContain("Повторить");
  });

  it("сводка ещё грузится: ни одного «всё сделано»", () => {
    state.summary = q({ isLoading: true });
    const html = render();
    for (const text of ALL_DONE_TEXTS.slice(0, 3)) expect(html).not.toContain(text);
    expect(html).toContain("загружаем дела на сегодня");
  });

  it("список клиентов не загрузился: не «все на связи», а ошибка с «Повторить»", () => {
    state.clients = q({ isError: true });
    const html = render();
    expect(html).not.toContain("Все ваши клиенты на связи");
    expect(html).toContain("Список клиентов не загрузился");
  });

  it("ждущие заявки не загрузились: секция не пропадает молча", () => {
    state.pending = q({ isError: true });
    const html = render();
    expect(html).toContain("Не загрузились новые заявки");
    // Зелёного «всё сделано» без знания о заявках быть не должно.
    expect(html).not.toContain('data-tone="ok"');
  });
});
