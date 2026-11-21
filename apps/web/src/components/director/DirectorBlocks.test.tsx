// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { DirectorDashboardResponse } from "@royal-home/shared";
import { AgentsBlock, DirectorBlocks, KpiTile, kpiTileVariant } from "./DirectorBlocks";
import { blockOrder } from "../../lib/directorFormat";

/** Блоки дашборда директора на подменённом ответе: сравнение, цвет по смыслу, деньги, сортировка, порядок по ролям. */
afterEach(cleanup);

const kpi = (over: Partial<DirectorDashboardResponse["kpis"][number]>): DirectorDashboardResponse["kpis"][number] =>
  ({ key: "newLeads", label: "Новые заявки", value: 10, prev: 6, unit: "count", goodWhen: "up", drillKey: "newLeads", ...over });

function data(seesMoney: boolean): DirectorDashboardResponse {
  const m = (n: number) => (seesMoney ? n : null);
  return {
    period: { from: "2026-11-01T00:00:00Z", to: "2026-11-21T00:00:00Z", preset: "month" },
    prevPeriod: { from: "2026-10-01T00:00:00Z", to: "2026-11-01T00:00:00Z" },
    filters: { agentId: null, source: null, kind: null },
    seesMoney,
    kpis: [kpi({}), kpi({ key: "revenue", label: "Выручка", unit: "tjs", value: m(5000), prev: m(3000), drillKey: "deals" })],
    funnel: { method: "cohort", steps: [
      { key: "leads", label: "Новая заявка", count: 10, conversionFromPrev: null, conversionFromFirst: 100 },
      { key: "deals", label: "Сделка", count: 2, conversionFromPrev: 20, conversionFromFirst: 20 },
    ] },
    lossReasons: [{ reason: "PRICE", label: "Не устроила цена", count: 3 }],
    speed: { medianMin: 12, avgMin: 95, answered: 8, noContactCount: 2, noContactDrillKey: "noContact", overdueTasks: 0, overdueDrillKey: "overdueTasks" },
    agents: [
      { id: "a", name: "Бобур", isActive: true, leads: 5, contacted: 5, calls: 1, messages: 1, meetings: 0, showings: 1, deals: 1, commission: m(100), conversion: 20, overdueTasks: 0, lastActivityAt: null },
      { id: "b", name: "Алишер", isActive: true, leads: 9, contacted: 8, calls: 4, messages: 2, meetings: 1, showings: 2, deals: 3, commission: m(300), conversion: 33, overdueTasks: 1, lastActivityAt: null },
    ],
    sources: [{ source: "WEBSITE", label: "Сайт", leads: 6, deals: 1, commission: m(100) }],
    plan: { commissionPlan: m(10000), planIsDefault: false, fact: m(5000), pct: m(50), left: m(5000), month: "2026-11" },
    updatedAt: "2026-11-21T08:05:00Z", cacheSeconds: 60,
  };
}

const wrap = (node: React.ReactElement) => render(<MemoryRouter>{node}</MemoryRouter>);

describe("плитка KPI", () => {
  it("рост хорошего — зелёная подпись со стрелкой, рост плохого — не зелёная", () => {
    const { rerender } = wrap(<KpiTile kpi={kpi({})} onDrill={() => {}} />);
    expect(screen.getByText(/на 4 заявки больше, чем в прошлом периоде/).closest(".dd-delta")?.getAttribute("data-tone")).toBe("good");
    rerender(<MemoryRouter><KpiTile kpi={kpi({ key: "noContact", goodWhen: "down", value: 9, prev: 3 })} onDrill={() => {}} /></MemoryRouter>);
    expect(screen.getByText(/больше, чем в прошлом периоде/).closest(".dd-delta")?.getAttribute("data-tone")).toBe("bad");
  });
  it("нет базы сравнения — честная строка, а не выдуманный процент", () => {
    wrap(<KpiTile kpi={kpi({ prev: null })} onDrill={() => {}} />);
    expect(screen.getByText("нет данных для сравнения")).toBeTruthy();
  });
  it("цвет плитки по смыслу: «без контакта» больше нуля — красная, ноль — спокойная", () => {
    expect(kpiTileVariant(kpi({ key: "noContact", value: 3 }))).toBe("crit");
    expect(kpiTileVariant(kpi({ key: "noContact", value: 0 }))).toBe("calm");
    expect(kpiTileVariant(kpi({ key: "deals", value: 3 }))).toBe("ok");
  });
  it("клик открывает список за цифрой", () => {
    const onDrill = vi.fn();
    wrap(<KpiTile kpi={kpi({})} onDrill={onDrill} />);
    fireEvent.click(screen.getByRole("button", { name: /Новые заявки: 10/ }));
    expect(onDrill).toHaveBeenCalledWith("newLeads", "Новые заявки");
  });
});

describe("деньги и роли", () => {
  it("без права на деньги нет ни плитки выручки, ни плана, ни столбца комиссии", () => {
    const { container } = wrap(<DirectorBlocks data={data(false)} order={blockOrder("DIRECTOR", false)} mobile={false} onDrill={() => {}} />);
    expect(container.textContent).not.toContain("Выручка");
    expect(container.textContent).not.toContain("План и факт");
    expect(container.textContent).not.toContain("Комиссия");
  });
  it("с правом — выручка, план с процентом и остатком", () => {
    const { container } = wrap(<DirectorBlocks data={data(true)} order={blockOrder("DIRECTOR", true)} mobile={false} onDrill={() => {}} />);
    expect(container.textContent).toContain("Выручка");
    expect(container.textContent).toContain("осталось 5 000");
    expect(container.querySelector(".dd-ring")?.getAttribute("aria-label")).toBe("План выполнен на 50 процентов");
  });
  it("порядок блоков: у директора план выше скорости, у РОП скорость выше плиток", () => {
    const ids = (role: string) => [...wrapIds(role)];
    function wrapIds(role: string) {
      const { container, unmount } = wrap(<DirectorBlocks data={data(true)} order={blockOrder(role, true)} mobile={false} onDrill={() => {}} />);
      const out = [...container.querySelectorAll("section[id]")].map((s) => s.id);
      unmount();
      return out;
    }
    expect(ids("DIRECTOR").indexOf("dd-plan")).toBeLessThan(ids("DIRECTOR").indexOf("dd-speed"));
    expect(ids("HEAD_OF_SALES").indexOf("dd-speed")).toBeLessThan(ids("HEAD_OF_SALES").indexOf("dd-kpi"));
  });
});

describe("таблица менеджеров", () => {
  it("сортируется по столбцу и меняет направление повторным нажатием", () => {
    wrap(<AgentsBlock data={data(true)} mobile={false} />);
    const firstRow = () => within(screen.getAllByRole("row")[1]!).getAllByRole("rowheader")[0]!.textContent;
    expect(firstRow()).toBe("Алишер"); // по умолчанию — по сделкам, больше сверху
    fireEvent.click(screen.getByRole("button", { name: /Заявки/ }));
    expect(firstRow()).toBe("Алишер");
    fireEvent.click(screen.getByRole("button", { name: /Заявки/ }));
    expect(firstRow()).toBe("Бобур");
    expect(screen.getByRole("columnheader", { name: /Заявки/ }).getAttribute("aria-sort")).toBe("ascending");
  });
  it("на телефоне — карточки со ссылкой в карточку сотрудника", () => {
    wrap(<AgentsBlock data={data(true)} mobile />);
    expect(screen.getByRole("link", { name: "Бобур" }).getAttribute("href")).toBe("/team/a");
    expect(screen.queryByRole("table")).toBeNull();
  });
});

describe("пустые состояния", () => {
  it("воронка и причины без данных говорят словами", () => {
    const d = data(true);
    d.funnel.steps = d.funnel.steps.map((s) => ({ ...s, count: 0 }));
    d.lossReasons = [];
    d.agents = [];
    const { container } = wrap(<DirectorBlocks data={d} order={["funnel", "reasons", "agents"]} mobile={false} onDrill={() => {}} />);
    expect(container.textContent).toContain("За этот период заявок не было.");
    expect(container.textContent).toContain("Отказов за этот период нет.");
    expect(container.textContent).toContain("нет данных");
  });
});

describe("права на список и план по умолчанию (ревью #362)", () => {
  it("без права на список плитки не кликабельны — ни KPI, ни скорость, ни отказы", () => {
    const { container } = wrap(<DirectorBlocks data={data(true)} order={["kpi", "speed", "reasons"]} mobile={false} onDrill={() => {}} canDrill={() => false} />);
    expect(container.querySelectorAll("button.dd-tile")).toHaveLength(0);
    expect(screen.queryByText("Открыть список отказов")).toBeNull();
    expect(container.querySelectorAll(".dd-tile").length).toBeGreaterThan(5);
  });
  it("план из умолчания — «План не задан», а не процент", () => {
    const d = data(true);
    d.plan = { commissionPlan: null, planIsDefault: true, fact: 5000, pct: null, left: null, month: "2026-11" };
    const { container } = wrap(<DirectorBlocks data={d} order={["plan"]} mobile={false} onDrill={() => {}} />);
    expect(container.textContent).toContain("План не задан");
    expect(container.querySelector(".dd-ring")).toBeNull();
  });
  it("нет даты активности — «давно»", () => {
    wrap(<AgentsBlock data={data(true)} mobile={false} />);
    expect(screen.getAllByText("давно").length).toBeGreaterThan(0);
  });
});
