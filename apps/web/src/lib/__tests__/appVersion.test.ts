import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  isServerBuildStale,
  noteServerBuild,
  onServerBuildStale,
  resetServerBuildState,
} from "../appVersion";

/**
 * Самый быстрый канал «вышла новая версия» — заголовок X-App-Build в ответах
 * API. С 10.09.2026 он не опрашивается раз в 20 секунд, а проталкивается
 * подпиской в тот же миг, когда пришёл ответ: запросы в CRM идут постоянно,
 * поэтому обычно это первый из трёх сигналов.
 */
describe("расхождение сборки сервера и вкладки", () => {
  beforeEach(resetServerBuildState);

  it("первый увиденный заголовок — точка отсчёта, а не расхождение", () => {
    const listener = vi.fn();
    onServerBuildStale(listener);
    noteServerBuild("build-1");
    expect(isServerBuildStale()).toBe(false);
    expect(listener).not.toHaveBeenCalled();
  });

  it("сменился заголовок -> подписчик вызывается немедленно", () => {
    const listener = vi.fn();
    onServerBuildStale(listener);
    noteServerBuild("build-1");
    noteServerBuild("build-2");
    expect(isServerBuildStale()).toBe(true);
    expect(listener).toHaveBeenCalledTimes(1);
  });

  it("сигнал одноразовый: следующие ответы подписчика не дёргают", () => {
    const listener = vi.fn();
    onServerBuildStale(listener);
    noteServerBuild("build-1");
    noteServerBuild("build-2");
    noteServerBuild("build-3");
    expect(listener).toHaveBeenCalledTimes(1);
  });

  it("подписка ПОСЛЕ расхождения срабатывает сразу — сигнал не теряется", () => {
    noteServerBuild("build-1");
    noteServerBuild("build-2");
    const listener = vi.fn();
    onServerBuildStale(listener);
    expect(listener).toHaveBeenCalledTimes(1);
  });

  it("пустой заголовок игнорируется (сервер без X-App-Build)", () => {
    noteServerBuild("build-1");
    noteServerBuild(null);
    expect(isServerBuildStale()).toBe(false);
  });

  it("упавший подписчик не ломает разбор ответа и не мешает остальным", () => {
    const good = vi.fn();
    onServerBuildStale(() => {
      throw new Error("подписчик упал");
    });
    onServerBuildStale(good);
    noteServerBuild("build-1");
    expect(() => noteServerBuild("build-2")).not.toThrow();
    expect(good).toHaveBeenCalledTimes(1);
  });

  it("отписка снимает слушателя", () => {
    const listener = vi.fn();
    const off = onServerBuildStale(listener);
    off();
    noteServerBuild("build-1");
    noteServerBuild("build-2");
    expect(listener).not.toHaveBeenCalled();
  });
});
