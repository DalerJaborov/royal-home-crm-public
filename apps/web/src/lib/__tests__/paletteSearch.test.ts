import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { startPaletteSearch } from "../paletteSearch";

/** FORMS08: устаревший ответ поиска не подменяет результаты нового запроса (04.10.2026). */
function deferred<T>() {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((r) => (resolve = r));
  return { promise, resolve };
}

function makeSink() {
  const log: string[] = [];
  return {
    log,
    sink: {
      clear: () => log.push("clear"),
      setLoading: (v: boolean) => log.push(`loading:${v}`),
      setResults: (r: string) => log.push(`results:${r}`),
    },
  };
}

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe("startPaletteSearch", () => {
  it("A, затем B; B отвечает первым, A вторым: в результатах только B", async () => {
    const a = deferred<string>();
    const b = deferred<string>();
    const { log, sink } = makeSink();
    const fetchAll = vi.fn((q: string) => (q === "A" ? a.promise : b.promise));

    const cancelA = startPaletteSearch("A", fetchAll, sink);
    await vi.advanceTimersByTimeAsync(250); // запрос A улетел
    cancelA(); // эффект перезапущен новым текстом
    startPaletteSearch("B", fetchAll, sink);
    await vi.advanceTimersByTimeAsync(250);

    b.resolve("B");
    await vi.advanceTimersByTimeAsync(0);
    a.resolve("A");
    await vi.advanceTimersByTimeAsync(0);

    expect(log.filter((l) => l.startsWith("results:"))).toEqual(["results:B"]);
    expect(log[log.length - 1]).toBe("loading:false");
  });

  it("строку очистили до ответа A: списки остаются пустыми, спиннер снят", async () => {
    const a = deferred<string>();
    const { log, sink } = makeSink();
    const cancelA = startPaletteSearch("A", () => a.promise, sink);
    await vi.advanceTimersByTimeAsync(250);
    cancelA();
    startPaletteSearch("", () => a.promise, sink);
    a.resolve("A");
    await vi.advanceTimersByTimeAsync(0);

    expect(log.filter((l) => l.startsWith("results:"))).toEqual([]);
    expect(log).toContain("clear");
    expect(log[log.length - 1]).toBe("loading:false");
  });

  it("обычный путь: ответ приходит и применяется", async () => {
    const { log, sink } = makeSink();
    startPaletteSearch("A", async () => "A", sink);
    await vi.advanceTimersByTimeAsync(250);
    expect(log).toEqual(["loading:true", "results:A", "loading:false"]);
  });
});
