import { beforeEach, describe, expect, it, vi } from "vitest";
import { clientBuildHeaders, noteServerBuild, onServerBuildChange, resetServerBuildState } from "../appVersion";

/**
 * X-App-Build в ответах API с 21.11.2026 — только ПОДСКАЗКА «загляни в
 * /version.json»: это отметка запуска процесса API, она меняется и без смены
 * фронта. Решение «вкладка устарела» здесь больше не принимается (см.
 * appUpdateFlow.test.ts — тест класса «перезапуски API не блокируют обновление»).
 */
describe("смена заголовка X-App-Build", () => {
  beforeEach(resetServerBuildState);

  it("первый увиденный заголовок — точка отсчёта, а не повод", () => {
    const listener = vi.fn();
    onServerBuildChange(listener);
    noteServerBuild("build-1");
    expect(listener).not.toHaveBeenCalled();
  });

  it("каждая новая отметка — новый повод проверить (сигнал многоразовый)", () => {
    const listener = vi.fn();
    onServerBuildChange(listener);
    noteServerBuild("build-1");
    noteServerBuild("build-2");
    noteServerBuild("build-2");
    noteServerBuild("build-3");
    expect(listener).toHaveBeenCalledTimes(2);
  });

  it("пустой заголовок игнорируется (сервер без X-App-Build)", () => {
    const listener = vi.fn();
    onServerBuildChange(listener);
    noteServerBuild("build-1");
    noteServerBuild(null);
    expect(listener).not.toHaveBeenCalled();
  });

  it("упавший подписчик не ломает разбор ответа и не мешает остальным", () => {
    const good = vi.fn();
    onServerBuildChange(() => {
      throw new Error("подписчик упал");
    });
    onServerBuildChange(good);
    noteServerBuild("build-1");
    expect(() => noteServerBuild("build-2")).not.toThrow();
    expect(good).toHaveBeenCalledTimes(1);
  });

  it("отписка снимает слушателя", () => {
    const listener = vi.fn();
    const off = onServerBuildChange(listener);
    off();
    noteServerBuild("build-1");
    noteServerBuild("build-2");
    expect(listener).not.toHaveBeenCalled();
  });
});

describe("заголовки сборки вкладки для сторожа на сервере", () => {
  it("без констант сборки (vitest) — пусто, а не undefined в заголовке", () => {
    expect(clientBuildHeaders()).toEqual({});
  });

  it("с константами — версия и момент сборки", () => {
    vi.stubGlobal("__APP_VERSION__", "abc1234");
    vi.stubGlobal("__APP_BUILT_AT__", 1_700_000_000_000);
    try {
      expect(clientBuildHeaders()).toEqual({ "X-Client-Build": "abc1234", "X-Client-Build-Time": "1700000000000" });
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
