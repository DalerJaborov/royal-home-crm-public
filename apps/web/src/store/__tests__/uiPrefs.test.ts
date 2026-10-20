import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Регресс B-2/B-3 (docs/acceptance-08-09/Q1-director-desktop.md): тема и тумблеры
 * «Профиль → Оформление» откатывались после перезагрузки, если PATCH на сервер ещё
 * летел (или упал 429/500) в момент, когда пришла гидратация из /me со старым
 * значением. Стор фиксирует `updatedAt` при каждом локальном изменении и `syncedAt`
 * только после подтверждённого сервером сохранения — hydrateFromServer не должна
 * перетирать значение, у которого updatedAt новее syncedAt (кроме входа под другим
 * агентом, force=true, где сервер обязан победить).
 */

class MemoryStorage implements Storage {
  private store = new Map<string, string>();
  get length() {
    return this.store.size;
  }
  clear(): void {
    this.store.clear();
  }
  getItem(key: string): string | null {
    return this.store.has(key) ? this.store.get(key)! : null;
  }
  key(index: number): string | null {
    return Array.from(this.store.keys())[index] ?? null;
  }
  removeItem(key: string): void {
    this.store.delete(key);
  }
  setItem(key: string, value: string): void {
    this.store.set(key, value);
  }
}

vi.stubGlobal("localStorage", new MemoryStorage());

const putMock = vi.fn();
vi.mock("../../lib/api", () => ({
  api: (...args: unknown[]) => args[0] === "/me" ? Promise.resolve({ id: "agent-1", preferences: {} }) : putMock(...args),
}));

describe("uiPrefs: персистентность темы/тумблеров после перезагрузки (B-2/B-3)", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    putMock.mockReset();
    putMock.mockResolvedValue(undefined);
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.resetModules();
  });

  async function loadStores() {
    const { useAuthStore } = await import("../auth");
    const { useUiPrefs } = await import("../uiPrefs");
    useAuthStore.setState({
      agent: { id: "agent-1" } as never,
      hasSession: true,
    } as never);
    return { useUiPrefs };
  }

  it("PATCH медленный/упавший + hydrate позже → остаётся локальное значение", async () => {
    const { useUiPrefs } = await loadStores();

    // Сервер уже дважды отверг сохранение — как 429/500 из README-сценария.
    putMock.mockRejectedValue(new Error("500"));

    useUiPrefs.getState().setTheme("royal-home-2026-night");
    await vi.advanceTimersByTimeAsync(600); // дебаунс
    await vi.advanceTimersByTimeAsync(1000); // 1-й ретрай (тоже падает)
    await vi.advanceTimersByTimeAsync(2000); // 2-й ретрай (тоже падает, попытки исчерпаны)

    expect(useUiPrefs.getState().theme).toBe("royal-home-2026-night");
    expect(useUiPrefs.getState().syncedAt).toBe(0); // сервер так и не подтвердил

    // Пока PATCH не подтверждён — гидратация /me со старым значением НЕ перетирает.
    useUiPrefs.getState().hydrateFromServer(
      { theme: "royal-home-2026-light" },
      false
    );

    expect(useUiPrefs.getState().theme).toBe("royal-home-2026-night");
  });

  it("PATCH успел подтвердиться → следующая гидратация применяет то же значение без отката", async () => {
    const { useUiPrefs } = await loadStores();

    useUiPrefs.getState().setTheme("royal-home-2026-night");
    await vi.advanceTimersByTimeAsync(600);
    await vi.waitFor(() => expect(useUiPrefs.getState().syncedAt).toBeGreaterThan(0));

    useUiPrefs.getState().hydrateFromServer({ theme: "royal-home-2026-night" }, false);
    expect(useUiPrefs.getState().theme).toBe("royal-home-2026-night");
  });

  it("вход под ДРУГИМ пользователем (force) → сервер главнее, даже если было несинканное локальное значение", async () => {
    const { useUiPrefs } = await loadStores();

    putMock.mockRejectedValue(new Error("500"));
    useUiPrefs.getState().setTheme("royal-home-2026-night");
    await vi.advanceTimersByTimeAsync(600);

    useUiPrefs.getState().hydrateFromServer({ theme: "royal-home-2026-light" }, true);

    expect(useUiPrefs.getState().theme).toBe("royal-home-2026-light");
  });
});
