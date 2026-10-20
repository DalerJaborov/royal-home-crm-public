import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Выход А не должен погасить сессию Б (аудит Codex 04.10.2026, №3).
 *
 * signOut гасит локальное состояние сразу, а запрос /auth/logout уходит позже
 * (до трёх ожиданий по 3 с на снятие push). Если Б успел войти, запрос несёт
 * refresh-cookie уже Б, и сервер отзывал сессию Б. Теперь клиент сообщает, чей
 * это выход (agentId), и сервер сверяет его с cookie.
 */
// Хранилище должно появиться ДО импорта стора (persist читает localStorage при создании).
vi.hoisted(() => {
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

import { useAuthStore } from "../../store/auth";
import { signOut } from "../signOut";

const A = { id: "agent-A", fullName: "А", phone: "+992900000001", role: "AGENT" as const };
const B = { id: "agent-B", fullName: "Б", phone: "+992900000002", role: "AGENT" as const };

const fetchMock = vi.fn();

beforeEach(() => {
  fetchMock.mockReset();
  fetchMock.mockResolvedValue({ ok: true, status: 204 });
  vi.stubGlobal("fetch", fetchMock);
  useAuthStore.getState().logout();
});

describe("signOut сообщает серверу, чей это выход", () => {
  it("пока выход ждёт, вошёл Б: в /auth/logout ушёл agentId = А", async () => {
    useAuthStore.getState().setSession(A, "tokA");
    const p = signOut();
    // Выход А ещё не дошёл до сети, а Б уже вошёл.
    useAuthStore.getState().setSession(B, "tokB");
    await p;

    const call = fetchMock.mock.calls.find((c) => String(c[0]).endsWith("/auth/logout"));
    expect(call).toBeDefined();
    const body = JSON.parse(String((call![1] as RequestInit).body));
    expect(body.agentId).toBe("agent-A");
    // Сам выход не тронул сессию Б на клиенте.
    expect(useAuthStore.getState().agent?.id).toBe("agent-B");
  });

  it("выход без сессии (agentId неизвестен) по-прежнему уходит, без поля", async () => {
    await signOut();
    const call = fetchMock.mock.calls.find((c) => String(c[0]).endsWith("/auth/logout"));
    expect(call).toBeDefined();
    const raw = (call![1] as RequestInit).body;
    expect(raw === undefined || JSON.parse(String(raw)).agentId === undefined).toBe(true);
  });
});
