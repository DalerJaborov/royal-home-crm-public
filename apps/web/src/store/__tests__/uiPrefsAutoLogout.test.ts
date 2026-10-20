import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * ЧУЖОЙ АВТОВЫХОД НЕ ДОСТАЁТСЯ СЛЕДУЮЩЕМУ ВОШЕДШЕМУ (19.09.2026).
 *
 * Жалоба владельца: «CRM сотрудника само по себе выбрасывает и пишет загрузите
 * данные заново». Одна из трёх причин жила здесь.
 *
 * `hydrateFromServer` читала настройку как
 * `prefs.security?.autoLogoutMinutes ?? get().autoLogoutMinutes`. Хранилище
 * `royal-home-ui` общее на браузер и переживает выход, а «никогда» (значение по
 * умолчанию) приезжает с сервера ОТСУТСТВУЮЩИМ полем — то есть сервер физически
 * не мог сказать «у этого человека автовыхода нет», `??` всегда откатывался на
 * то, что лежит в браузере. На общем офисном компьютере достаточно было одному
 * сотруднику поставить себе «выходить через 5 минут», чтобы каждого следующего
 * вошедшего здесь молча выкидывало посреди работы (hooks/useIdleLogout.ts зовёт
 * signOut без предупреждения).
 *
 * Без починки первый тест краснеет: значение остаётся 5.
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

describe("uiPrefs: автовыход по бездействию берётся только с сервера", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    putMock.mockReset();
    putMock.mockResolvedValue(undefined);
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.resetModules();
  });

  async function loadStore() {
    const { useAuthStore } = await import("../auth");
    const { useUiPrefs } = await import("../uiPrefs");
    useAuthStore.setState({ agent: { id: "agent-1" } as never, hasSession: true } as never);
    return { useUiPrefs };
  }

  it("в профиле сотрудника настройки нет → «никогда», а не значение прошлого человека за этим компьютером", async () => {
    const { useUiPrefs } = await loadStore();

    // Прошлый сотрудник за этим же браузером поставил себе пять минут.
    useUiPrefs.getState().setAutoLogoutMinutes(5);
    await vi.advanceTimersByTimeAsync(600);
    expect(useUiPrefs.getState().autoLogoutMinutes).toBe(5);

    // Вошёл другой человек. В его профиле на сервере секции security нет вовсе —
    // ровно так выглядит «никогда»: поле не пишется, пока его не задали.
    useUiPrefs.getState().hydrateFromServer({ theme: "royal-home-2026-light" }, true);

    expect(useUiPrefs.getState().autoLogoutMinutes).toBeNull();
  });

  it("настройка в профиле есть → применяется именно она", async () => {
    const { useUiPrefs } = await loadStore();

    useUiPrefs.getState().hydrateFromServer({ security: { autoLogoutMinutes: 30 } } as never, true);

    expect(useUiPrefs.getState().autoLogoutMinutes).toBe(30);
  });

  it("обычная гидратация того же человека тоже не наследует чужое значение", async () => {
    const { useUiPrefs } = await loadStore();

    useUiPrefs.getState().setAutoLogoutMinutes(15);
    await vi.advanceTimersByTimeAsync(600);
    await vi.waitFor(() => expect(useUiPrefs.getState().syncedAt).toBeGreaterThan(0));

    // Сервер подтвердил сохранение, но в ответе /me секции security нет —
    // значит её удалили (или профиль отдаёт умолчание). Локальное значение
    // больше не главнее.
    useUiPrefs.getState().hydrateFromServer({ theme: "royal-home-2026-light" }, false);

    expect(useUiPrefs.getState().autoLogoutMinutes).toBeNull();
  });
});
