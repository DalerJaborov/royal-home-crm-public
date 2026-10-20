import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * ACCESS-14 (аудит 04.10.2026): среднее трёх прошлых месяцев делилось на число
 * месяцев, в которых ЕСТЬ строки расходов. Завершённый месяц с нулём расходов
 * выпадал из знаменателя: Окт 0 / Ноя 1000 / Дек 0 давали среднее 1000 вместо
 * 333,33, и тревога о превышении молчала.
 */
type Row = { amount: number; currency: string; month: Date; autoKey: string | null };
const state = vi.hoisted(() => ({
  current: [] as Row[],
  previous: [] as Row[],
  firstMonth: null as Date | null,
}));

vi.mock("../src/db.js", () => ({
  prisma: {
    expense: {
      findMany: vi.fn(async (args: { where: { month: unknown } }) =>
        args.where.month instanceof Date ? state.current : state.previous
      ),
      findFirst: vi.fn(async () => (state.firstMonth ? { month: state.firstMonth } : null)),
    },
    settings: { findUnique: vi.fn(async () => ({ usdToTjsRate: 10 })) },
    $disconnect: vi.fn(async () => undefined),
  },
}));
vi.mock("../src/lib/systemError.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/lib/systemError.js")>()),
  logSystemError: vi.fn(async () => undefined),
}));

const m = (iso: string) => new Date(`${iso}-01T00:00:00.000Z`);
const row = (iso: string, amount: number): Row => ({ amount, currency: "TJS", month: m(iso), autoKey: null });

describe("buildExpenseForecast: среднее по календарным месяцам (ACCESS-14)", () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["Date"] });
    // 10 января 2026, 10:00 по Душанбе.
    vi.setSystemTime(new Date("2026-01-10T05:00:00.000Z"));
    state.current = [row("2026-01", 250)];
    state.previous = [];
    state.firstMonth = null;
  });
  afterEach(() => vi.useRealTimers());

  it("пустые завершённые месяцы входят в знаменатель: 1000 за три месяца = 333,33", async () => {
    const { buildExpenseForecast } = await import("../src/lib/financeAutomation.js");
    state.previous = [row("2025-11", 1000)];
    state.firstMonth = m("2025-10");
    const f = await buildExpenseForecast();
    expect(f.averageTjs).toBeCloseTo(333.33, 2);
    // Прогноз 775 против порога 333,33 * 1,25 = 416,67: тревога обязана сработать.
    expect(f.projectedTjs).toBeCloseTo(775, 2);
    expect(f.overrun).toBe(true);
  });

  it("компания, чей первый расход в ноябре, считается по двум месяцам", async () => {
    const { buildExpenseForecast } = await import("../src/lib/financeAutomation.js");
    state.previous = [row("2025-11", 1000)];
    state.firstMonth = m("2025-11");
    const f = await buildExpenseForecast();
    expect(f.averageTjs).toBeCloseTo(500, 2);
  });

  it("первый расход в прошлом месяце: прежнее поведение, среднее по одному", async () => {
    const { buildExpenseForecast } = await import("../src/lib/financeAutomation.js");
    state.previous = [row("2025-12", 900)];
    state.firstMonth = m("2025-12");
    const f = await buildExpenseForecast();
    expect(f.averageTjs).toBeCloseTo(900, 2);
  });

  it("история старше трёх месяцев: знаменатель три", async () => {
    const { buildExpenseForecast } = await import("../src/lib/financeAutomation.js");
    state.previous = [row("2025-12", 900)];
    state.firstMonth = m("2024-02");
    const f = await buildExpenseForecast();
    expect(f.averageTjs).toBeCloseTo(300, 2);
  });
});
