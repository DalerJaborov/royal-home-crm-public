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

  it("глушит оверлей после трёх безуспешных кругов", () => {
    expect(isUpdateLoopSuppressed("aaa")).toBe(false);
    noteUpdateAttempt("aaa");
    noteUpdateAttempt("aaa");
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
  beforeEach(() => {
    installStorage();
    installWindow();
    clearUpdateAttempts();
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
    expect(window.dispatchEvent).not.toHaveBeenCalled();
  });

  it("после трёх кругов перестаёт перезагружать вкладку и шлёт сдачу с телеметрией", async () => {
    const updateServiceWorker = vi.fn().mockResolvedValue(undefined);
    const reload = vi.fn();
    const navigateFresh = vi.fn();
    const opts = {
      needRefresh: false,
      updateServiceWorker,
      currentVersion: "aaa",
      reload,
      navigateFresh,
    };

    await applyAppUpdate(opts); // 1 — reload
    await applyAppUpdate(opts); // 2 — hard-reset
    await applyAppUpdate(opts); // 3 — hard-reset
    reload.mockClear();
    navigateFresh.mockClear();

    expect(await applyAppUpdate(opts)).toBe("gave-up");
    expect(reload).not.toHaveBeenCalled();
    expect(navigateFresh).not.toHaveBeenCalled();
    // А вот сдача — настоящая поломка: она обязана попасть в журнал ошибок.
    // Снимок среды собирается асинхронно, поэтому событие приходит не сразу.
    await vi.waitFor(() => expect(window.dispatchEvent).toHaveBeenCalledTimes(1));

    const event = (window.dispatchEvent as unknown as { mock: { calls: [{ init?: { message?: string; error?: Error } }][] } })
      .mock.calls[0][0];
    // Слово «сдача» обязано отличаться от текста ступени 2: именно из-за
    // одинаковых фраз запись «2 попыток» в журнале 11.09 приняли за сдачу.
    expect(event.init?.message).toContain("Сдача");
    expect(event.init?.message).toContain("aaa");
    // Телеметрия едет в error.stack (errorReporter читает именно его), а не в
    // в message: message служит ключом дедупликации.
    expect(event.init?.error?.message).toContain("сборка вкладки=aaa");
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
