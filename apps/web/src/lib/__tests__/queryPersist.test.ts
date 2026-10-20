import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { queryClient } from "../queryClient";
import { buildVersion, clearPersistedQueryCache, restoreQueryCache } from "../queryPersist";

/**
 * environment: "node" (vitest.config.ts) — нет ни DOM/localStorage, ни
 * IndexedDB. Свой in-memory localStorage ниже даёт минимум, нужный модулю;
 * indexedDB намеренно НЕ определяем — jsdom и fake-indexeddb не установлены
 * (npm install запрещён в этом воркспейсе), а отсутствующая indexedDB как раз
 * и проверяет главный путь отказа: openDb() бросает ReferenceError, персистер
 * ловит его и падает на localStorage — ровно тот fallback, который просило
 * задание perf/web-instant-11-09.
 */
class MemoryStorage {
  private store = new Map<string, string>();
  getItem(k: string) {
    return this.store.has(k) ? this.store.get(k)! : null;
  }
  setItem(k: string, v: string) {
    this.store.set(k, String(v));
  }
  removeItem(k: string) {
    this.store.delete(k);
  }
}

const AUTH_KEY = "royal-home-auth";
const LS_KEY = "royal-home-query-cache-v1";

function setUser(id: string | null) {
  if (id) localStorage.setItem(AUTH_KEY, JSON.stringify({ state: { agent: { id } } }));
  else localStorage.removeItem(AUTH_KEY);
}

beforeEach(async () => {
  (globalThis as { localStorage?: unknown }).localStorage = new MemoryStorage();
  queryClient.clear();
  await clearPersistedQueryCache();
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("queryPersist: восстановление до рендера (localStorage fallback)", () => {
  it("clears private cache and disk snapshot after permissions are revoked", async () => {
    setUser("agent-1");
    queryClient.setQueryData(["me"], { id: "agent-1", role: "AGENT", permissions: ["clients.view"] });
    queryClient.setQueryData(["clients"], { items: [{ id: "private-client" }] });
    await vi.advanceTimersByTimeAsync(1000);
    expect(localStorage.getItem(LS_KEY)).not.toBeNull();
    queryClient.setQueryData(["me"], { id: "agent-1", role: "AGENT", permissions: [] });
    await vi.advanceTimersByTimeAsync(0);
    expect(queryClient.getQueryData(["clients"])).toBeUndefined();
    expect(localStorage.getItem(LS_KEY)).toBeNull();
  });
  it("старый снимок без прав не восстанавливает профиль или закрытые данные", async () => {
    setUser("agent-1");
    localStorage.setItem(LS_KEY, JSON.stringify({
      userId: "agent-1", savedAt: Date.now(), build: buildVersion(), entries: [
        { key: ["me"], data: { id: "agent-1", preferences: { theme: "royal-home-2026-light" } }, dataUpdatedAt: Date.now() },
        { key: ["me", "score-months"], data: { points: 1 }, dataUpdatedAt: Date.now() },
        { key: ["properties"], data: { items: [{ id: "p1" }] }, dataUpdatedAt: Date.now() },
      ],
    }));
    await restoreQueryCache();
    expect(queryClient.getQueryData(["me"])).toBeUndefined();
    expect(queryClient.getQueryData(["me", "score-months"])).toBeUndefined();
    expect(queryClient.getQueryData(["properties"])).toBeUndefined();
  });

  it("без пользователя ничего не восстанавливает", async () => {
    setUser(null);
    localStorage.setItem(
      LS_KEY,
      JSON.stringify({ userId: "u1", savedAt: Date.now(), build: buildVersion(), entries: [{ key: ["me"], data: { id: "u1" }, dataUpdatedAt: Date.now() }] })
    );
    await restoreQueryCache();
    expect(queryClient.getQueryData(["me"])).toBeUndefined();
  });

  it("восстанавливает снимок только после свежего профиля с теми же правами", async () => {
    setUser("agent-1");
    localStorage.setItem(
      LS_KEY,
      JSON.stringify({
        userId: "agent-1",
        savedAt: Date.now(),
        build: buildVersion(),
        permissions: JSON.stringify(["AGENT", ["properties.view"]]),
        entries: [{ key: ["mission-control", "live"], data: { deals: 5 }, dataUpdatedAt: Date.now() }],
      })
    );
    await restoreQueryCache();
    expect(queryClient.getQueryData(["mission-control", "live"])).toBeUndefined();
    queryClient.setQueryData(["me"], { id: "agent-1", role: "AGENT", permissions: ["properties.view"] });
    expect(queryClient.getQueryData(["mission-control", "live"])).toEqual({ deals: 5 });
  });

  it("снимок другого пользователя на этом устройстве не подставляется", async () => {
    setUser("agent-2");
    localStorage.setItem(
      LS_KEY,
      JSON.stringify({
        userId: "agent-1",
        savedAt: Date.now(),
        build: buildVersion(),
        entries: [{ key: ["me"], data: { id: "agent-1" }, dataUpdatedAt: Date.now() }],
      })
    );
    await restoreQueryCache();
    expect(queryClient.getQueryData(["me"])).toBeUndefined();
  });

  it("запись старше TTL (24ч) пропускается", async () => {
    setUser("agent-1");
    const dayAndOne = Date.now() - (24 * 60 * 60 * 1000 + 1);
    localStorage.setItem(
      LS_KEY,
      JSON.stringify({
        userId: "agent-1",
        savedAt: Date.now(),
        build: buildVersion(),
        entries: [{ key: ["properties", {}], data: [1, 2], dataUpdatedAt: dayAndOne }],
      })
    );
    await restoreQueryCache();
    expect(queryClient.getQueryData(["properties", {}])).toBeUndefined();
  });

  it("clearPersistedQueryCache стирает снимок — следующее восстановление пустое", async () => {
    setUser("agent-1");
    localStorage.setItem(
      LS_KEY,
      JSON.stringify({ userId: "agent-1", savedAt: Date.now(), build: buildVersion(), entries: [{ key: ["me"], data: {}, dataUpdatedAt: Date.now() }] })
    );
    await clearPersistedQueryCache();
    await restoreQueryCache();
    expect(queryClient.getQueryData(["me"])).toBeUndefined();
  });

  // Ночная проверка 24.09.2026, находка P2: снимок другой сборки нёс данные в
  // форме, которую новая версия экрана могла ещё не уметь читать — restoreQueryCache
  // подставлял его как ни в чём не бывало. Тест красный без проверки build.
  it("снимок другой сборки не подставляется и стирается с диска", async () => {
    setUser("agent-1");
    localStorage.setItem(
      LS_KEY,
      JSON.stringify({
        userId: "agent-1",
        savedAt: Date.now(),
        build: "other-build",
        entries: [{ key: ["mission-control", "live"], data: { deals: 5 }, dataUpdatedAt: Date.now() }],
      })
    );
    await restoreQueryCache();
    expect(queryClient.getQueryData(["mission-control", "live"])).toBeUndefined();
    expect(localStorage.getItem(LS_KEY)).toBeNull();
  });

  // Снимок, записанный ДО этой правки (поля build ещё не было вовсе), должен
  // считаться несовпадающим, а не «пропустить проверку», иначе старая форма
  // данных всё равно проскочит первый выкат после починки.
  it("снимок без поля build (записан до этой правки) не подставляется", async () => {
    setUser("agent-1");
    localStorage.setItem(
      LS_KEY,
      JSON.stringify({ userId: "agent-1", savedAt: Date.now(), entries: [{ key: ["me"], data: { id: "agent-1" }, dataUpdatedAt: Date.now() }] })
    );
    await restoreQueryCache();
    expect(queryClient.getQueryData(["me"])).toBeUndefined();
  });
});

describe("queryPersist: автосохранение с дебаунсом 1с и редакцией телефонов", () => {
  it("профиль не попадает в новый снимок даже вместе с разрешёнными экранами", async () => {
    setUser("agent-1");
    queryClient.setQueryData(["me"], { id: "agent-1", role: "AGENT", permissions: ["clients.view"], preferences: { theme: "royal-home-2026-night" } });
    queryClient.setQueryData(["me", "score-months"], { points: 2 });
    queryClient.setQueryData(["properties"], { items: [{ id: "p1" }] });
    await vi.advanceTimersByTimeAsync(1000);
    const onDisk = JSON.parse(localStorage.getItem(LS_KEY)!);
    expect(onDisk.entries.map((entry: { key: unknown[] }) => entry.key)).toEqual([["properties"]]);
    expect(queryClient.getQueryData(["me"])).toBeDefined();
  });

  it("список клиентов пишется на диск БЕЗ поля phone, в живом кэше номер остаётся", async () => {
    setUser("agent-1");
    queryClient.setQueryData(["me"], { id: "agent-1", role: "AGENT", permissions: ["clients.view"] });
    queryClient.setQueryData(["clients", { page: 1 }], {
      items: [{ id: "c1", fullName: "Иванов", phone: "+992900000000" }],
    });
    await vi.advanceTimersByTimeAsync(1_000);

    const onDisk = JSON.parse(localStorage.getItem(LS_KEY)!);
    expect(onDisk.entries[0].data.items[0].phone).toBeUndefined();
    expect(onDisk.entries[0].data.items[0].fullName).toBe("Иванов");
    // Живой кэш (то, что видит открытый сейчас экран) правкам не подвергался.
    expect((queryClient.getQueryData(["clients", { page: 1 }]) as any).items[0].phone).toBe("+992900000000");
    // Снимок несёт версию текущей сборки (P2, 24.09.2026) — иначе следующий
    // запуск с новой сборкой не сможет отличить его от чужой формы данных.
    expect(onDisk.build).toBe(buildVersion());
  });

  it("ключ вне белого списка не сохраняется", async () => {
    setUser("agent-1");
    queryClient.setQueryData(["bot-learning"], { foo: 1 });
    await vi.advanceTimersByTimeAsync(1_000);
    expect(localStorage.getItem(LS_KEY)).toBeNull();
  });
});
