import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * api.ts тянет useAuthStore (persist → localStorage, которого нет в этом
 * окружении, environment: "node" — vitest.config.ts) — заглушено тем же
 * приёмом, что и в uploadQueue.test.ts. deviceId/signOut тоже — им незачем
 * настоящий localStorage ради этого теста.
 */
vi.mock("../../store/auth", () => ({
  useAuthStore: {
    getState: () => ({
      accessToken: null,
      hasSession: false,
      agent: null,
      setAccessToken: vi.fn(),
      setSession: vi.fn(),
      updateAgent: vi.fn(),
    }),
    subscribe: () => () => {},
  },
}));
vi.mock("../deviceId", () => ({ getOrCreateDeviceId: () => "test-device" }));
vi.mock("../signOut", () => ({ signOut: vi.fn() }));

import { api, cooldownPathKey, resetApiCooldownForTests } from "../api";

/**
 * Находка ночной проверки 24.09.2026 (P1, «у половины офиса CRM не работает»):
 * пауза после 429 была ОДНИМ модульным таймером — ответ от редкого и тесного
 * /settings/branding останавливал БЕЗ СЕТИ все остальные GET вкладки, включая
 * /clients, у которого свой (общий, куда более щедрый) лимитер и своя, ещё не
 * исчерпанная квота. Проверяем, что пауза теперь по пути: 429 с одного адреса
 * не мешает другому, а повтор ТОГО ЖЕ адреса внутри паузы по-прежнему
 * отклоняется без похода на сервер.
 */
function jsonResponse(status: number, body: unknown, headers: Record<string, string> = {}) {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: (key: string) => headers[key] ?? null },
    text: async () => JSON.stringify(body),
    json: async () => body,
  } as unknown as Response;
}

describe("пауза после 429 — по пути, не на весь модуль", () => {
  beforeEach(() => {
    resetApiCooldownForTests();
    vi.stubGlobal("fetch", vi.fn());
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    resetApiCooldownForTests();
  });

  it("cooldownPathKey отбрасывает query — пауза не зависит от параметров", () => {
    expect(cooldownPathKey("/clients?page=2")).toBe("/clients");
    expect(cooldownPathKey("/settings/branding")).toBe("/settings/branding");
  });

  it("429 с одного пути не останавливает GET на другом", async () => {
    const fetchMock = fetch as unknown as ReturnType<typeof vi.fn>;
    fetchMock.mockResolvedValueOnce(jsonResponse(429, { error: "Слишком много запросов" }, { "Retry-After": "600" }));
    await expect(api("/settings/branding")).rejects.toMatchObject({ status: 429 });

    fetchMock.mockResolvedValueOnce(jsonResponse(200, { ok: true }));
    await expect(api("/clients")).resolves.toEqual({ ok: true });

    // Оба раза ушли в сеть — второй путь не был отброшен паузой первого.
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("повтор ТОГО ЖЕ пути внутри паузы отклоняется без сети", async () => {
    const fetchMock = fetch as unknown as ReturnType<typeof vi.fn>;
    fetchMock.mockResolvedValueOnce(jsonResponse(429, { error: "Слишком много запросов" }, { "Retry-After": "600" }));
    await expect(api("/settings/branding")).rejects.toMatchObject({ status: 429 });

    await expect(api("/settings/branding")).rejects.toMatchObject({ status: 429 });

    // Второй вызов не дошёл до fetch — счётчик остался на единице.
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("query-строка не создаёт отдельную паузу для того же пути", async () => {
    const fetchMock = fetch as unknown as ReturnType<typeof vi.fn>;
    fetchMock.mockResolvedValueOnce(jsonResponse(429, { error: "Слишком много запросов" }, { "Retry-After": "600" }));
    await expect(api("/clients?page=1")).rejects.toMatchObject({ status: 429 });

    await expect(api("/clients?page=2")).rejects.toMatchObject({ status: 429 });

    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
