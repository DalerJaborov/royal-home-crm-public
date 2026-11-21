import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  applyAppUpdate,
  buildFreshUrl,
  clearUpdateAttempts,
  isUpdateLoopSuppressed,
  noteUpdateAttempt,
  rememberUpdateTarget,
  resetAttemptsIfUpdated,
} from "../appUpdateReload";

/**
 * Петля «Обновляю Royal Home…» (09.09.2026): при сигнале /version.json голая
 * перезагрузка возвращала прекешированный index.html старой сборки, и экран
 * обновления шёл по кругу. Тест закрепляет лестницу попыток — обычная
 * перезагрузка, жёсткий сброс воркера и кэшей, отказ от показа.
 */

/** Минимальный sessionStorage: окружение тестов — "node", DOM здесь нет. */
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
}

function installWindow() {
  Object.defineProperty(globalThis, "window", {
    configurable: true,
    value: {
      dispatchEvent: vi.fn(),
      location: {
        reload: vi.fn(),
        replace: vi.fn(),
        pathname: "/clients",
        search: "?tab=new",
        hash: "#top",
      },
    },
  });
  // Прогон идёт в node, где ErrorEvent нет, а модуль отправляет событие в журнал
  // только `typeof ErrorEvent !== "undefined"`. Без заглушки проверки «ушло /
  // не ушло в журнал» проходили бы обе и не значили бы ничего.
  Object.defineProperty(globalThis, "ErrorEvent", {
    configurable: true,
    value: class {
      constructor(
        readonly type: string,
        readonly init?: { message?: string; error?: Error }
      ) {}
    },
  });
}

describe("счётчик попыток обновления", () => {
  beforeEach(() => {
    installStorage();
    installWindow();
  });

  it("считает попытки по одной версии и сбрасывается на новой", () => {
    expect(noteUpdateAttempt("aaa")).toBe(1);
    expect(noteUpdateAttempt("aaa")).toBe(2);
    expect(noteUpdateAttempt("bbb")).toBe(1);
  });

  it("глушит вкладку только после сдачи (три рабочих круга + запись о сдаче)", () => {
    expect(isUpdateLoopSuppressed("aaa")).toBe(false);
    noteUpdateAttempt("aaa");
    noteUpdateAttempt("aaa");
    noteUpdateAttempt("aaa");
    // После третьего круга вызов ещё нужен: именно он пишет сдачу в журнал.
    expect(isUpdateLoopSuppressed("aaa")).toBe(false);
    noteUpdateAttempt("aaa");
    expect(isUpdateLoopSuppressed("aaa")).toBe(true);
    // другая сборка — обновление применилось, глушить нечего
    expect(isUpdateLoopSuppressed("bbb")).toBe(false);
  });

  it("resetAttemptsIfUpdated чистит счётчик только при смене версии", () => {
    noteUpdateAttempt("aaa");
    resetAttemptsIfUpdated("aaa");
    expect(noteUpdateAttempt("aaa")).toBe(2);
    resetAttemptsIfUpdated("bbb");
    expect(noteUpdateAttempt("aaa")).toBe(1);
  });
});

describe("applyAppUpdate", () => {
  const reportGiveUp = vi.fn<(message: string, details: string) => void>();
  beforeEach(() => {
    installStorage();
    installWindow();
    clearUpdateAttempts();
    reportGiveUp.mockClear();
  });

  it("при ждущем воркере идёт штатным путём SKIP_WAITING", async () => {
    const updateServiceWorker = vi.fn().mockResolvedValue(undefined);
    const reload = vi.fn();
    const branch = await applyAppUpdate({
      needRefresh: true,
      updateServiceWorker,
      currentVersion: "aaa",
      reload,
    });
    expect(branch).toBe("service-worker");
    expect(updateServiceWorker).toHaveBeenCalledWith(true);
    expect(reload).not.toHaveBeenCalled();
  });

  it("первая попытка без воркера — обычная перезагрузка, вторая — жёсткий сброс", async () => {
    const updateServiceWorker = vi.fn().mockResolvedValue(undefined);
    const reload = vi.fn();
    const navigateFresh = vi.fn();
    const opts = {
      needRefresh: false,
      updateServiceWorker,
      currentVersion: "aaa",
      reload,
      navigateFresh,
      reportGiveUp,
    };

    expect(await applyAppUpdate(opts)).toBe("reload");
    expect(reload).toHaveBeenCalledTimes(1);
    expect(navigateFresh).not.toHaveBeenCalled();

    expect(await applyAppUpdate(opts)).toBe("hard-reset");
    // Ступень 2 уходит НЕ перезагрузкой того же адреса (её ещё может обслужить
    // HTTP-кэш или bfcache), а переходом на адрес с новым параметром.
    expect(reload).toHaveBeenCalledTimes(1);
    expect(navigateFresh).toHaveBeenCalledTimes(1);
    expect(navigateFresh.mock.calls[0][0]).toContain("rh-update=");
    // Жёсткий сброс — рабочая ступень лестницы, а не поломка: в журнал ошибок
    // («Здоровье системы», утреннее уведомление директору) он не уходит.
    expect(reportGiveUp).not.toHaveBeenCalled();
  });

  it("после трёх кругов перестаёт перезагружать вкладку и шлёт сдачу с телеметрией", async () => {
    const reload = vi.fn();
    const navigateFresh = vi.fn();
    const opts = { needRefresh: false, updateServiceWorker: vi.fn(), currentVersion: "aaa", reload, navigateFresh, reportGiveUp };

    await applyAppUpdate(opts); // 1 — reload
    await applyAppUpdate(opts); // 2 — hard-reset
    await applyAppUpdate(opts); // 3 — hard-reset
    reload.mockClear();
    navigateFresh.mockClear();

    expect(await applyAppUpdate(opts)).toBe("gave-up");
    expect(reload).not.toHaveBeenCalled();
    expect(navigateFresh).not.toHaveBeenCalled();
    // Сдача — настоящая поломка: обязана попасть в журнал. Снимок среды собирается асинхронно.
    await vi.waitFor(() => expect(reportGiveUp).toHaveBeenCalledTimes(1));
    const [message, details] = reportGiveUp.mock.calls[0];
    // Слово «сдача» отличается от текста ступени 2: из-за одинаковых фраз запись
    // «2 попыток» в журнале 11.09 приняли за сдачу.
    expect(message).toContain("Сдача");
    expect(message).toContain("aaa");
    // Снимок среды — отдельным полем, а не в error.stack: iOS кладёт туда только адреса.
    expect(details).toContain("сборка вкладки=aaa");
  });

  it("в подробностях сдачи — метка версии и главный скрипт самой «/»", async () => {
    const html = '<html><head><meta name="app-version" content="site-9"><script type="module" crossorigin src="/assets/index-Ab12.js"></script></head></html>';
    vi.stubGlobal("fetch", vi.fn(async (url: string) => (String(url).startsWith("/version.json")
      ? new Response(JSON.stringify({ version: "site-9" }), { status: 200 })
      : new Response(html, { status: 200 }))));
    try {
      const opts = { needRefresh: false, updateServiceWorker: vi.fn(), currentVersion: "aaa", reload: vi.fn(), navigateFresh: vi.fn(), reportGiveUp };
      for (let i = 0; i < 4; i++) await applyAppUpdate(opts);
      await vi.waitFor(() => expect(reportGiveUp).toHaveBeenCalledTimes(1));
      const details = reportGiveUp.mock.calls[0][1];
      expect(details).toContain("version.json: сборка сервера=site-9");
      expect(details).toContain("«/» app-version=site-9");
      expect(details).toContain("«/» скрипт=/assets/index-Ab12.js");
    } finally {
      vi.unstubAllGlobals();
    }
  });

  /**
   * РЕАЛЬНЫЙ ПУТЬ UpdatePrompt (21.11.2026): проверка заглушки `isUpdateLoopSuppressed(v,
   * readUpdateTarget())` в tryApply и подмена `applyAppUpdate({ readTargetVersion:
   * readUpdateTarget })` в run — по разу на «жизнь» страницы, цель читается ДВАЖДЫ тем же
   * чтением, что у компонента (store/appUpdate.ts). Между чтениями цель может смениться.
   */
  function pageLife(readTarget: () => string, spies: { reload: () => void; navigateFresh: (u: string) => void }) {
    if (isUpdateLoopSuppressed("aaa", readTarget())) return Promise.resolve("suppressed");
    return applyAppUpdate({ needRefresh: false, updateServiceWorker: vi.fn(), currentVersion: "aaa", readTargetVersion: readTarget, ...spies, reportGiveUp });
  }

  it("через путь UpdatePrompt сдача доходит до журнала ровно один раз", async () => {
    const reload = vi.fn();
    const navigateFresh = vi.fn();
    const branches: string[] = [];
    for (let i = 0; i < 6; i++) branches.push(await pageLife(() => "site-2", { reload, navigateFresh }));
    expect(branches.filter((b) => b !== "suppressed")).toEqual(["reload", "hard-reset", "hard-reset", "gave-up"]);
    await vi.waitFor(() => expect(reportGiveUp).toHaveBeenCalledTimes(1));
    expect(reportGiveUp.mock.calls[0][0]).toContain("Сдача");
  });

  /**
   * БЛОКЕР ПОВТОРНОГО РЕВЬЮ (ревью #380): ждущий воркер приходит раньше ответа
   * version.json, и цель между двумя чтениями то "", то "site-2". Когда "" считалась
   * отдельной лестницей, каждая смена обнуляла счётчик — перезагрузка на каждое открытие.
   */
  it("смесь пустой и известной цели за 20 жизней страницы — не больше трёх перезагрузок", async () => {
    const reload = vi.fn();
    const navigateFresh = vi.fn();
    let reads = 0;
    const readTarget = () => (reads++ % 3 === 0 ? "" : "site-2");
    for (let i = 0; i < 20; i++) await pageLife(readTarget, { reload, navigateFresh });
    expect(reload.mock.calls.length + navigateFresh.mock.calls.length).toBeLessThanOrEqual(3);
    await vi.waitFor(() => expect(reportGiveUp).toHaveBeenCalledTimes(1));
  });

  it("сдача при неизвестной цели не открывает лестницу на ту же цель, узнанную позже", async () => {
    const spies = { reload: vi.fn(), navigateFresh: vi.fn() };
    for (let i = 0; i < 4; i++) await pageLife(() => "", spies);
    rememberUpdateTarget("aaa", "site-2"); // version.json наконец ответил
    expect(isUpdateLoopSuppressed("aaa", "site-2")).toBe(true);
    expect(isUpdateLoopSuppressed("aaa", "site-3")).toBe(false); // а вот новый выкат сайта — да
  });

  it("новая известная версия сайта снова открывает лестницу; та же — нет, и таймером тоже нет", async () => {
    const spies = { reload: vi.fn(), navigateFresh: vi.fn() };
    for (let i = 0; i < 4; i++) await pageLife(() => "site-2", spies);
    expect(isUpdateLoopSuppressed("aaa", "site-2")).toBe(true);
    expect(isUpdateLoopSuppressed("aaa", "")).toBe(true);
    expect(isUpdateLoopSuppressed("aaa", "site-3")).toBe(false);
    expect(await pageLife(() => "site-3", spies)).toBe("reload");
  });
});

describe("buildFreshUrl", () => {
  it("добавляет метку обхода кэша, сохраняя путь, параметры и якорь", () => {
    const url = buildFreshUrl({ pathname: "/clients", search: "?tab=new", hash: "#top" });
    expect(url.startsWith("/clients?")).toBe(true);
    expect(url).toContain("tab=new");
    expect(url).toContain("rh-update=");
    expect(url.endsWith("#top")).toBe(true);
  });

  it("не плодит второй параметр при повторном сбросе", () => {
    const once = buildFreshUrl({ pathname: "/", search: "?rh-update=1", hash: "" });
    expect(once.match(/rh-update=/g)).toHaveLength(1);
  });
});
