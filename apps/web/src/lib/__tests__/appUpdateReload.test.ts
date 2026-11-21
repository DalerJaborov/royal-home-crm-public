import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  applyAppUpdate,
  ATTEMPT_WINDOW_MS,
  buildFreshUrl,
  clearUpdateAttempts,
  isUpdateLoopSuppressed,
  MAX_ATTEMPTS,
  noteUpdateAttempt,
  resetAttemptsIfUpdated,
  UNKNOWN_TARGET,
  updateAttemptGate,
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

describe("счётчик попыток обновления — окном и на пару сборок", () => {
  beforeEach(() => {
    installStorage();
    installWindow();
  });

  const T0 = 1_700_000_000_000;

  it("считает попытки по паре «моя сборка → сборка сервера»", () => {
    expect(noteUpdateAttempt("aaa", "bbb", T0)).toBe(1);
    expect(noteUpdateAttempt("aaa", "bbb", T0 + 1)).toBe(2);
    // вышла ещё более новая сборка — это другое обновление, счёт с нуля
    expect(noteUpdateAttempt("aaa", "ccc", T0 + 2)).toBe(1);
    // и сама вкладка уже другая — тоже с нуля
    expect(noteUpdateAttempt("zzz", "ccc", T0 + 3)).toBe(1);
  });

  it("три попытки за десять минут — передышка до освобождения окна", () => {
    noteUpdateAttempt("aaa", "bbb", T0);
    noteUpdateAttempt("aaa", "bbb", T0 + 60_000);
    expect(isUpdateLoopSuppressed("aaa", "bbb", T0 + 60_000)).toBe(false);
    noteUpdateAttempt("aaa", "bbb", T0 + 120_000);
    const gate = updateAttemptGate("aaa", "bbb", T0 + 120_000);
    expect(gate.allowed).toBe(false);
    // место освободится, когда самая старая попытка выйдет из окна
    expect(gate.retryAt).toBe(T0 + ATTEMPT_WINDOW_MS);
    expect(isUpdateLoopSuppressed("aaa", "bbb", T0 + ATTEMPT_WINDOW_MS - 1)).toBe(true);
    expect(isUpdateLoopSuppressed("aaa", "bbb", T0 + ATTEMPT_WINDOW_MS)).toBe(false);
  });

  it("блокировка навсегда невозможна: через окно пробуем снова", () => {
    for (let i = 0; i < MAX_ATTEMPTS; i += 1) noteUpdateAttempt("aaa", "bbb", T0 + i);
    expect(isUpdateLoopSuppressed("aaa", "bbb", T0 + 10)).toBe(true);
    // день спустя (Safari держит sessionStorage днями) — снова можно
    expect(isUpdateLoopSuppressed("aaa", "bbb", T0 + 24 * 60 * 60_000)).toBe(false);
  });

  it("новая сборка сервера сбрасывает счётчик", () => {
    for (let i = 0; i < MAX_ATTEMPTS; i += 1) noteUpdateAttempt("aaa", "bbb", T0 + i);
    expect(isUpdateLoopSuppressed("aaa", "bbb", T0 + 10)).toBe(true);
    expect(isUpdateLoopSuppressed("aaa", "ccc", T0 + 10)).toBe(false);
  });

  it("запись старого вида { from, count } не блокирует (миграция вечной блокировки)", () => {
    sessionStorage.setItem("rh:update-attempts", JSON.stringify({ from: "aaa", count: 3 }));
    expect(isUpdateLoopSuppressed("aaa", "bbb", T0)).toBe(false);
    expect(isUpdateLoopSuppressed("aaa", UNKNOWN_TARGET, T0)).toBe(false);
  });

  it("resetAttemptsIfUpdated чистит счётчик только при смене версии вкладки", () => {
    noteUpdateAttempt("aaa", "bbb", T0);
    resetAttemptsIfUpdated("aaa");
    expect(noteUpdateAttempt("aaa", "bbb", T0 + 1)).toBe(2);
    resetAttemptsIfUpdated("bbb");
    expect(noteUpdateAttempt("aaa", "bbb", T0 + 2)).toBe(1);
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
    const reportGiveUp = vi.fn<(message: string, details: string) => void>();
    const opts = {
      needRefresh: false,
      updateServiceWorker,
      currentVersion: "aaa",
      reload,
      navigateFresh,
      reportGiveUp,
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
    // Снимок среды собирается асинхронно, поэтому запись приходит не сразу.
    await vi.waitFor(() => expect(reportGiveUp).toHaveBeenCalledTimes(1));
    const [message, details] = reportGiveUp.mock.calls[0];
    // Слово «сдача» обязано отличаться от текста ступени 2: именно из-за
    // одинаковых фраз запись «2 попыток» в журнале 11.09 приняли за сдачу.
    expect(message).toContain("Сдача");
    expect(message).toContain("aaa");
    // Телеметрия — ОТДЕЛЬНЫМ полем, а не в error.stack (21.11.2026): iOS кладёт в
    // stack только адреса строк, и снимок терялся. Через window "error" — больше нет.
    expect(details).toContain("сборка вкладки=aaa");
    expect(window.dispatchEvent).not.toHaveBeenCalled();

    // Сдача докладывается один раз на пару: повтор по таймеру не шумит в журнал.
    expect(await applyAppUpdate(opts)).toBe("gave-up");
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(reportGiveUp).toHaveBeenCalledTimes(1);
  });

  it("в подробностях сдачи — метка версии и главный скрипт самой «/»", async () => {
    const html = '<html><head><meta name="app-version" content="site-9"><script type="module" crossorigin src="/assets/index-Ab12.js"></script></head></html>';
    vi.stubGlobal("fetch", vi.fn(async (url: string) => (String(url).startsWith("/version.json")
      ? new Response(JSON.stringify({ version: "site-9" }), { status: 200 })
      : new Response(html, { status: 200 }))));
    try {
      const reportGiveUp = vi.fn<(message: string, details: string) => void>();
      const opts = { needRefresh: false, updateServiceWorker: vi.fn(), currentVersion: "aaa", targetVersion: "site-9", reload: vi.fn(), navigateFresh: vi.fn(), reportGiveUp };
      for (let i = 0; i <= MAX_ATTEMPTS; i += 1) await applyAppUpdate(opts);
      await vi.waitFor(() => expect(reportGiveUp).toHaveBeenCalledTimes(1));
      const details = reportGiveUp.mock.calls[0][1];
      expect(details).toContain("version.json: сборка сервера=site-9");
      expect(details).toContain("«/»: код=200");
      expect(details).toContain("«/» app-version=site-9");
      expect(details).toContain("«/» скрипт=/assets/index-Ab12.js");
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("исчерпанные попытки одной цели не мешают обновиться на следующую сборку", async () => {
    const updateServiceWorker = vi.fn().mockResolvedValue(undefined);
    const reload = vi.fn();
    const navigateFresh = vi.fn();
    const base = { needRefresh: false, updateServiceWorker, currentVersion: "aaa", reload, navigateFresh };
    for (let i = 0; i < MAX_ATTEMPTS; i += 1) await applyAppUpdate({ ...base, targetVersion: "bbb" });
    expect(await applyAppUpdate({ ...base, targetVersion: "bbb" })).toBe("gave-up");
    reload.mockClear();
    expect(await applyAppUpdate({ ...base, targetVersion: "ccc" })).toBe("reload");
    expect(reload).toHaveBeenCalledTimes(1);
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
