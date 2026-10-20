import { QueryClient, QueryObserver } from "@tanstack/react-query";
import { describe, expect, it } from "vitest";
import { refreshFinanceReadModels } from "../../hooks/useFinance";

describe("automatic expenses refreshed by the money pulse", () => {
  it("replaces an older in-flight summary, even on the first visit", async () => {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    let finishOld!: (value: { total: number }) => void;
    const oldResponse = new Promise<{ total: number }>((resolve) => { finishOld = resolve; });
    let requests = 0;
    const observer = new QueryObserver(client, {
      queryKey: ["finance-summary", 6, "2026-10"],
      queryFn: () => ++requests === 1 ? oldResponse : Promise.resolve({ total: 5713 }),
      staleTime: 300_000,
    });
    const unsubscribe = observer.subscribe(() => {});
    try {
      expect(requests).toBe(1);
      await refreshFinanceReadModels(client);
      finishOld({ total: 5710 });
      await oldResponse;
      expect(requests).toBe(2);
      expect(observer.getCurrentResult().data).toEqual({ total: 5713 });
    } finally {
      unsubscribe();
      client.clear();
    }
  });

  it("refreshes all expense read models without invalidating the pulse itself", async () => {
    const client = new QueryClient();
    const affected = [
      ["finance-summary", 2, "2026-10"], ["finance-summary", 6],
      ["expenses", "2026-10"], ["expenses", "claude-feed", "2026-10"],
      ["expenses", "claude-page", { month: "2026-10" }],
      ["expenses", "claude-pivot", { from: "2026-10-01" }],
    ];
    const retained = [["expenses", "pulse"], ["expenses", "recurring"], ["expenses", "categories"], ["mission-control"]];
    try {
      for (const key of [...affected, ...retained]) client.setQueryData(key, { value: 1 });
      await refreshFinanceReadModels(client);
      for (const key of affected) expect(client.getQueryState(key)?.isInvalidated).toBe(true);
      for (const key of retained) expect(client.getQueryState(key)?.isInvalidated).toBe(false);
    } finally {
      client.clear();
    }
  });
});
