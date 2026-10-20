import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Ассистент не повторяет запрос прошлого сотрудника от имени нового (аудит Codex
 * 04.10.2026, CHAT01). Первый запрос А получил 401, пока А выходил и входил Б:
 * refreshAccessToken вернул токен Б, и история А ушла бы к ассистенту с его правами.
 */
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
vi.mock("../api", () => ({ refreshAccessToken: vi.fn() }));

import { useAuthStore } from "../../store/auth";
import { refreshAccessToken } from "../api";
import { streamAssistant } from "../assistantStream";

const A = { id: "agent-A", fullName: "А", phone: "+992900000001", role: "AGENT" as const };
const B = { id: "agent-B", fullName: "Б", phone: "+992900000002", role: "AGENT" as const };

function deferred<T>() {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((res) => (resolve = res));
  return { promise, resolve };
}
const res401 = () => ({ ok: false, status: 401, body: null, json: async () => ({}) }) as unknown as Response;
function resSse(reply: string) {
  const enc = new TextEncoder();
  const chunks = [enc.encode(`event: done\ndata: ${JSON.stringify({ reply })}\n\n`)];
  let i = 0;
  return {
    ok: true,
    status: 200,
    body: { getReader: () => ({ read: async () => (i < chunks.length ? { done: false, value: chunks[i++] } : { done: true }) }) },
  } as unknown as Response;
}

const fetchMock = vi.fn();
beforeEach(() => {
  lsStore.clear();
  fetchMock.mockReset();
  vi.mocked(refreshAccessToken).mockReset();
  vi.stubGlobal("fetch", fetchMock);
  useAuthStore.getState().setSession(A, "token-A");
});
afterEach(() => vi.unstubAllGlobals());

describe("streamAssistant и смена аккаунта", () => {
  it("401 + вход Б во время ожидания: повтора с токеном Б нет, история А не уходит", async () => {
    const first = deferred<Response>();
    fetchMock.mockReturnValueOnce(first.promise);
    vi.mocked(refreshAccessToken).mockResolvedValue("token-B");
    const p = streamAssistant([{ role: "user", content: "создай задачу" }], () => {});
    const failure = p.then(
      () => null,
      (e: Error) => e.message
    );
    // А вышел, вошёл Б, и только потом пришёл 401 для запроса А.
    useAuthStore.getState().logout();
    useAuthStore.getState().setSession(B, "token-B");
    first.resolve(res401());
    expect(await failure).toMatch(/Сессия сменилась/);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("контрольный: без смены сессии повтор с обновлённым токеном проходит", async () => {
    fetchMock.mockResolvedValueOnce(res401()).mockResolvedValueOnce(resSse("готово"));
    vi.mocked(refreshAccessToken).mockImplementation(async () => {
      useAuthStore.getState().setAccessToken("token-A2"); // продление той же сессии
      return "token-A2";
    });
    await expect(streamAssistant([{ role: "user", content: "привет" }], () => {})).resolves.toBe("готово");
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls[1][1].headers.Authorization).toBe("Bearer token-A2");
  });

  it("поток дочитан уже в чужой сессии: ответ не отдаётся", async () => {
    const first = deferred<Response>();
    fetchMock.mockReturnValueOnce(first.promise);
    const p = streamAssistant([{ role: "user", content: "привет" }], () => {});
    const failure = p.then(
      () => "ok",
      (e: Error) => e.message
    );
    useAuthStore.getState().logout();
    useAuthStore.getState().setSession(B, "token-B");
    first.resolve(resSse("ответ для А"));
    expect(await failure).toMatch(/Сессия сменилась/);
  });
});
