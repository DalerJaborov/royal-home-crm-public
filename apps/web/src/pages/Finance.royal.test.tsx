import React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router-dom";
import type { FinanceMonth } from "../hooks/useFinance";
import { RoyalExpenseDonut } from "../components/look/money/RoyalExpenseDonut";
import { profitDelta } from "../components/look/money/RoyalMoneyStrip";

/**
 * «НОВЫЙ ВИД» раздела «Деньги» (пачка money): разметка другая — суммы те же.
 *
 * Один и тот же ответ сервера рисуется в прежнем виде и в новом; из обоих
 * HTML выбираются все суммы («21 000 с.», «-4 500 с.») и сверяются поштучно:
 * новый вид не может потерять, округлить иначе, сменить знак или валюту ни
 * одной цифры. Права те же: без `finance.view` — тот же отказ, без
 * `finance.manage` — те же закрытые действия.
 */
const state = vi.hoisted(() => ({ royal: false, mobile: false, canManage: true, canView: true, data: undefined as unknown }));
vi.mock("../hooks/useRoyalLook", () => ({ useRoyalLook: () => state.royal }));
vi.mock("../hooks/useCleanShell", () => ({ useCleanShell: () => true }));
vi.mock("../hooks/useMobileUx", () => ({ useMobileUx: () => state.mobile }));
vi.mock("../lib/permissions", () => ({
  useCan: () => (perm: string) => perm === "finance.manage" ? state.canManage : perm === "finance.view" ? state.canView : true,
  useIsReadOnly: () => false,
}));
vi.mock("../hooks/useFinance", () => ({
  useFinanceSummary: () => ({ data: state.data, isLoading: false, error: null, refetch: vi.fn() }),
  useExpenseForecast: () => ({ data: undefined }),
  useCommissionForecast: () => ({ data: undefined }),
  downloadFinanceCsv: vi.fn(),
}));
vi.mock("../components/rh2/ShellOwnHeader", () => ({ ShellOwnHeader: () => null }));
vi.mock("../components/finance/PulseTiles", () => ({ PulseTiles: () => <div>Native pulse</div> }));
vi.mock("../components/finance/CommissionForecastBlock", () => ({ CommissionForecastCard: () => <div>Native commission forecast</div> }));
vi.mock("../components/finance/ClaudeExpenseFeed", () => ({ ClaudeExpenseFeed: () => <div data-workspace="expenses" /> }));
vi.mock("../components/finance/ClaudeSubscriptions", () => ({ ClaudeSubscriptions: () => <div data-workspace="recurring" /> }));
vi.mock("../components/finance/ClaudePaymentCalendar", () => ({ ClaudePaymentCalendar: () => <div data-workspace="calendar" /> }));
vi.mock("../components/finance/ClaudeExpenseTable", () => ({ ClaudeExpenseTable: () => <div data-workspace="table" /> }));
vi.mock("../components/finance/ClaudeExpenseSheet", () => ({ ClaudeExpenseSheet: () => null }));
vi.mock("../components/finance/ClaudeCategorySettings", () => ({ ClaudeCategorySettings: () => null }));
vi.mock("../components/finance/ClaudeFounders", () => ({ ClaudeFounders: () => <div data-workspace="founders" /> }));

import { Finance } from "./Finance";

const sep = { month: "2026-09", revenue: 18450.4, realtorPayouts: 6000, companyRevenue: 12450.4, expenses: { ADVERTISING: 3000 }, totalExpenses: 3000, dealSalaryExpenses: 0, operatingExpenses: 3000, profit: 9450.4, payouts: [], leads: 4, costPerLead: [] } satisfies FinanceMonth;
const oct: FinanceMonth = {
  month: "2026-10", revenue: 21000, realtorPayouts: 7000, companyRevenue: 14000,
  expenses: { OFFICE: 2500, ADVERTISING: 16000, SALARY: 4000 }, totalExpenses: 22500, dealSalaryExpenses: 4000, operatingExpenses: 18500,
  profit: -4500.6, leads: 10,
  payouts: [{ agentId: "a1", name: "Агент Один", realtor: 7000, total: 7000, deals: [{ dealId: "d1", realtor: 7000, payoutAt: null }] }] as unknown as FinanceMonth["payouts"],
  costPerLead: [{ source: "INSTAGRAM", spend: 16000, leads: 8, costPerLead: 2000, deals: 1, costPerDeal: 16000 }] as unknown as FinanceMonth["costPerLead"],
};

const render = (url: string) => renderToStaticMarkup(<MemoryRouter initialEntries={[url]}><Finance /></MemoryRouter>);
/**
 * Все числа страницы, отсортированные: «21 000 с.», «-4 501 с.», «7 000», «850»,
 * «539,5 с.», «20 %» — любой длины, с дробью и процентом. Оба вида разбираются
 * одним шаблоном, так что одинаковая склейка соседних чисел их не различит.
 */
const sums = (html: string) => {
  const text = html.replace(/<[^>]+>/g, " ").replace(/&nbsp;/g, " ").replace(/[ \t\n]+/g, " ");
  return [...text.matchAll(/-?\d{1,3}(?:[   ]\d{3})*(?:[.,]\d+)?(?: ?(?:%|с\.|сомони|\$))?/g)]
    .map((m) => m[0].replace(/[  ]/g, " ").trim()).sort();
};

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-10-14T12:00:00Z"));
  Object.assign(state, { royal: false, mobile: false, canManage: true, canView: true, data: { months: [sep, oct], usdToTjsRate: 10.9 } });
});
afterEach(() => vi.useRealTimers());

describe("«Деньги» в новом виде: те же суммы, что в прежнем", () => {
  it.each(["overview", "payouts"])("вкладка %s: каждая сумма прежнего вида есть в новом, лишних нет", (workspace) => {
    for (const mobile of [false, true]) {
      state.mobile = mobile;
      state.royal = false;
      const before = sums(render(`/finance?workspace=${workspace}`));
      state.royal = true;
      // Строка «доход · расходы · прибыль» (разделы директора, 20.11) — добавка нового
      // вида над разделом; её суммы сверяет свой тест ниже, здесь сравнивается остальное.
      const after = sums(render(`/finance?workspace=${workspace}`).replace(/<section class="ry-money-strip"[\s\S]*?<\/section>/, ""));
      expect(before.length).toBeGreaterThan(0);
      expect(after).toEqual(before);
    }
  });
  it("итоги месяца плитками — те же строки «N с.» и тот же знак у убытка", () => {
    state.royal = true;
    const html = render("/finance?workspace=overview");
    for (const [label, value] of [["Валовая комиссия", "21 000 с."], ["Доход компании", "14 000 с."], ["Операционные расходы", "18 500 с."], ["Прибыль", "-4 501 с."]]) {
      expect(html).toContain(label);
      expect(html.replace(/<[^>]+>/g, "").replace(/[  ]/g, " ")).toContain(value);
    }
    // Убыток — красной плиткой со значком, а не только цветом.
    expect(html).toMatch(/class="ry-money-tile" data-tone="crit"><span class="ry-circle" data-tone="crit">/);
    // Валовые расходы с долями агентов (22 500) обзор по-прежнему НЕ показывает: доли не вычитаются дважды.
    expect(html).not.toContain("22 500");
  });
  it("прибыль больше нуля — плитка НЕ красная, со значком роста; убыток — красная со значком «!»", () => {
    state.royal = true;
    state.data = { months: [sep, { ...oct, profit: 9450.4 }], usdToTjsRate: 10.9 };
    const gain = render("/finance?workspace=overview");
    expect(gain.replace(/[\u00a0\u202f]/g, " ")).toContain("9 450");
    expect(gain).not.toContain('data-tone="crit"');
    expect(gain).toMatch(/class="ry-money-tile" data-tone="ok">(?:(?!ry-money-tile").)*Прибыль/);
    state.data = { months: [sep, oct], usdToTjsRate: 10.9 };
    const loss = render("/finance?workspace=overview");
    expect(loss).toMatch(/class="ry-money-tile" data-tone="crit"><span class="ry-circle" data-tone="crit">(?:(?!ry-money-tile").)*Прибыль/);
  });
  it("доход, расходы и прибыль одной строкой над «Расходами» и «Выплатами», со сравнением с прошлым месяцем", () => {
    state.royal = true;
    for (const workspace of ["expenses", "payouts", "founders"]) {
      const html = render(`/finance?workspace=${workspace}`);
      const strip = /<section class="ry-money-strip"[\s\S]*?<\/section>/.exec(html)?.[0] ?? "";
      const t = strip.replace(/<[^>]+>/g, " ").replace(/[  ]/g, " ").replace(/\s+/g, " ");
      expect(t, workspace).toContain("Доход компании 14 000 с.");
      expect(t).toContain("Расходы 18 500 с.");
      // убыток: и словом, и красным; сравнение с сентябрём — со стрелкой и в обе стороны
      expect(t).toContain("Убыток 4 501 с.");
      expect(t).toContain("▲ на 1 550 с. больше, чем в сентябре");
      expect(t).toContain("▲ на 15 500 с. больше, чем в сентябре");
      // прибыль сменилась убытком — словами, без арифметики через ноль, красным
      expect(t).toContain("в сентябре была прибыль 9 450 с.");
      expect(strip).toMatch(/data-tone="crit"/);
    }
    // В «Обзоре» итоги уже стоят плитками — строки нет; в прежнем виде её нет нигде.
    expect(render("/finance?workspace=overview")).not.toContain("ry-money-strip");
    state.royal = false;
    expect(render("/finance?workspace=expenses")).not.toContain("ry-money-strip");
  });
  it("новый вид: в строке вкладок главное, подписки/календарь/таблица — в «⋯», открытый раздел виден вкладкой", () => {
    state.royal = true;
    const tabs = (html: string) => [...html.matchAll(/role="tab"[^>]*>([^<]+)</g)].map((m) => m[1]);
    expect(tabs(render("/finance"))).toEqual(["Расходы", "Обзор", "Выплаты", "Учредители"]);
    const more = render("/finance");
    expect(more).toContain('aria-label="Другие разделы денег"');
    for (const label of ["Подписки", "Календарь", "Таблица"]) expect(more).toContain(`>${label}</button>`);
    expect(tabs(render("/finance?workspace=calendar"))).toEqual(["Расходы", "Обзор", "Выплаты", "Учредители", "Календарь"]);
    state.royal = false;
    expect(tabs(render("/finance"))).toHaveLength(7);
  });
  it("метка раздела стоит только в новом виде; прежний вид разметкой не тронут", () => {
    state.royal = true;
    expect(render("/finance")).toContain('data-ry-section="money"');
    state.royal = false;
    const legacy = render("/finance?workspace=overview");
    expect(legacy).not.toContain("data-ry-section");
    expect(legacy).not.toContain("ry-money");
    expect(legacy).toContain('class="cef-summary-grid"');
  });
  it("права те же: без finance.view — тот же отказ в обоих видах; без finance.manage — нет «+ Расход»", () => {
    state.canView = false;
    for (const royal of [false, true]) {
      state.royal = royal;
      const html = render("/finance");
      expect(html).toContain("Раздел доступен только директору и администратору.");
      expect(html).not.toContain("cef-page");
    }
    state.canView = true;
    state.canManage = false;
    for (const royal of [false, true]) {
      state.royal = royal;
      expect(render("/finance")).not.toContain("cef-add");
    }
  });
});

describe("кольцо расходов: та же доля и та же подпись, что у полосы прежнего вида", () => {
  const parts = [
    { key: "OFFICE", tone: "office", value: 2500, name: "Офис", amount: "2 500 с." },
    { key: "ADVERTISING", tone: "ads", value: 16000, name: "Реклама", amount: "16 000 с." },
    { key: "SALARY", tone: "salary", value: 0, name: "Зарплаты", amount: "0 с." },
  ];
  it("пустые категории не рисует, подписи — те же строки", () => {
    const html = renderToStaticMarkup(<RoyalExpenseDonut parts={parts} total={18500} center="18 500 с." caption="всего" />);
    expect(html).toContain("<title>Офис: 2 500 с.</title>");
    expect(html).toContain("<title>Реклама: 16 000 с.</title>");
    expect(html).not.toContain("Зарплаты");
    expect(html).toContain('aria-label="Распределение расходов: Офис — 2 500 с. — 14 %; Реклама — 16 000 с. — 86 %"');
    expect(html.replace(/<[^>]+>/g, "")).toContain("18 500 с.");
  });
  it("длины дуг пропорциональны долям (как ширины полосы)", () => {
    const html = renderToStaticMarkup(<RoyalExpenseDonut parts={parts} total={18500} center="" caption="" />);
    const arcs = [...html.matchAll(/stroke-dasharray="([\d.]+) /g)].map((m) => Number(m[1]) + 2);
    const circle = 2 * Math.PI * 52;
    expect(arcs[0]).toBeCloseTo((2500 / 18500) * circle, 5);
    expect(arcs[1]).toBeCloseTo((16000 / 18500) * circle, 5);
  });
  it("без расходов дуг нет — не рисует ноль как долю", () => {
    const html = renderToStaticMarkup(<RoyalExpenseDonut parts={parts.map((p) => ({ ...p, value: 0 }))} total={0} center="—" caption="всего" />);
    expect(html).not.toContain("ry-donut-seg");
  });
});

describe("сравнение прибыли и убытка с прошлым месяцем (ревью PR 336)", () => {
  const t = (v: number, p: number) => { const d = profitDelta(v, p, "в октябре"); return { text: d.text.replace(/[ ]/g, " "), good: d.good }; };
  it("убыток уменьшился — хорошо, словами по модулю", () =>
    expect(t(-2000, -5000)).toEqual({ text: "▼ убыток меньше на 3 000 с., чем в октябре", good: true }));
  it("убыток вырос — плохо", () =>
    expect(t(-5000, -2000)).toEqual({ text: "▲ убыток больше на 3 000 с., чем в октябре", good: false }));
  it("была прибыль, стал убыток — плохо; был убыток, стала прибыль — хорошо", () => {
    expect(t(-100, 400)).toEqual({ text: "в октябре была прибыль 400 с.", good: false });
    expect(t(100, -400)).toEqual({ text: "в октябре был убыток 400 с.", good: true });
  });
  it("прибыль выросла и упала — как обычно", () => {
    expect(t(500, 200).good).toBe(true);
    expect(t(200, 500)).toEqual({ text: "▼ на 300 с. меньше, чем в октябре", good: false });
  });
});
