import { describe, expect, it } from "vitest";
import { isPoolExhaustionError, runLimited } from "../src/lib/concurrency.js";

/**
 * Приёмка 08.09.2026: голый `Promise.all` из 9-11 задач (routes/oversight.ts
 * `/summary`, routes/dashboard.ts `/counters`) при нескольких одновременных
 * пользователях исчерпывал пул соединений Prisma. `runLimited` — замена с
 * ограниченной конкурентностью; тесты проверяют её базовые гарантии, раз она
 * встала на пути каждого такого запроса.
 */
describe("runLimited", () => {
  it("возвращает результаты в исходном порядке независимо от скорости задач", async () => {
    const order: number[] = [];
    const tasks = [10, 1, 5, 2].map(
      (delayMs, i) => () =>
        new Promise<number>((resolve) => {
          setTimeout(() => {
            order.push(i);
            resolve(i);
          }, delayMs);
        })
    );
    const results = await runLimited(tasks, 2);
    expect(results).toEqual([0, 1, 2, 3]);
  });

  it("не запускает больше задач одновременно, чем limit", async () => {
    let running = 0;
    let maxRunning = 0;
    const tasks = Array.from({ length: 8 }, () => async () => {
      running++;
      maxRunning = Math.max(maxRunning, running);
      await new Promise((r) => setTimeout(r, 10));
      running--;
      return 1;
    });
    const results = await runLimited(tasks, 3);
    expect(results).toEqual(Array(8).fill(1));
    expect(maxRunning).toBeLessThanOrEqual(3);
  });

  it("пробрасывает первую ошибку, как это сделал бы Promise.all", async () => {
    const boom = new Error("boom");
    const tasks = [
      () => Promise.resolve(1),
      () => Promise.reject(boom),
      () => Promise.resolve(3),
    ];
    await expect(runLimited(tasks, 2)).rejects.toBe(boom);
  });

  it("пустой список задач не запускает воркеров и не падает", async () => {
    await expect(runLimited([], 4)).resolves.toEqual([]);
  });

  it("limit больше числа задач — ограничивается их числом, не создаёт лишних воркеров", async () => {
    const results = await runLimited([() => Promise.resolve("a"), () => Promise.resolve("b")], 10);
    expect(results).toEqual(["a", "b"]);
  });
});

describe("isPoolExhaustionError", () => {
  it("узнаёт код Prisma P2024", () => {
    expect(isPoolExhaustionError({ code: "P2024" })).toBe(true);
  });

  it("узнаёт текст таймаута пула у старых версий клиента", () => {
    expect(isPoolExhaustionError(new Error("Timed out fetching a new connection from the connection pool."))).toBe(true);
  });

  it("не путает обычную ошибку с исчерпанием пула", () => {
    expect(isPoolExhaustionError(new Error("Недействительный или истёкший токен"))).toBe(false);
    expect(isPoolExhaustionError({ code: "P2002" })).toBe(false);
  });
});
