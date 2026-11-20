import { describe, expect, it, vi, beforeEach } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { EXPENSE_CATEGORY_LABELS, type ExpenseCategory } from "@royal-home/shared";
import type { FinanceMonth } from "../../../hooks/useFinance";
import { RoyalSection } from "../clients/RoyalSection";
import { DONUT_C, DONUT_GAP } from "./RoyalExpenseDonut";

/**
 * Кольцо расходов нарисовано НАСТОЯЩЕЙ лентой «Расходы» (ClaudeExpenseFeed) внутри
 * раздела «Деньги» нового вида — не заглушкой. Сверяется то, что видит директор:
 * в центре кольца — самая большая доля с названием (не повтор итога), суммы легенды складываются в итог,
 * дуги вместе — ровно весь круг (100 %), ни одна категория с расходом не потеряна.
 */
const state = vi.hoisted(() => ({ month: undefined as unknown }));
vi.mock("../../../hooks/useFinance", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../../hooks/useFinance")>()),
  useFinanceSummary: () => ({ data: { months: [state.month], usdToTjsRate: 10.9 }, isLoading: false, error: null, refetch: vi.fn() }),
}));
vi.mock("../../../hooks/useMobileUx", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../../hooks/useMobileUx")>()),
  useMobileUx: () => false,
}));
vi.mock("../../../hooks/useUndoToast", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../../hooks/useUndoToast")>()),
  useUndoToast: () => ({ showUndoToast: vi.fn() }),
}));
vi.mock("../../../lib/permissions", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../../lib/permissions")>()),
  useIsReadOnly: () => false,
}));
vi.mock("../../../lib/claudeFinanceApi", async (importOriginal) => {
  const query = (data: unknown) => ({ data, isPending: false, isError: false, isFetching: false, refetch: vi.fn() });
  const mutation = () => ({ mutateAsync: vi.fn() });
  return {
    ...(await importOriginal<typeof import("../../../lib/claudeFinanceApi")>()),
    useClaudeExpenseCategories: () => query([]),
    useClaudeExpensePage: () => query({ items: [], total: 0 }),
    useClaudeUpcoming: () => query([]),
    usePayClaudeExpense: mutation, usePayClaudeRecurring: mutation, useUndoClaudePayment: mutation, useUndoClaudeRecurring: mutation,
  };
});

import { ClaudeExpenseFeed } from "../../finance/ClaudeExpenseFeed";

const month = (expenses: FinanceMonth["expenses"]): FinanceMonth => {
  const total = Object.values(expenses).reduce((sum, v) => sum + (v ?? 0), 0);
  return { month: "2026-10", revenue: 0, realtorPayouts: 0, companyRevenue: 0, expenses, totalExpenses: total, dealSalaryExpenses: 0, operatingExpenses: total, profit: -total, payouts: [], leads: 0, costPerLead: [] };
};
const render = (royal = true) => renderToStaticMarkup(
  <RoyalSection name={royal ? "money" : undefined}>
    <ClaudeExpenseFeed month="2026-10" canManage onAdd={vi.fn()} onEdit={vi.fn()} />
  </RoyalSection>,
);
const text = (html: string) => html.replace(/<[^>]+>/g, "").replace(/ /g, " ");
/** «1 234 567,5 с.» → 1234567.5 */
const amount = (s: string) => Number(s.replace(/[^\d,-]/g, "").replace(",", "."));

const CASES: Record<string, FinanceMonth["expenses"]> = {
  "обычный месяц": { OFFICE: 4500, ADVERTISING: 4835, SALARY: 6000, OTHER: 850.5 },
  "больше миллиона, копейки": { OFFICE: 1_200_000, ADVERTISING: 34_567.5, OTHER: 0.25 },
  "одна категория «Прочее»": { OTHER: 850 },
};

describe("кольцо расходов на настоящей ленте «Расходы»", () => {
  beforeEach(() => { state.month = undefined; });
  it.each(Object.entries(CASES))("%s: центр = итог, легенда = итог, дуги = 100 %, категории на месте", (_name, expenses) => {
    state.month = month(expenses);
    const html = render();
    const kpi = text(/<div class="cef-kpi">([\s\S]*?)<\/div>/.exec(html)![1]);
    // Центр не повторяет итог из заголовка (кадр владельца 20.11): там самая большая доля
    // и её название — «Реклама 92 %».
    const centerMatch = /<figcaption class="ry-donut-center"><strong[^>]*>([\s\S]*?)<\/strong><span>([^<]*)<\/span>/.exec(html)!;
    const total = amount(kpi);
    const [topKey, topValue] = Object.entries(expenses).sort((a, b) => (b[1] ?? 0) - (a[1] ?? 0))[0];
    expect(text(centerMatch[1])).toBe(`${Math.round(((topValue ?? 0) / total) * 100)} %`);
    expect(centerMatch[2]).toBe(EXPENSE_CATEGORY_LABELS[topKey as ExpenseCategory]);
    expect(text(centerMatch[1])).not.toBe(kpi);
    expect(total).toBeCloseTo(Object.values(expenses).reduce((s, v) => s + (v ?? 0), 0), 2);

    // Легенда: «Категория <b>сумма</b>» — суммы складываются в итог месяца.
    const legend = [...html.matchAll(/aria-pressed="(?:true|false)"><i [^>]*><\/i>([^<]*?) <b>([^<]*)<\/b>/g)].map((m) => ({ name: m[1], sum: amount(m[2]) }));
    expect(legend.length).toBe(4);
    expect(legend.reduce((s, l) => s + l.sum, 0)).toBeCloseTo(total, 2);

    // Дуги: длина + просвет каждой — доля круга; вместе ровно весь круг.
    const arcs = [...html.matchAll(/class="ry-donut-seg[^"]*"[^>]*stroke-dasharray="([\d.]+) [\d.]+"[^>]*><title>([^<]*)<\/title>/g)];
    const shown = Object.entries(expenses).filter(([, v]) => (v ?? 0) > 0);
    expect(arcs.length).toBe(shown.length);
    const gap = shown.length > 1 ? DONUT_GAP : 0;
    // Каждая дуга — своя доля круга (минус просвет); крошечная доля может стать нулём, но не пропасть из подписей.
    for (const [key, v] of shown) {
      const arc = arcs.find((m) => text(m[2]).startsWith(`${EXPENSE_CATEGORY_LABELS[key as ExpenseCategory]}:`));
      expect(arc, key).toBeDefined();
      expect(Number(arc![1])).toBeCloseTo(Math.max(0, ((v ?? 0) / total) * DONUT_C - gap), 3);
    }
    // Нарисованные дуги с просветами — весь круг (100 %): не больше круга и меньше него не более
    // чем на просветы долей, слишком малых для дуги.
    const drawn = arcs.reduce((sum, m) => sum + (Number(m[1]) > 0 ? Number(m[1]) + gap : 0), 0);
    expect(drawn).toBeLessThanOrEqual(DONUT_C + 0.01);
    expect(drawn).toBeGreaterThanOrEqual(DONUT_C - gap * arcs.length - 0.01);
    // Ни одна категория с расходом не потеряна: у каждой есть дуга и строка в подписи кольца.
    for (const l of legend.filter((x) => x.sum > 0)) {
      expect(arcs.some((m) => text(m[2]).startsWith(`${l.name}:`)), l.name).toBe(true);
      expect(/role="img" aria-label="([^"]*)"/.exec(html)![1]).toContain(`${l.name} — `);
    }
  });

  it("подпись кольца для чтеца — «категория — сумма — доля», доли дают 100 % с допуском округления", () => {
    state.month = month(CASES["обычный месяц"]);
    const label = text(/role="img" aria-label="([^"]*)"/.exec(render())![1]);
    const shares = [...label.matchAll(/— (\d+) %/g)].map((m) => Number(m[1]));
    expect(label).toContain("Прочее — 850,5");
    expect(shares).toHaveLength(4);
    expect(Math.abs(shares.reduce((a, b) => a + b, 0) - 100)).toBeLessThanOrEqual(2);
  });

  it("дуги не в порядке Tab: кольцо — одна картинка", () => {
    state.month = month(CASES["обычный месяц"]);
    expect(render()).not.toMatch(/ry-donut-seg[^>]*tabindex/i);
  });

  it("без признака нового вида — прежняя полоса, кольца нет", () => {
    state.month = month(CASES["обычный месяц"]);
    const html = render(false);
    expect(html).toContain('class="cef-bar"');
    expect(html).not.toContain("ry-donut");
  });
});
