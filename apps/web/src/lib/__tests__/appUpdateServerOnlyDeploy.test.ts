import { beforeEach, describe, expect, it, vi } from "vitest";
import { resetSiteVersionOrderForTests, startAppVersionPoll, startServerBuildWatch } from "../appUpdate";
import { noteServerBuild, resetServerBuildState } from "../appVersion";
import { applyAppUpdate, clearUpdateAttempts, isUpdateLoopSuppressed, rememberUpdateTarget } from "../appUpdateReload";
import { readUpdateTarget, useAppUpdateStore } from "../../store/appUpdate";

/**
 * ВЫКАТ ТОЛЬКО СЕРВЕРА НЕ ТРАТИТ ПОПЫТКИ ОБНОВЛЕНИЯ (21.11.2026, ревью #380).
 *
 * X-App-Build — время запуска процесса API, а не версия сайта. Раньше каждый выкат
 * одного сервера (14–15.11 их было по пять подряд) ставил «вышла новая версия»,
 * вкладка перезагружалась в ту же сборку, а после трёх таких раз глохла насовсем —
 * и настоящий выкат сайта её уже не обновлял. Путь тот же, что у UpdatePrompt:
 * сигнал → сверка version.json → стор (noteSiteVersion) → проверка заглушки и подмена,
 * обе читают цель через `readUpdateTarget`.
 */
function installEnv() {
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
    value: {
      location: { pathname: "/messages", search: "", hash: "" },
      setTimeout, clearTimeout, addEventListener: () => {}, removeEventListener: () => {},
    },
  });
  Object.defineProperty(globalThis, "document", {
    configurable: true,
    value: { hidden: false, addEventListener: () => {}, removeEventListener: () => {} },
  });
}

/** Одна «жизнь» страницы так, как её проходит UpdatePrompt (tryApply → run). */
function pageLife(spies: { reload: () => void; navigateFresh: (u: string) => void }) {
  if (isUpdateLoopSuppressed("site-1", readUpdateTarget())) return Promise.resolve("suppressed");
  return applyAppUpdate({
    needRefresh: false, updateServiceWorker: vi.fn(), currentVersion: "site-1", readTargetVersion: readUpdateTarget,
    ...spies, reportGiveUp: vi.fn(),
  });
}

const flush = async () => { for (let i = 0; i < 5; i++) await Promise.resolve(); };

describe("выкат только сервера и настоящий выкат сайта", () => {
  beforeEach(() => {
    installEnv();
    resetServerBuildState();
    resetSiteVersionOrderForTests();
    clearUpdateAttempts();
    useAppUpdateStore.getState().reset();
  });

  it("три выката сервера — ни одной перезагрузки и без заглушки; выкат сайта — обновление", async () => {
    let siteOnServer = "site-1"; // = сборка вкладки
    const spies = { reload: vi.fn(), navigateFresh: vi.fn() };
    const stop = startServerBuildWatch((v) => useAppUpdateStore.getState().noteSiteVersion(v), {
      currentVersion: "site-1",
      fetchVersion: async () => siteOnServer,
    });

    noteServerBuild("api-start-0");
    for (const start of ["api-start-1", "api-start-2", "api-start-3"]) {
      noteServerBuild(start); // перезапуск API, сайт тот же
      await flush();
      if (useAppUpdateStore.getState().staleBuild) await pageLife(spies);
    }
    expect(useAppUpdateStore.getState().staleBuild).toBe(false);
    expect(spies.reload).not.toHaveBeenCalled();
    expect(spies.navigateFresh).not.toHaveBeenCalled();
    expect(isUpdateLoopSuppressed("site-1", "site-2")).toBe(false);

    siteOnServer = "site-2"; // настоящий выкат сайта
    noteServerBuild("api-start-4");
    await flush();
    expect(useAppUpdateStore.getState().staleBuild).toBe(true);
    expect(readUpdateTarget()).toBe("site-2");
    expect(await pageLife(spies)).toBe("reload");
    stop();
  });

  it("version.json не ответил — сигнал сервера не считается новой версией сайта", async () => {
    const onStale = vi.fn();
    startServerBuildWatch(onStale, { currentVersion: "site-1", fetchVersion: async () => null });
    noteServerBuild("a");
    noteServerBuild("b");
    await flush();
    expect(onStale).not.toHaveBeenCalled();
  });

  it("ответ на ранний запрос, пришедший позже, не откатывает цель v3 → v2", async () => {
    const resolvers: Array<(v: string) => void> = [];
    const fetchVersion = () => new Promise<string | null>((resolve) => resolvers.push(resolve));
    const onStale = vi.fn((v: string) => useAppUpdateStore.getState().noteSiteVersion(v));
    startServerBuildWatch(onStale, { currentVersion: "site-1", fetchVersion });
    noteServerBuild("a");
    noteServerBuild("b"); // запрос 1
    noteServerBuild("c"); // запрос 2
    resolvers[1]("site-3"); // поздний запрос ответил первым
    await flush();
    resolvers[0]("site-2"); // ранний — следом
    await flush();
    expect(onStale.mock.calls.map((c) => c[0])).toEqual(["site-3"]);
    expect(readUpdateTarget()).toBe("site-3");
  });

  it("опрос и заголовок делят порядок: старый ответ опроса не откатывает цель", async () => {
    const resolvers: Array<(v: string) => void> = [];
    const fetchVersion = () => new Promise<string | null>((resolve) => resolvers.push(resolve));
    const onStale = vi.fn((v: string) => useAppUpdateStore.getState().noteSiteVersion(v));
    const stopPoll = startAppVersionPoll(onStale, { fetchVersion }); // запрос 1 (опрос)
    startServerBuildWatch(onStale, { currentVersion: "site-1", fetchVersion });
    noteServerBuild("a");
    noteServerBuild("b"); // запрос 2 (заголовок)
    resolvers[1]("site-3");
    await flush();
    resolvers[0]("site-2");
    await flush();
    expect(readUpdateTarget()).toBe("site-3");
    stopPoll();
  });

  it("цель, узнанная после сдачи с пустой целью, запоминается и не перезапускает лестницу", async () => {
    const spies = { reload: vi.fn(), navigateFresh: vi.fn() };
    for (let i = 0; i < 4; i++) await pageLife(spies); // цели ещё нет: ""
    useAppUpdateStore.getState().noteSiteVersion("site-2");
    rememberUpdateTarget("site-1", readUpdateTarget()); // эффект UpdatePrompt
    expect(await pageLife(spies)).toBe("suppressed");
    expect(spies.reload.mock.calls.length + spies.navigateFresh.mock.calls.length).toBe(3);
  });
});
