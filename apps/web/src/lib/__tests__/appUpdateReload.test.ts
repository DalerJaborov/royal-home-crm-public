import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  applyAppUpdate,
  buildFreshUrl,
  clearUpdateAttempts,
  isUpdateLoopSuppressed,
  noteUpdateAttempt,
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
    expect(details).toContain("«/»");
  });

  /**
   * РЕАЛЬНЫЙ ПУТЬ UpdatePrompt.tryApply (21.11.2026): сначала isUpdateLoopSuppressed,
   * потом applyAppUpdate — по разу на каждую «жизнь» страницы. Тест выше зовёт
   * applyAppUpdate в четвёртый раз напрямую и поэтому был зелёным, хотя через
   * настоящий путь сдача не доходила до журнала ни разу (проверка глушила раньше).
   */
  it("через путь UpdatePrompt сдача доходит до журнала ровно один раз", async () => {
    const reload = vi.fn();
    const navigateFresh = vi.fn();
    const branches: string[] = [];
    for (let pageLife = 0; pageLife < 6; pageLife++) {
      if (isUpdateLoopSuppressed("aaa", "site-2")) continue;
      branches.push(await applyAppUpdate({
        needRefresh: false, updateServiceWorker: vi.fn(), currentVersion: "aaa", targetVersion: "site-2", reload, navigateFresh, reportGiveUp,
      }));
    }
    expect(branches).toEqual(["reload", "hard-reset", "hard-reset", "gave-up"]);
    await vi.waitFor(() => expect(reportGiveUp).toHaveBeenCalledTimes(1));
    expect(reportGiveUp.mock.calls[0][0]).toContain("Сдача");
  });

  /**
   * СДАЧА НЕ НАВСЕГДА (ревью #380): раньше счётчик сбрасывался только сменой версии
   * самой вкладки, то есть никогда, — телефон прожил на сборке старше 17.11 до 21.11.
   */
  it("новая версия сайта на сервере снова открывает лестницу; та же — нет", async () => {
    const opts = { needRefresh: false, updateServiceWorker: vi.fn(), currentVersion: "aaa", reload: vi.fn(), navigateFresh: vi.fn(), reportGiveUp };
    for (let i = 0; i < 4; i++) await applyAppUpdate({ ...opts, targetVersion: "site-2" });
    expect(isUpdateLoopSuppressed("aaa", "site-2")).toBe(true);
    expect(isUpdateLoopSuppressed("aaa", "site-3")).toBe(false);
    expect(await applyAppUpdate({ ...opts, targetVersion: "site-3" })).toBe("reload");
  });

  it("заглушка снимается через час и без новой версии", () => {
    const t0 = 1_000_000;
    for (let i = 0; i < 4; i++) noteUpdateAttempt("aaa", "site-2", t0 + i);
    expect(isUpdateLoopSuppressed("aaa", "site-2", t0 + 10 * 60_000)).toBe(true);
    expect(isUpdateLoopSuppressed("aaa", "site-2", t0 + 61 * 60_000)).toBe(false);
    expect(noteUpdateAttempt("aaa", "site-2", t0 + 61 * 60_000)).toBe(1);
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
