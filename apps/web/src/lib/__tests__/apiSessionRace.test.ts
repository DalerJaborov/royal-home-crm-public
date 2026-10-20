import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Сессия в вебе: гонки refresh/выход/вход и потолки ожидания (аудит Codex
 * 04.10.2026, пакет П1: №1, №14, №15 и вторая дыра №2).
 *
 * Стор настоящий (на нём и стоит защита — счётчик эпохи сессии), заглушены только
 * его соседи по импортам: кэш запросов, снимок на диске, localStorage (в этом
 * окружении его нет, environment: "node").
 */
// Хранилище должно появиться ДО импорта стора (persist читает localStorage при создании).
const lsStore = vi.hoisted(() => {
  const m = new Map<string, string>();
  (globalThis as { localStorage?: unknown }).localStorage = {
    getItem: (k: string) => m.get(k) ?? null,
    setItem: (k: string, v: string) => void m.set(k, v),
    removeItem: (k: string) => void m.delete(k),
  };
  return m;
});
vi.mock("../queryClient", () => ({ queryClient: { clear: vi.fn(), invalidateQueries: vi.fn() } }));
vi.mock("../queryPersist", () => ({ clearPersistedQueryCache: vi.fn(async () => {}) }));
vi.mock("../pendingMapPin", () => ({ clearPendingMapPin: vi.fn() }));
vi.mock("../deviceId", () => ({ getOrCreateDeviceId: () => "test-device" }));
vi.mock("../signOut", () => ({ signOut: vi.fn(async () => {}) }));

import { useAuthStore } from "../../store/auth";
import { signOut } from "../signOut";
import { api, didRefreshFailOffline, refreshAccessToken } from "../api";
import { saveDraftBeforeUpdate, consumeDraftBeforeUpdate, subscribeDraftBeforeUpdate } from "../draftBeforeUpdate";

const A = { id: "agent-A", fullName: "А", phone: "+992900000001", role: "AGENT" as const };
const B = { id: "agent-B", fullName: "Б", phone: "+992900000002", role: "AGENT" as const };

function deferred<T>() {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function refreshOk(accessToken: string, agent: typeof A) {
  return {
    ok: true,
    status: 200,
    headers: { get: () => null },
    json: async () => ({ accessToken, agent }),
  } as unknown as Response;
}

const refresh401 = () =>
  ({ ok: false, status: 401, headers: { get: () => null }, json: async () => ({}) }) as unknown as Response;

const fetchMock = vi.fn();

/** Этот тест сам завершает «висящие» промисы, не дожидаясь их: ждать нечего. */
async function settle(p: Promise<unknown>) {
  let outcome: { ok?: unknown; err?: unknown } | "pending" = "pending";
  p.then(
    (v) => (outcome = { ok: v }),
    (e) => (outcome = { err: e })
  );
  return () => outcome;
}

beforeEach(() => {
  lsStore.clear();
  fetchMock.mockReset();
  vi.stubGlobal("fetch", fetchMock);
  vi.mocked(signOut).mockClear();
  useAuthStore.getState().logout();
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("№1: запоздавший refresh аккаунта А не трогает сессию Б", () => {
  it("ответ А после «выход, вход Б» отбрасывается: токен и личность Б целы, вернулся null", async () => {
    useAuthStore.getState().setSession(A, "tokA-old");
    const gate = deferred<Response>();
    fetchMock.mockReturnValueOnce(gate.promise);

    const p = refreshAccessToken();
    useAuthStore.getState().logout();
    useAuthStore.getState().setSession(B, "tokB");
    gate.resolve(refreshOk("tokA", A));

    expect(await p).toBeNull();
    const s = useAuthStore.getState();
    expect(s.accessToken).toBe("tokB");
    expect(s.agent?.id).toBe("agent-B");
  });

  it("запоздавший 401 для А не разлогинивает Б", async () => {
    useAuthStore.getState().setSession(A, "tokA-old");
    const gate = deferred<Response>();
    fetchMock.mockReturnValueOnce(gate.promise);

    const p = refreshAccessToken();
    useAuthStore.getState().logout();
    useAuthStore.getState().setSession(B, "tokB");
    gate.resolve(refresh401());

    expect(await p).toBeNull();
    expect(signOut).not.toHaveBeenCalled();
    expect(useAuthStore.getState().hasSession).toBe(true);
    expect(useAuthStore.getState().agent?.id).toBe("agent-B");
  });

  it("refresh Б не присоединяется к чужому, ещё летящему refresh А", async () => {
    useAuthStore.getState().setSession(A, "tokA-old");
    const gateA = deferred<Response>();
    fetchMock.mockReturnValueOnce(gateA.promise);
    const pA = refreshAccessToken();

    useAuthStore.getState().logout();
    useAuthStore.getState().setSession(B, "tokB-old");
    fetchMock.mockReturnValueOnce(Promise.resolve(refreshOk("tokB-new", B)));
    const pB = refreshAccessToken();

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(await pB).toBe("tokB-new");
    gateA.resolve(refreshOk("tokA", A));
    expect(await pA).toBeNull();
    expect(useAuthStore.getState().accessToken).toBe("tokB-new");
  });

  it("обычное продление токена того же агента по-прежнему пишет токен в стор", async () => {
    useAuthStore.getState().setSession(A, "tokA-old");
    fetchMock.mockResolvedValueOnce(refreshOk("tokA-new", A));
    expect(await refreshAccessToken()).toBe("tokA-new");
    expect(useAuthStore.getState().accessToken).toBe("tokA-new");
  });
});

describe("№14: зависший refresh не держит приложение вечно", () => {
  it("по таймауту refresh обрывается: null, «нет связи», следующий вызов идёт новым запросом", async () => {
    vi.useFakeTimers();
    useAuthStore.getState().setSession(A, "tokA-old");
    fetchMock.mockImplementation(
      (_url: string, init?: RequestInit) =>
        new Promise((_res, rej) => {
          init?.signal?.addEventListener("abort", () => rej(new DOMException("", "AbortError")));
        })
    );

    const result = await settle(refreshAccessToken());
    await vi.advanceTimersByTimeAsync(25_000);
    expect(result()).toEqual({ ok: null });
    expect(didRefreshFailOffline()).toBe(true);

    void refreshAccessToken();
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("таймер держится и пока читается тело ответа refresh", async () => {
    vi.useFakeTimers();
    useAuthStore.getState().setSession(A, "tokA-old");
    fetchMock.mockImplementation((_url: string, init?: RequestInit) => {
      const stream = new ReadableStream({
        start(controller) {
          init?.signal?.addEventListener("abort", () => controller.error(new DOMException("", "AbortError")));
        },
      });
      return Promise.resolve(new Response(stream, { status: 200 }));
    });

    const result = await settle(refreshAccessToken());
    await vi.advanceTimersByTimeAsync(25_000);
    expect(result()).toEqual({ ok: null });
    expect(didRefreshFailOffline()).toBe(true);
  });
});

describe("№15: потолок ожидания действует и на чтение тела ответа", () => {
  it("тело, которое не закрывается, обрывается по таймеру текстом про «Связь пропала»", async () => {
    vi.useFakeTimers();
    useAuthStore.getState().setSession(A, "tokA");
    fetchMock.mockImplementation((_url: string, init?: RequestInit) => {
      const stream = new ReadableStream({
        start(controller) {
          init?.signal?.addEventListener("abort", () => controller.error(new DOMException("", "AbortError")));
        },
      });
      return Promise.resolve(new Response(stream, { status: 200 }));
    });

    const result = await settle(api("/clients"));
    await vi.advanceTimersByTimeAsync(30_000);
    const out = result();
    expect(out).not.toBe("pending");
    expect(String((out as { err?: Error }).err?.message)).toMatch(/Связь пропала/);
  });

  it("скачивание файла: пока идут данные, таймер простоя не обрывает загрузку", async () => {
    vi.useFakeTimers();
    useAuthStore.getState().setSession(A, "tokA");
    let ctrl!: ReadableStreamDefaultController<Uint8Array>;
    fetchMock.mockImplementation((_url: string, init?: RequestInit) => {
      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          ctrl = controller;
          init?.signal?.addEventListener("abort", () => controller.error(new DOMException("", "AbortError")));
        },
      });
      return Promise.resolve(new Response(stream, { status: 200, headers: { "Content-Type": "application/zip" } }));
    });

    const result = await settle(api<Blob>("/properties/1/photos/archive.zip", { responseType: "blob" }));
    // 5 кусков с паузой 100 c между ними: суммарно 500 c, что куда дольше общего
    // потолка 120 c, но простоя между кусками нет.
    for (let i = 0; i < 5; i++) {
      await vi.advanceTimersByTimeAsync(100_000);
      ctrl.enqueue(new Uint8Array([1, 2, 3]));
    }
    await vi.advanceTimersByTimeAsync(0);
    ctrl.close();
    await vi.advanceTimersByTimeAsync(0);
    const out = result() as { ok?: Blob };
    expect(out).not.toBe("pending");
    expect(out.ok?.size).toBe(15);
  });

  it("скачивание файла: полная тишина дольше потолка простоя обрывается", async () => {
    vi.useFakeTimers();
    useAuthStore.getState().setSession(A, "tokA");
    fetchMock.mockImplementation((_url: string, init?: RequestInit) => {
      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          init?.signal?.addEventListener("abort", () => controller.error(new DOMException("", "AbortError")));
        },
      });
      return Promise.resolve(new Response(stream, { status: 200 }));
    });

    const result = await settle(api<Blob>("/properties/1/photos/archive.zip", { responseType: "blob" }));
    await vi.advanceTimersByTimeAsync(130_000);
    const out = result();
    expect(out).not.toBe("pending");
    expect(String((out as { err?: Error }).err?.message)).toMatch(/Связь пропала/);
  });
});

describe("№2 (вторая дыра): запись А не уходит токеном Б после refresh", () => {
  it("expectAgentId: после 401 и refresh под другим аккаунтом запрос не повторяется", async () => {
    useAuthStore.getState().setSession(A, "tokA");
    const first = deferred<Response>();
    fetchMock.mockImplementation((url: string) => {
      if (url.endsWith("/auth/refresh")) return Promise.resolve(refreshOk("tokB-new", B));
      return first.promise;
    });

    const p = api("/clients", { method: "POST", body: { n: 1 }, expectAgentId: "agent-A" });
    // Ответ 401 приходит, когда А уже вышел и вошёл Б.
    useAuthStore.getState().logout();
    useAuthStore.getState().setSession(B, "tokB");
    first.resolve({ ok: false, status: 401, headers: { get: () => null }, text: async () => "{}" } as unknown as Response);

    await expect(p).rejects.toMatchObject({ status: 401 });
    const clientCalls = fetchMock.mock.calls.filter((c) => !String(c[0]).endsWith("/auth/refresh"));
    expect(clientCalls).toHaveLength(1);
  });

  it("expectAgentId: если аккаунт уже сменился до отправки, в сеть запрос не уходит вовсе", async () => {
    useAuthStore.getState().setSession(B, "tokB");
    await expect(api("/clients", { method: "POST", body: {}, expectAgentId: "agent-A" })).rejects.toMatchObject({
      status: 401,
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("conditional settings writes", () => {
  it("sends the read revision, rejects conflicts without retrying the write", async () => {
    useAuthStore.getState().setSession(A, "tokA");
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({ error: "Настройки изменены", code: "UI_SHELL_CONFLICT" }), { status: 409 }));
    await expect(api("/ui-shell/config", { method: "PUT", body: {}, ifMatch: '"revision-A"' })).rejects.toMatchObject({ status: 409 });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0][1].headers["If-Match"]).toBe('"revision-A"');
  });

  it.each([['UI_SHELL_VERSION_REQUIRED', false], ['STEP_UP_REQUIRED', true]])("428 %s does not confuse revision and identity checks", async (code, stepUp) => {
    useAuthStore.getState().setSession(A, "tokA");
    const dispatchEvent = vi.fn();
    vi.stubGlobal("window", { dispatchEvent });
    vi.stubGlobal("CustomEvent", class { constructor(public type: string) {} });
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({ error: "Проверка", code }), { status: 428 }));
    await expect(api("/ui-shell/config", { method: "PUT", body: {} })).rejects.toMatchObject({ status: 428 });
    expect(dispatchEvent.mock.calls.some(([event]) => event.type === "step-up-required")).toBe(stepUp);
  });
});

describe("initiating actor of ordinary offline writes", () => {
  it("does not initiate an unowned offline write before sign-in", async () => {
    await expect(api("/clients", { method: "POST", body: {}, queueOffline: true })).rejects.toMatchObject({ status: 401 });
    expect(fetchMock).not.toHaveBeenCalled();
  });
  it.each(["other-actor", "same-actor-new-session"])("never queues the old body after %s", async (transition) => {
    useAuthStore.getState().setSession(A, "tokA");
    const gate = deferred<Response>();
    fetchMock.mockReturnValueOnce(gate.promise);
    const pending = api("/clients", { method: "POST", body: { fullName: "A-private" }, queueOffline: true });
    useAuthStore.getState().logout();
    useAuthStore.getState().setSession(transition === "other-actor" ? B : A, "new-token");
    gate.reject(new TypeError("network failed"));
    await expect(pending).rejects.toMatchObject({ status: 401 });
    expect(lsStore.get("royal-home-offline-queue")).toBeUndefined();
  });
  it("does not start the new user's refresh or retry a stale ordinary write on 401", async () => {
    useAuthStore.getState().setSession(A, "tokA");
    const gate = deferred<Response>();
    fetchMock.mockReturnValueOnce(gate.promise);
    const pending = api("/clients", { method: "POST", body: { fullName: "A-private" } });
    useAuthStore.getState().logout();
    useAuthStore.getState().setSession(B, "tokB");
    gate.resolve(new Response("{}", { status: 401 }));
    await expect(pending).rejects.toMatchObject({ status: 401 });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
  it("keeps an ordinary network-failed write owned by its initiating actor", async () => {
    useAuthStore.getState().setSession(A, "tokA");
    fetchMock.mockRejectedValueOnce(new TypeError("network failed"));
    await expect(api("/clients", { method: "POST", body: { fullName: "A-private" }, queueOffline: true })).rejects.toMatchObject({ name: "OfflineQueuedError" });
    const queue = JSON.parse(lsStore.get("royal-home-offline-queue") ?? "[]");
    expect(queue).toHaveLength(1);
    expect(queue[0]).toMatchObject({ agentId: A.id, body: { fullName: "A-private" } });
    expect(queue[0].idempotencyKey).toBeTruthy();
  });
  it("rechecks the session after the asynchronous offline helper import", async () => {
    const entered = deferred<void>();
    const released = deferred<void>();
    const enqueue = vi.fn();
    vi.doMock("../offlineQueue", async () => {
      entered.resolve();
      await released.promise;
      return { enqueueOffline: enqueue, OfflineQueuedError: Error };
    });
    try {
      useAuthStore.getState().setSession(A, "tokA");
      fetchMock.mockRejectedValueOnce(new TypeError("network failed"));
      const pending = api("/clients", { method: "POST", body: { fullName: "A-private" }, queueOffline: true });
      await entered.promise;
      useAuthStore.getState().logout();
      useAuthStore.getState().setSession(B, "tokB");
      released.resolve();
      await expect(pending).rejects.toMatchObject({ status: 401 });
      expect(enqueue).not.toHaveBeenCalled();
    } finally { vi.doUnmock("../offlineQueue"); }
  });
});

describe("auth transitions clear update snapshots", () => {
  it("logout and direct account switch clear snapshots and block still-mounted old subscriptions", () => {
    const data = new Map<string, string>();
    vi.stubGlobal("sessionStorage", {
      getItem: (key: string) => data.get(key) ?? null, setItem: (key: string, value: string) => data.set(key, value), removeItem: (key: string) => data.delete(key),
      get length() { return data.size; }, key: (index: number) => [...data.keys()][index] ?? null,
    });
    const events = new EventTarget();
    vi.stubGlobal("window", events);
    useAuthStore.getState().setSession(A, "tokA");
    saveDraftBeforeUpdate("client-new:BUYER", "A-private", () => false);
    const unsubscribe = subscribeDraftBeforeUpdate("client-new:BUYER", () => "stale-A-private", () => false);
    useAuthStore.getState().logout();
    expect(data.size).toBe(0);
    useAuthStore.getState().setSession(B, "tokB");
    events.dispatchEvent(new Event("rh:before-app-update"));
    expect(data.size).toBe(0);
    expect(consumeDraftBeforeUpdate("client-new:BUYER")).toBeNull();
    unsubscribe();
    saveDraftBeforeUpdate("conv-1", "B-private", () => false);
    expect(data.size).toBe(1);
    useAuthStore.getState().setSession(A, "tokA");
    expect(data.size).toBe(0);
  });
});
