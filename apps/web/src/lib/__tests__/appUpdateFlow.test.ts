import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MAX_WORK_DEFER_MS, useAppUpdateStore } from "../../store/appUpdate";
import { checkAppVersionNow, startAppVersionPoll, startServiceWorkerUpdatePoll, SW_UPDATE_IDLE_MS, SW_UPDATE_TICK_MS } from "../appUpdate";
import { runUpdateStep, RETRY_WHILE_BUSY_MS } from "../appUpdateFlow";
import { applyAppUpdate, ATTEMPT_WINDOW_MS, MAX_ATTEMPTS, noteUpdateAttempt, resetGiveUpReportsForTests } from "../appUpdateReload";
import { noteServerBuild, onServerBuildChange, resetServerBuildState } from "../appVersion";

/**
 * ТЕСТ КЛАССА «вкладка застряла на старой сборке» (21.11.2026, iPhone владельца:
 * сутки на старом интерфейсе, «Страница не найдена» на новом разделе).
 *
 * Механизм поломки: X-App-Build — отметка запуска API, а не версия фронта. Три
 * перезапуска API без смены фронта = три бессмысленные перезагрузки = счётчик
 * попыток исчерпан = настоящее обновление больше не применялось никогда, и на
 * экране не было ничего. Здесь закреплено, что ни одно звено этой цепочки
 * больше не срабатывает — проверка идёт через те же модули, что и в браузере
 * (appVersion → appUpdate → стор → appUpdateFlow → appUpdateReload), без React.
 */

const MY_BUILD = "v1";
const T0 = 1_700_000_000_000;

function installBrowserStubs() {
  const data = new Map<string, string>();
  vi.stubGlobal("sessionStorage", {
    getItem: (k: string) => data.get(k) ?? null,
    setItem: (k: string, v: string) => void data.set(k, v),
    removeItem: (k: string) => void data.delete(k),
  });
  const target = new EventTarget();
  vi.stubGlobal("window", {
    setTimeout: (fn: () => void, ms?: number) => setTimeout(fn, ms),
    clearTimeout: (id?: ReturnType<typeof setTimeout>) => clearTimeout(id),
    addEventListener: target.addEventListener.bind(target),
    removeEventListener: target.removeEventListener.bind(target),
    dispatchEvent: target.dispatchEvent.bind(target),
  });
  vi.stubGlobal("document", {
    hidden: false,
    visibilityState: "visible",
    addEventListener: () => {},
    removeEventListener: () => {},
  });
}

/** /version.json, который отдаёт сервер: меняем по ходу теста. */
let serverFrontVersion = MY_BUILD;
const fetchMock = vi.fn(async () => ({ ok: true, json: async () => ({ version: serverFrontVersion }) }));

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

function step(overrides: Partial<Parameters<typeof runUpdateStep>[0]> = {}) {
  return runUpdateStep({
    currentVersion: MY_BUILD,
    workBusy: false,
    userTyping: () => false,
    mutationInFlight: () => false,
    now: Date.now(),
    ...overrides,
  });
}

describe("перезапуски API не блокируют настоящее обновление", () => {
  let stopPoll: () => void = () => {};
  let offHint: () => void = () => {};

  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(T0);
    installBrowserStubs();
    vi.stubGlobal("fetch", fetchMock);
    fetchMock.mockClear();
    serverFrontVersion = MY_BUILD;
    resetServerBuildState();
    useAppUpdateStore.getState().reset();
    // Та же проводка, что в UpdatePrompt.tsx.
    offHint = onServerBuildChange(checkAppVersionNow);
    stopPoll = startAppVersionPoll((v) => useAppUpdateStore.getState().setServerVersion(v, MY_BUILD));
  });

  afterEach(() => {
    stopPoll();
    offHint();
    useAppUpdateStore.getState().reset();
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("три смены X-App-Build без смены фронта: ни попытки, ни блокировки; потом настоящее обновление применяется", async () => {
    await flush(); // первая проверка при старте опроса
    noteServerBuild("api-start-1");
    for (const mark of ["api-start-2", "api-start-3", "api-start-4"]) {
      vi.setSystemTime(Date.now() + 5_000); // за пределом склейки проверок
      noteServerBuild(mark);
      await flush();
      expect(step()).toEqual({ retryInMs: null, flushWork: false });
    }
    // Каждая смена отметки сходила в /version.json — это и есть подсказка.
    expect(fetchMock).toHaveBeenCalledTimes(4);
    const state = useAppUpdateStore.getState();
    expect(state.staleBuild).toBe(false);
    expect(state.applying).toBe(false);
    expect(state.blocked).toBe(false);
    expect(sessionStorage.getItem("rh:update-attempts")).toBeNull();

    // Настоящий выкат фронта.
    serverFrontVersion = "v2";
    vi.setSystemTime(Date.now() + 5_000);
    noteServerBuild("api-start-5");
    await flush();
    expect(useAppUpdateStore.getState().serverVersion).toBe("v2");
    expect(step().retryInMs).toBeNull();
    expect(useAppUpdateStore.getState().applying).toBe(true);
    expect(useAppUpdateStore.getState().blocked).toBe(false);
  });

  it("после трёх неудачных попыток — плашка и повтор, когда окно освободится", async () => {
    serverFrontVersion = "v2";
    await flush(); // проверка при старте опроса (ещё «v2» не видела бы склейку)
    vi.setSystemTime(T0 + 5_000);
    checkAppVersionNow();
    await flush();
    for (let i = 0; i < MAX_ATTEMPTS; i += 1) noteUpdateAttempt(MY_BUILD, "v2", T0 + i);
    const result = step({ now: T0 + 10 });
    expect(useAppUpdateStore.getState().blocked).toBe(true);
    expect(useAppUpdateStore.getState().applying).toBe(false);
    expect(result.retryInMs).toBe(ATTEMPT_WINDOW_MS - 10);
    // Окно прошло — пробуем сами, без нажатия.
    expect(step({ now: T0 + ATTEMPT_WINDOW_MS }).retryInMs).toBeNull();
    expect(useAppUpdateStore.getState().applying).toBe(true);
  });

  it("новая сборка сервера сбрасывает счётчик", async () => {
    serverFrontVersion = "v2";
    await flush(); // проверка при старте опроса (ещё «v2» не видела бы склейку)
    vi.setSystemTime(T0 + 5_000);
    checkAppVersionNow();
    await flush();
    for (let i = 0; i < MAX_ATTEMPTS; i += 1) noteUpdateAttempt(MY_BUILD, "v2", T0 + i);
    step({ now: T0 + 10 });
    expect(useAppUpdateStore.getState().blocked).toBe(true);

    serverFrontVersion = "v3";
    vi.setSystemTime(T0 + 60_000);
    checkAppVersionNow();
    await flush();
    expect(useAppUpdateStore.getState().serverVersion).toBe("v3");
    expect(step({ now: T0 + 60_000 }).retryInMs).toBeNull();
    expect(useAppUpdateStore.getState().applying).toBe(true);
  });

  it("откат выката (сервер снова на нашей сборке) гасит сигнал и плашку", async () => {
    serverFrontVersion = "v2";
    await flush(); // проверка при старте опроса (ещё «v2» не видела бы склейку)
    vi.setSystemTime(T0 + 5_000);
    checkAppVersionNow();
    await flush();
    for (let i = 0; i < MAX_ATTEMPTS; i += 1) noteUpdateAttempt(MY_BUILD, "v2", T0 + i);
    step({ now: T0 + 10 });
    expect(useAppUpdateStore.getState().blocked).toBe(true);

    serverFrontVersion = MY_BUILD;
    vi.setSystemTime(T0 + 60_000);
    checkAppVersionNow();
    await flush();
    const state = useAppUpdateStore.getState();
    expect(state.staleBuild).toBe(false);
    expect(state.blocked).toBe(false);
  });
});

/**
 * ДОКЛАД О СДАЧЕ — ТЕМ ПУТЁМ, ЧТО В БРАУЗЕРЕ (22.11.2026, ревью #381). При закрытом
 * окне runUpdateStep включает плашку и applyAppUpdate не зовёт; доклад жил только в
 * applyAppUpdate и потому не уходил никогда. «Жизнь» страницы здесь — как в
 * UpdatePrompt: новый стор, version.json сказал «v2», шаг решения, подмена.
 */
describe("сдача докладывается из шага решения", () => {
  beforeEach(() => {
    installBrowserStubs();
    vi.stubGlobal("window", { ...window, location: { pathname: "/messages", search: "", hash: "" } });
    vi.stubGlobal("fetch", vi.fn(async () => { throw new Error("нет сети в тесте"); }));
    useAppUpdateStore.getState().reset();
    resetGiveUpReportsForTests();
  });
  afterEach(() => {
    useAppUpdateStore.getState().reset();
    vi.unstubAllGlobals();
  });

  async function pageLife(now: number, reportGiveUp: (m: string, d: string) => boolean | Promise<boolean>, spies: { reload: () => void; navigateFresh: (u: string) => void }) {
    const store = useAppUpdateStore.getState();
    store.reset();
    store.setServerVersion("v2", MY_BUILD);
    step({ now, reportGiveUp });
    if (!useAppUpdateStore.getState().applying) return "blocked";
    return applyAppUpdate({ needRefresh: false, updateServiceWorker: vi.fn(), currentVersion: MY_BUILD, targetVersion: "v2", now, reportGiveUp, ...spies });
  }

  it("шесть открытий: reload, сброс, сброс, плашка — ровно одна запись о сдаче", async () => {
    const reportGiveUp = vi.fn(async (_message: string, _details: string) => true);
    const spies = { reload: vi.fn(), navigateFresh: vi.fn() };
    const branches: string[] = [];
    for (let i = 0; i < 6; i += 1) {
      branches.push(await pageLife(T0 + i * 1_000, reportGiveUp, spies));
      await flush();
    }
    expect(branches).toEqual(["reload", "hard-reset", "hard-reset", "blocked", "blocked", "blocked"]);
    await vi.waitFor(() => expect(reportGiveUp).toHaveBeenCalledTimes(1));
    expect(reportGiveUp.mock.calls[0][0]).toContain("Сдача");
    expect(reportGiveUp.mock.calls[0][0]).toContain("(сервер: v2)");
  });

  it("запись не принята (сессия ещё не восстановлена) — доложит в следующий раз", async () => {
    const reportGiveUp = vi.fn<(m: string, d: string) => Promise<boolean>>()
      .mockResolvedValueOnce(false)
      .mockResolvedValue(true);
    const spies = { reload: vi.fn(), navigateFresh: vi.fn() };
    for (let i = 0; i < 3; i += 1) await pageLife(T0 + i * 1_000, reportGiveUp, spies);
    await pageLife(T0 + 4_000, reportGiveUp, spies);
    await vi.waitFor(() => expect(reportGiveUp).toHaveBeenCalledTimes(1));
    await flush();
    await pageLife(T0 + 5_000, reportGiveUp, spies);
    await vi.waitFor(() => expect(reportGiveUp).toHaveBeenCalledTimes(2));
    await flush();
    await pageLife(T0 + 6_000, reportGiveUp, spies);
    await flush();
    expect(reportGiveUp).toHaveBeenCalledTimes(2);
  });
});

describe("потолок ожидания долгой работы", () => {
  beforeEach(() => {
    installBrowserStubs();
    useAppUpdateStore.getState().reset();
    useAppUpdateStore.getState().setServerVersion("v2", MY_BUILD);
  });
  afterEach(() => {
    useAppUpdateStore.getState().reset();
    vi.unstubAllGlobals();
  });

  it("идёт загрузка — ждём, но не дольше 15 минут; потом досохраняем и обновляемся", () => {
    expect(step({ workBusy: true, now: T0 })).toEqual({ retryInMs: RETRY_WHILE_BUSY_MS, flushWork: false });
    expect(step({ workBusy: true, now: T0 + MAX_WORK_DEFER_MS - 1 }).retryInMs).toBe(RETRY_WHILE_BUSY_MS);
    expect(useAppUpdateStore.getState().applying).toBe(false);
    // Потолок вышел: печатающего человека больше не ждём (форма мастера держала
    // бы вкладку дальше), работе даём досохраниться.
    const forced = step({ workBusy: true, userTyping: () => true, now: T0 + MAX_WORK_DEFER_MS });
    expect(forced).toEqual({ retryInMs: null, flushWork: true });
    expect(useAppUpdateStore.getState().applying).toBe(true);
  });

  it("работа закончилась — отсчёт потолка начинается заново", () => {
    step({ workBusy: true, now: T0 });
    step({ workBusy: false, userTyping: () => true, now: T0 + 1_000 });
    expect(useAppUpdateStore.getState().workBusySince).toBeNull();
    expect(step({ workBusy: true, now: T0 + MAX_WORK_DEFER_MS }).retryInMs).toBe(RETRY_WHILE_BUSY_MS);
  });

  it("запрос в полёте ждём даже после потолка — это секунды", () => {
    step({ workBusy: true, now: T0 });
    const result = step({ workBusy: true, mutationInFlight: () => true, now: T0 + MAX_WORK_DEFER_MS });
    expect(result.retryInMs).toBe(RETRY_WHILE_BUSY_MS);
    expect(useAppUpdateStore.getState().applying).toBe(false);
  });
});

describe("проводка в UpdatePrompt.tsx (тест выше повторяет её — сверяем, что она та же)", () => {
  it("X-App-Build только будит проверку /version.json и сам вкладку устаревшей не объявляет", async () => {
    const { readFileSync } = await import("node:fs");
    const { fileURLToPath } = await import("node:url");
    const source = readFileSync(fileURLToPath(new URL("../../components/UpdatePrompt.tsx", import.meta.url)), "utf8");
    expect(source).toContain("onServerBuildChange(checkAppVersionNow)");
    expect(source).toContain("setServerVersion(version, __APP_VERSION__)");
    expect(source).not.toMatch(/setStaleBuild\s*\(\s*true/);
    expect(source).toContain("runUpdateStep(");
  });
});

describe("сдача не сжигает отсрочку занятого человека (ревью #379)", () => {
  beforeEach(() => {
    installBrowserStubs();
    useAppUpdateStore.getState().reset();
    useAppUpdateStore.getState().setServerVersion("v2", MY_BUILD);
  });
  afterEach(() => {
    useAppUpdateStore.getState().reset();
    vi.unstubAllGlobals();
  });

  it("после finishApply повтор через 10 минут не перезагружает посреди набора", () => {
    // человек печатал, ждали больше пяти минут — подмена началась
    step({ userTyping: () => true, now: T0 });
    step({ userTyping: () => true, now: T0 + 6 * 60_000 });
    expect(useAppUpdateStore.getState().applying).toBe(true);
    // подмена не состоялась (сдача / страница не ушла)
    useAppUpdateStore.getState().finishApply();
    expect(useAppUpdateStore.getState().deferStart).toBeNull();
    // через десять минут человек снова печатает — ждём, а не рвём набор
    expect(step({ userTyping: () => true, now: T0 + 16 * 60_000 }).retryInMs).toBe(RETRY_WHILE_BUSY_MS);
    expect(useAppUpdateStore.getState().applying).toBe(false);
  });
});

describe("перепроверка sw.js — экономно на телефоне (ревью #379)", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.stubGlobal("document", { visibilityState: "visible" });
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("новой сборки не видно — раз в десять минут; видно — каждую минуту", () => {
    const update = vi.fn(async () => undefined);
    const registration = { update, installing: null } as unknown as ServiceWorkerRegistration;
    let stale = false;
    const stop = startServiceWorkerUpdatePoll(() => registration, () => stale, { now: () => Date.now() });
    vi.advanceTimersByTime(SW_UPDATE_IDLE_MS - SW_UPDATE_TICK_MS);
    expect(update).not.toHaveBeenCalled();
    vi.advanceTimersByTime(SW_UPDATE_TICK_MS);
    expect(update).toHaveBeenCalledTimes(1);
    stale = true;
    vi.advanceTimersByTime(3 * SW_UPDATE_TICK_MS);
    expect(update).toHaveBeenCalledTimes(4);
    stop();
  });

  it("вкладка в фоне — не дёргаем вовсе", () => {
    vi.stubGlobal("document", { visibilityState: "hidden" });
    const update = vi.fn(async () => undefined);
    const stop = startServiceWorkerUpdatePoll(() => ({ update, installing: null }) as unknown as ServiceWorkerRegistration, () => true);
    vi.advanceTimersByTime(5 * SW_UPDATE_TICK_MS);
    expect(update).not.toHaveBeenCalled();
    stop();
  });
});
