// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DirectorDashboardResponse } from "@royal-home/shared";
import type { DirectorFilters } from "../hooks/useDirectorDashboard";

/**
 * «АНАЛИТИКА» НА ГЛАВНОЙ (пачка home2, 27.11.2026) против прежнего дашборда: те же показатели и
 * те же кнопки Excel и Печать; шторка «Фильтры» даёт ровно тот же запрос сводки, что прежние три
 * списка (Менеджер, Источник, Клиенты); выбранные фильтры видны чипами и снимаются крестиком.
 */
const h = vi.hoisted(() => ({ calls: [] as DirectorFilters[], royal: false, mobile: false }));
vi.mock("../store/auth", async (importOriginal) => ({
  ...await importOriginal<typeof import("../store/auth")>(),
  useAuthStore: (select: (s: unknown) => unknown) => select({ agent: { id: "a1", fullName: "Фарход Назаров", role: "DIRECTOR" } }),
}));
vi.mock("../lib/permissions", async (importOriginal) => ({
  ...await importOriginal<typeof import("../lib/permissions")>(),
  useCan: () => () => true,
}));
vi.mock("../hooks/useRoyalLook", async (importOriginal) => ({
  ...await importOriginal<typeof import("../hooks/useRoyalLook")>(),
  useRoyalLook: () => h.royal,
}));
vi.mock("../hooks/useMobileUx", async (importOriginal) => ({
  ...await importOriginal<typeof import("../hooks/useMobileUx")>(),
  useMobileUx: () => h.mobile,
}));
vi.mock("../hooks/useAgents", async (importOriginal) => ({
  ...await importOriginal<typeof import("../hooks/useAgents")>(),
  useAgents: () => ({ data: [{ id: "ag1", fullName: "Мадина Каримова" }, { id: "ag2", fullName: "Далер Сафаров" }], isError: false }),
}));

const DATA: DirectorDashboardResponse = {
  period: { from: "2026-11-01T00:00:00Z", to: "2026-11-27T00:00:00Z", preset: "month" },
  prevPeriod: { from: "2026-10-01T00:00:00Z", to: "2026-11-01T00:00:00Z" },
  filters: { agentId: null, source: null, kind: null },
  seesMoney: true,
  kpis: [
    { key: "newLeads", label: "Новые заявки", value: 10, prev: 6, unit: "count", goodWhen: "up", drillKey: "newLeads" },
    { key: "noContact", label: "Без контакта", value: 4, prev: 1, unit: "count", goodWhen: "down", drillKey: "noContact" },
    { key: "revenue", label: "Выручка (комиссия)", value: 15510, prev: 0, unit: "tjs", goodWhen: "up", drillKey: "deals" },
  ],
  funnel: { method: "cohort", steps: [{ key: "leads", label: "Новые заявки", count: 10, conversionFromPrev: null, conversionFromFirst: 100 }] },
  lossReasons: [{ reason: "PRICE", label: "Не устроила цена", count: 3 }],
  speed: { medianMin: 12, avgMin: 40, answered: 8, noContactCount: 4, noContactDrillKey: "noContact", overdueTasks: 4, overdueDrillKey: "overdueTasks" },
  agents: [{ id: "ag1", name: "Мадина Каримова", isActive: true, leads: 3, contacted: 2, calls: 1, messages: 0, meetings: 0, showings: 0, deals: 0, commission: 0, conversion: 0, overdueTasks: 1, lastActivityAt: null }],
  sources: [{ source: "INSTAGRAM", label: "Instagram", leads: 2, deals: 0, commission: 0 }],
  plan: { commissionPlan: 60000, planIsDefault: false, fact: 15510, pct: 26, left: 44490, month: "2026-11" },
  updatedAt: "2026-11-27T11:20:00Z", cacheSeconds: 60,
};
vi.mock("../hooks/useDirectorDashboard", async (importOriginal) => ({
  ...await importOriginal<typeof import("../hooks/useDirectorDashboard")>(),
  useDirectorDashboard: (filters: DirectorFilters) => {
    h.calls.push(filters);
    return { data: DATA, isError: false, isLoading: false, fetchStatus: "idle", refetch: () => Promise.resolve() };
  },
}));

import { DirectorDashboard, DirectorDashboardBlock } from "./DirectorDashboard";
import { directorQueryString } from "../hooks/useDirectorDashboard";

const wrap = (node: React.ReactElement) => render(
  <QueryClientProvider client={new QueryClient()}><MemoryRouter>{node}</MemoryRouter></QueryClientProvider>,
);
/** Что дашборд показывает: плитки, разделы и кнопки действий. */
function inventory(root: HTMLElement) {
  return {
    kpis: [...root.querySelectorAll("[data-kpi]")].map((el) => el.getAttribute("data-kpi")),
    sections: [...root.querySelectorAll("section[id^='dd-']")].map((el) => el.id),
    actions: within(root).getAllByRole("button").map((b) => b.textContent?.trim()).filter((t) => t === "Excel" || t === "Печать"),
  };
}
const lastQuery = () => directorQueryString(h.calls[h.calls.length - 1]!);

beforeEach(() => {
  h.calls = [];
  h.mobile = false;
  // Шторка снимает блокировку прокрутки через window.scrollTo — в jsdom его нет.
  window.scrollTo = (() => {}) as typeof window.scrollTo;
});
afterEach(cleanup);

describe("«Аналитика» на главной против прежнего дашборда", () => {
  it("те же показатели, разделы и кнопки Excel и Печать", () => {
    h.royal = false;
    const old = wrap(<DirectorDashboard />);
    const before = inventory(old.getByTestId("director-dashboard"));
    cleanup();
    h.royal = true;
    const home = wrap(<DirectorDashboardBlock />);
    const root = home.getByTestId("director-dashboard");
    const after = inventory(root);
    expect(after).toEqual(before);
    expect(before.actions).toEqual(["Excel", "Печать"]);
    expect(before.kpis).toEqual(["newLeads", "noContact", "revenue"]);
    within(root).getByRole("heading", { name: "Аналитика", level: 2 });
    // Серых списков браузера на главной нет — их заменила кнопка «Фильтры».
    expect(root.querySelector("select")).toBeNull();
    within(root).getByRole("button", { name: /Фильтры/ });
    // Период — те же шесть вариантов.
    expect(within(root).getAllByRole("radio").map((r) => r.textContent)).toEqual(["День", "Неделя", "Месяц", "Квартал", "Год", "Свои даты"]);
  });

  it("телефон: ни одного списка браузера, сортировка менеджеров — шторкой, в карточке главные числа и «Ещё»", () => {
    h.mobile = true;
    h.royal = false;
    const old = wrap(<DirectorDashboard />);
    // Страница /director без нового вида — как была: список сортировки на месте.
    expect(old.getByTestId("director-dashboard").querySelectorAll("select").length).toBeGreaterThan(0);
    const oldCard = old.container.querySelector(".dd-agent-card") as HTMLElement;
    const oldStats = [...oldCard.querySelectorAll("dt")].map((d) => d.textContent);
    cleanup();
    h.royal = true;
    wrap(<DirectorDashboardBlock />);
    const root = screen.getByTestId("director-dashboard");
    expect(root.querySelector("select")).toBeNull();
    fireEvent.click(within(root).getByRole("button", { name: /Сортировка: Сделки/ }));
    const sheet = screen.getByRole("dialog");
    fireEvent.click(within(sheet).getByRole("radio", { name: "Заявки" }));
    fireEvent.click(within(sheet).getByRole("radio", { name: "По возрастанию" }));
    // Стрелки переходят по вариантам радиогруппы.
    fireEvent.keyDown(within(sheet).getByRole("radio", { name: "По возрастанию" }), { key: "ArrowLeft" });
    expect(within(sheet).getByRole("radio", { name: "По убыванию" }).getAttribute("aria-checked")).toBe("true");
    fireEvent.click(within(sheet).getByRole("button", { name: "Готово" }));
    within(root).getByRole("button", { name: /Сортировка: Заявки, по убыванию/ });
    // Карточка: заявки, сделки, комиссия (деньги видны), просрочено — и «Ещё», ничего не теряется.
    const card = root.querySelector(".dd-agent-card") as HTMLElement;
    expect([...card.querySelectorAll("dt")].map((d) => d.textContent)).toEqual(["Заявки", "Сделки", "Комиссия", "Просрочено"]);
    fireEvent.click(within(card).getByRole("button", { name: /Ещё 7 показателей/ }));
    expect([...card.querySelectorAll("dt")].map((d) => d.textContent).sort()).toEqual([...oldStats].sort());
  });

  it("шторка «Фильтры» даёт тот же запрос, что прежние списки", () => {
    h.royal = false;
    const old = wrap(<DirectorDashboard />);
    const selects = old.getByTestId("director-dashboard").querySelectorAll("select");
    fireEvent.change(selects[0]!, { target: { value: "ag2" } });
    fireEvent.change(selects[1]!, { target: { value: "INSTAGRAM" } });
    fireEvent.change(selects[2]!, { target: { value: "BUYER" } });
    const viaSelects = lastQuery();
    expect(viaSelects).toBe("preset=month&agentId=ag2&source=INSTAGRAM&kind=BUYER");
    cleanup();

    h.royal = true;
    h.calls = [];
    wrap(<DirectorDashboardBlock />);
    fireEvent.click(screen.getByRole("button", { name: /Фильтры/ }));
    const sheet = screen.getByRole("dialog");
    act(() => { fireEvent.click(within(sheet).getByRole("radio", { name: "Далер Сафаров" })); });
    act(() => { fireEvent.click(within(sheet).getByRole("radio", { name: "Instagram" })); });
    act(() => { fireEvent.click(within(sheet).getByRole("radio", { name: "Покупатели" })); });
    expect(lastQuery()).toBe(viaSelects);
    fireEvent.click(within(sheet).getByRole("button", { name: "Готово" }));
    // Выбранное — чипами; крестик снимает ровно свой фильтр.
    screen.getByText("Менеджер: Далер Сафаров");
    screen.getByText("Источник: Instagram");
    screen.getByText("Клиенты: Покупатели");
    fireEvent.click(screen.getByRole("button", { name: "Убрать фильтр «Источник: Instagram»" }));
    expect(lastQuery()).toBe("preset=month&agentId=ag2&kind=BUYER");
    expect(screen.queryByText("Источник: Instagram")).toBeNull();
  });
});
