import { beforeEach, describe, expect, it, vi } from "vitest";
import { startServerBuildWatch } from "../appUpdate";
import { noteServerBuild, resetServerBuildState } from "../appVersion";
import { applyAppUpdate, clearUpdateAttempts, isUpdateLoopSuppressed } from "../appUpdateReload";

/**
 * ВЫКАТ ТОЛЬКО СЕРВЕРА НЕ ТРАТИТ ПОПЫТКИ ОБНОВЛЕНИЯ (21.11.2026, ревью #380).
 *
 * X-App-Build — время запуска процесса API, а не версия сайта. Раньше каждый выкат
 * одного сервера (14–15.11 их было по пять подряд) ставил «вышла новая версия»,
 * вкладка перезагружалась в ту же сборку, а после трёх таких раз глохла насовсем —
 * и настоящий выкат сайта её уже не обновлял. Тест повторяет путь UpdatePrompt:
 * сигнал → (сверка version.json) → проверка заглушки → applyAppUpdate.
 */
function installStorage() {
  const data = new Map<string, string>();
  Object.defineProperty(globalThis, "sessionStorage", {
    configurable: true,
    value: {
      getItem: (k: string) => data.get(k) ?? null,
      setItem: (k: string, v: string) => void data.set(k, v),
      removeItem: (k: string) => void data.delete(k),
    },
  });
  Object.defineProperty(globalThis, "window", {
    configurable: true,
    value: { location: { pathname: "/messages", search: "", hash: "" } },
  });
}

describe("выкат только сервера и настоящий выкат сайта", () => {
  beforeEach(() => {
    installStorage();
    resetServerBuildState();
    clearUpdateAttempts();
  });

  it("три выката сервера — ни одной перезагрузки и без заглушки; выкат сайта — обновление", async () => {
    let siteOnServer = "site-1"; // = сборка вкладки
    const reload = vi.fn();
    const navigateFresh = vi.fn();
    const reportGiveUp = vi.fn();
    const branches: string[] = [];
    // Поведение UpdatePrompt: сигнал «новая версия сайта» → проверка заглушки → лестница.
    const onSiteVersion = async (target: string) => {
      if (isUpdateLoopSuppressed("site-1", target)) return;
      branches.push(await applyAppUpdate({
        needRefresh: false, updateServiceWorker: vi.fn(), currentVersion: "site-1", targetVersion: target, reload, navigateFresh, reportGiveUp,
      }));
    };
    const pending: Promise<void>[] = [];
    const stop = startServerBuildWatch((v) => void pending.push(onSiteVersion(v)), {
      currentVersion: "site-1",
      fetchVersion: async () => siteOnServer,
    });

    noteServerBuild("api-start-0");
    for (const start of ["api-start-1", "api-start-2", "api-start-3"]) {
      noteServerBuild(start); // перезапуск API, сайт тот же
      await Promise.resolve();
      await Promise.resolve();
    }
    await Promise.all(pending);
    expect(branches).toEqual([]);
    expect(reload).not.toHaveBeenCalled();
    expect(isUpdateLoopSuppressed("site-1", "site-2")).toBe(false);

    siteOnServer = "site-2"; // настоящий выкат сайта
    noteServerBuild("api-start-4");
    await vi.waitFor(() => expect(pending.length).toBe(1));
    await Promise.all(pending);
    expect(branches).toEqual(["reload"]);
    expect(reload).toHaveBeenCalledTimes(1);
    stop();
  });

  it("version.json не ответил — сигнал сервера не считается новой версией сайта", async () => {
    const onStale = vi.fn();
    startServerBuildWatch(onStale, { currentVersion: "site-1", fetchVersion: async () => null });
    noteServerBuild("a");
    noteServerBuild("b");
    await Promise.resolve();
    await Promise.resolve();
    expect(onStale).not.toHaveBeenCalled();
  });
});
