import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const reported = vi.hoisted(() => [] as string[]);
vi.mock("../errorReporter", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../errorReporter")>();
  return { ...actual, reportEmptyListGuard: (m: string) => void reported.push(m) };
});

import { queryClient } from "../queryClient";
import {
  formatEmptyListMessage,
  judgeEmptyList,
  nextGuardStep,
  purgeListCaches,
  reportEmptyList,
  type EmptyListFacts,
} from "../emptyListGuard";

class MemoryStorage {
  private store = new Map<string, string>();
  getItem(k: string) {
    return this.store.has(k) ? this.store.get(k)! : null;
  }
  setItem(k: string, v: string) {
    this.store.set(k, String(v));
  }
  removeItem(k: string) {
    this.store.delete(k);
  }
}

const base: EmptyListFacts = {
  isLoading: false,
  isFetching: false,
  hasData: true,
  hasError: false,
  itemCount: 0,
  expected: 13,
};

beforeEach(() => {
  (globalThis as { localStorage?: unknown }).localStorage = new MemoryStorage();
  reported.length = 0;
  queryClient.clear();
});
afterEach(() => {
  delete (globalThis as { caches?: unknown }).caches;
});

describe("judgeEmptyList", () => {
  it("пустой список при непустой сводке — поломка", () => {
    expect(judgeEmptyList(base)).toBe("empty-vs-summary");
  });
  it("ошибка запроса — поломка", () => {
    expect(judgeEmptyList({ ...base, hasData: false, hasError: true, expected: null })).toBe("error");
  });
  it("пока грузится или перезапрашивается — судить рано", () => {
    expect(judgeEmptyList({ ...base, isLoading: true })).toBe("pending");
    expect(judgeEmptyList({ ...base, isFetching: true })).toBe("pending");
  });
  it("честно пустой срез (сводка 0 или не сравнивается) — не поломка", () => {
    expect(judgeEmptyList({ ...base, expected: 0 })).toBeNull();
    expect(judgeEmptyList({ ...base, expected: null })).toBeNull();
    expect(judgeEmptyList({ ...base, expected: undefined })).toBeNull();
  });
  it("список с данными — не поломка", () => {
    expect(judgeEmptyList({ ...base, itemCount: 5 })).toBeNull();
  });
});

describe("nextGuardStep", () => {
  const k = "desktop:BUYER:plain";
  it("поломка: сначала тихий перезапрос, потом плашка и запись, потом покой", () => {
    expect(nextGuardStep({ verdict: "empty-vs-summary", autoKey: null, sliceKey: k, reportedKey: null })).toBe("auto-retry");
    expect(nextGuardStep({ verdict: "empty-vs-summary", autoKey: k, sliceKey: k, reportedKey: null })).toBe("report");
    expect(nextGuardStep({ verdict: "empty-vs-summary", autoKey: k, sliceKey: k, reportedKey: k })).toBe("idle");
  });
  it("во время загрузки ждёт, ничего не пишет", () => {
    expect(nextGuardStep({ verdict: "pending", autoKey: k, sliceKey: k, reportedKey: null })).toBe("wait");
  });
  it("после выздоровления забывает поломку, новая получает свою попытку", () => {
    expect(nextGuardStep({ verdict: null, autoKey: k, sliceKey: k, reportedKey: k })).toBe("reset");
    expect(nextGuardStep({ verdict: null, autoKey: null, sliceKey: k, reportedKey: null })).toBe("idle");
    expect(nextGuardStep({ verdict: "error", autoKey: k, sliceKey: "mobile:SELLER:plain", reportedKey: k })).toBe("auto-retry");
  });
});

describe("purgeListCaches", () => {
  it("сносит снимок на диске, кэш воркера и кэш запросов клиентов", async () => {
    localStorage.setItem("royal-home-query-cache-v1", "{}");
    const deleted: string[] = [];
    (globalThis as { caches?: unknown }).caches = { delete: async (n: string) => void deleted.push(n) };
    queryClient.setQueryData(["clients", { kind: "BUYER" }], { items: [], total: 0 });
    queryClient.setQueryData(["deals"], { keep: true });

    await purgeListCaches();

    expect(localStorage.getItem("royal-home-query-cache-v1")).toBeNull();
    expect(deleted).toEqual(["api-cache"]);
    expect(queryClient.getQueryData(["clients", { kind: "BUYER" }])).toBeUndefined();
    expect(queryClient.getQueryData(["deals"])).toEqual({ keep: true });
  });

  it("недоступное хранилище не роняет и не подвешивает чистку", async () => {
    (globalThis as { caches?: unknown }).caches = { delete: async () => { throw new Error("denied"); } };
    (globalThis as { indexedDB?: unknown }).indexedDB = { open: () => { throw new Error("blocked"); } };
    queryClient.setQueryData(["clients", { kind: "BUYER" }], { items: [] });
    await expect(purgeListCaches()).resolves.toBeUndefined();
    expect(queryClient.getQueryData(["clients", { kind: "BUYER" }])).toBeUndefined();
    delete (globalThis as { indexedDB?: unknown }).indexedDB;
  });

  it("без Cache API не падает", async () => {
    await expect(purgeListCaches()).resolves.toBeUndefined();
  });
});

describe("запись в журнал", () => {
  it("сообщение несёт только технические факты, без номеров", () => {
    const m = formatEmptyListMessage({ slice: "desktop-buyer", reason: "empty-vs-summary", expected: 13, itemCount: 0, dataAgeSec: 42 });
    expect(m.startsWith("[empty-list-guard]")).toBe(true);
    expect(m).toContain("по сводке 13");
    expect(m).not.toMatch(/\+?\d{9,}/);
  });

  it("не чаще раза в час на срез", () => {
    const info = { slice: "mobile-seller", reason: "error" as const, expected: null, itemCount: 0 };
    reportEmptyList(info);
    reportEmptyList(info);
    expect(reported).toHaveLength(1);
    reportEmptyList({ ...info, slice: "mobile-buyer" });
    expect(reported).toHaveLength(2);
  });
});

describe("подключение к экранам", () => {
  const read = (p: string) => readFileSync(resolve(__dirname, "../..", p), "utf8");
  it.each(["pages/Clients.tsx", "components/mobile/MobileClientsList.tsx"])("%s использует единый сторож", (file) => {
    const src = read(file);
    expect(src).toContain("useEmptyListGuard(");
    expect(src).toContain("<EmptyListGuardBanner");
  });
  it("сторож перепроверяет список при возврате на передний план", () => {
    const src = read("hooks/useEmptyListGuard.ts");
    expect(src).toContain('"visibilitychange"');
    expect(src).toContain('"pageshow"');
  });
  it("вход другим сотрудником чистит кэш воркера той же функцией", () => {
    expect(read("store/auth.ts")).toContain("dropSwApiCache");
  });
});
