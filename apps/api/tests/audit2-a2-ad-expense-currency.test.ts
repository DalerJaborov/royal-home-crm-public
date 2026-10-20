import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * ACCESS-11 (аудит 04.10.2026): автоматическая строка «реклама за месяц» обновляла
 * сумму, но не валюту. Месяц, заведённый как 10 USD, при появлении сомонёвого
 * кабинета пересчитывался в 120 TJS и записывался как «120 USD» (в Финансах в десять
 * раз больше). А если число совпадало, а валюта сменилась, строку пропускали вовсе.
 */
const state = vi.hoisted(() => ({
  groupBy: [] as Array<{ currency: string; _sum: { spend: number } }>,
  existing: null as null | { id: string; deletedAt: Date | null; amount: number; currency: string },
  update: vi.fn(),
  create: vi.fn(),
}));

vi.mock("../src/db.js", () => ({
  prisma: {
    adSpendDaily: { groupBy: vi.fn(async () => state.groupBy) },
    expense: {
      findUnique: vi.fn(async () => state.existing),
      update: state.update,
      create: state.create,
    },
    settings: { findUnique: vi.fn(async () => ({ usdToTjsRate: 10 })) },
    $disconnect: vi.fn(async () => undefined),
  },
}));
vi.mock("../src/lib/systemError.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/lib/systemError.js")>()),
  logSystemError: vi.fn(async () => undefined),
}));

describe("adExpenseSync: сумма и валюта обновляются вместе (ACCESS-11)", () => {
  beforeEach(() => {
    state.update.mockReset();
    state.create.mockReset();
    state.existing = null;
    state.groupBy = [];
  });

  it("USD-строка при смешанных валютах становится TJS вместе с новой суммой", async () => {
    const { upsertAdExpenses } = await import("../src/lib/ads/adExpenseSync.js");
    state.existing = { id: "e1", deletedAt: null, amount: 10, currency: "USD" };
    state.groupBy = [
      { currency: "USD", _sum: { spend: 10 } },
      { currency: "TJS", _sum: { spend: 20 } },
    ];
    await upsertAdExpenses(["2031-05"]);
    expect(state.update).toHaveBeenCalledTimes(1);
    expect(state.update.mock.calls[0]?.[0].data).toEqual({ amount: 120, currency: "TJS" });
  });

  it("то же число, но другая валюта: строка всё равно обновляется", async () => {
    const { upsertAdExpenses } = await import("../src/lib/ads/adExpenseSync.js");
    state.existing = { id: "e1", deletedAt: null, amount: 120, currency: "USD" };
    state.groupBy = [
      { currency: "USD", _sum: { spend: 10 } },
      { currency: "TJS", _sum: { spend: 20 } },
    ];
    await upsertAdExpenses(["2031-05"]);
    expect(state.update).toHaveBeenCalledTimes(1);
    expect(state.update.mock.calls[0]?.[0].data).toEqual({ amount: 120, currency: "TJS" });
  });

  it("сумма и валюта те же: записи нет", async () => {
    const { upsertAdExpenses } = await import("../src/lib/ads/adExpenseSync.js");
    state.existing = { id: "e1", deletedAt: null, amount: 120, currency: "TJS" };
    state.groupBy = [
      { currency: "USD", _sum: { spend: 10 } },
      { currency: "TJS", _sum: { spend: 20 } },
    ];
    const touched = await upsertAdExpenses(["2031-05"]);
    expect(touched).toBe(0);
    expect(state.update).not.toHaveBeenCalled();
  });
});
