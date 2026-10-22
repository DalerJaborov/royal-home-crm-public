import { beforeEach, describe, expect, it, vi } from "vitest";

// Сброс кэша рассылает «пульт устарел» — здесь он не нужен.
vi.mock("../src/lib/eventBus.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/lib/eventBus.js")>()),
  publish: vi.fn(async () => {}),
}));

import { cachedSection, invalidateMissionControlCache } from "../src/lib/missionControlCache.js";

/**
 * Истёкшая секция пульта считается ОДИН раз, сколько бы вкладок ни пришло
 * разом (аудит 23.09.2026, №92). Раньше каждый открытый пульт запускал свой
 * расчёт — а после сброса кэша все вкладки приходят именно одновременно.
 */

function deferred<T>() {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

beforeEach(() => invalidateMissionControlCache());

describe("кэш пульта: один расчёт на ключ", () => {
  it("десять одновременных запросов — один расчёт, у всех один ответ", async () => {
    const gate = deferred<{ n: number }>();
    const fn = vi.fn(() => gate.promise);
    const calls = Array.from({ length: 10 }, () => cachedSection("k-many", 15_000, fn));
    gate.resolve({ n: 7 });
    const results = await Promise.all(calls);
    expect(fn).toHaveBeenCalledTimes(1);
    expect(results.every((r) => r.n === 7)).toBe(true);
    // И дальше отдаётся из кэша.
    await cachedSection("k-many", 15_000, fn);
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it("отказ расчёта получают все ждавшие, следующий запрос считает заново", async () => {
    const gate = deferred<number>();
    const fn = vi.fn(() => gate.promise);
    const a = cachedSection("k-fail", 15_000, fn);
    const b = cachedSection("k-fail", 15_000, fn);
    gate.reject(new Error("база моргнула"));
    await expect(a).rejects.toThrow("база моргнула");
    await expect(b).rejects.toThrow("база моргнула");
    const ok = await cachedSection("k-fail", 15_000, async () => 5);
    expect(ok).toBe(5);
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it("синхронный бросок не оставляет вечный «расчёт идёт»", async () => {
    const boom = () => {
      throw new Error("сразу");
    };
    await expect(cachedSection("k-sync", 15_000, boom as () => Promise<number>)).rejects.toThrow("сразу");
    expect(await cachedSection("k-sync", 15_000, async () => 1)).toBe(1);
  });

  it("расчёт, начатый до сброса, не кладёт устаревшее в кэш и не держит новых", async () => {
    const old = deferred<string>();
    const first = cachedSection("k-gen", 15_000, () => old.promise);
    invalidateMissionControlCache();
    const fresh = vi.fn(async () => "новое");
    expect(await cachedSection("k-gen", 15_000, fresh)).toBe("новое");
    old.resolve("старое");
    expect(await first).toBe("старое");
    expect(await cachedSection("k-gen", 15_000, async () => "не должно звать")).toBe("новое");
    expect(fresh).toHaveBeenCalledTimes(1);
  });

  it("секция с ошибкой ({ error: true }) не кэшируется", async () => {
    await cachedSection("k-err", 15_000, async () => ({ error: true }));
    const fn = vi.fn(async () => ({ error: false }));
    await cachedSection("k-err", 15_000, fn);
    expect(fn).toHaveBeenCalledTimes(1);
  });
});
