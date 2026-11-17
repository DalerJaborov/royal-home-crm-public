import { describe, expect, it } from "vitest";
import type { MarketBuyerListingsResponse } from "@royal-home/shared";
import { nextMarketBuyerOffset } from "./useMarket";

const page = (offset: number, n: number, total: number, over: Partial<MarketBuyerListingsResponse> = {}): MarketBuyerListingsResponse => ({
  status: "ok", criteria: [], total, totalIsLowerBound: false, budgetMaxTjs: null, market: null, ownersOnly: null, offset, freshDays: 3,
  clientDistrictMissing: false, listings: Array.from({ length: n }, () => ({}) as never), ...over,
});

describe("nextMarketBuyerOffset («Показать ещё»)", () => {
  it("следующая страница, пока показано меньше total; дальше — нет", () => {
    expect(nextMarketBuyerOffset(page(0, 10, 27))).toBe(10);
    expect(nextMarketBuyerOffset(page(20, 7, 27))).toBeUndefined();
    expect(nextMarketBuyerOffset(page(0, 0, 0))).toBeUndefined();
    expect(nextMarketBuyerOffset(page(0, 0, 0, { status: "no_criteria" }))).toBeUndefined();
  });

  it("глубже предела не листает", () => {
    expect(nextMarketBuyerOffset(page(190, 10, 2000))).toBeUndefined();
    expect(nextMarketBuyerOffset(page(180, 10, 2000))).toBe(190);
  });
});
