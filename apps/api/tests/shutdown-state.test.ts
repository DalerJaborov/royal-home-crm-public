import { describe, expect, it, afterEach } from "vitest";
import {
  beginShutdown,
  drainBackgroundTasks,
  guardBackgroundFailure,
  isShuttingDown,
  trackBackgroundTask,
  __resetShutdownStateForTests,
} from "../src/lib/shutdownState.js";

/**
 * ОБЩИЙ МЕХАНИЗМ ОСТАНОВКИ (17.09.2026) — п.2 задания tooling-reliability.
 *
 * Проверяется сам хелпер в изоляции от базы: `isShuttingDown`/`beginShutdown`
 * как простой флаг процесса, `trackBackgroundTask`/`drainBackgroundTasks` как
 * механизм ожидания фоновых задач с потолком, `guardBackgroundFailure` как
 * точка решения «гонка при остановке или настоящий баг».
 */
describe("shutdownState", () => {
  afterEach(() => {
    __resetShutdownStateForTests();
  });

  it("флаг выключен по умолчанию и включается один раз", () => {
    expect(isShuttingDown()).toBe(false);
    beginShutdown();
    expect(isShuttingDown()).toBe(true);
    beginShutdown(); // повторный вызов — не ошибка, флаг остаётся true
    expect(isShuttingDown()).toBe(true);
  });

  it("guardBackgroundFailure молчит (false), пока остановка не началась", () => {
    expect(guardBackgroundFailure("тест", new Error("что угодно"))).toBe(false);
  });

  it("guardBackgroundFailure гасит ошибку при остановке и говорит вызывающему не писать дальше", () => {
    beginShutdown();
    const handled = guardBackgroundFailure("публикация живого события test", new Error("Cannot use a pool after calling end on the pool"));
    expect(handled).toBe(true);
  });

  it("drainBackgroundTasks дожидается зарегистрированных промисов до потолка", async () => {
    let resolved = false;
    const p = new Promise<void>((resolve) =>
      setTimeout(() => {
        resolved = true;
        resolve();
      }, 50)
    );
    trackBackgroundTask(p);
    await drainBackgroundTasks(2_000);
    expect(resolved).toBe(true);
  });

  it("drainBackgroundTasks не виснет дольше потолка на зависшей задаче", async () => {
    trackBackgroundTask(new Promise<void>(() => {})); // никогда не резолвится
    const started = Date.now();
    await drainBackgroundTasks(150);
    expect(Date.now() - started).toBeLessThan(1_000);
  });

  it("trackBackgroundTask не глотает отказ и не мешает вызывающему поймать его", async () => {
    const err = new Error("boom");
    const tracked = trackBackgroundTask(Promise.reject(err));
    await expect(tracked).rejects.toBe(err);
  });
});
