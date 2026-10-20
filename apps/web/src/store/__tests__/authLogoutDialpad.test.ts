import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Ночная проверка 24.09.2026, находка №14: на общем телефоне `logout` не
 * чистил `dialpad:last` (DialPad.tsx) — следующий вошедший сотрудник видел
 * пустое поле набора, но трубка на пустом поле подставляла НОМЕР ПРЕДЫДУЩЕГО
 * сотрудника (DialPad.tsx::handleCall берёт его из того же ключа). Стенд —
 * тот же приём, что в store/__tests__/uiPrefs.test.ts: без jsdom, localStorage
 * стубится вручную.
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

describe("logout чистит dialpad:last (находка №14)", () => {
  beforeEach(() => {
    localStorage.clear();
    vi.stubGlobal("window", { localStorage, sessionStorage: new MemoryStorage() });
  });

  afterEach(() => {
    vi.resetModules();
  });

  it("номер, набранный прошлым сотрудником, не достаётся следующему", async () => {
    const { LAST_DIAL_KEY } = await import("../../lib/lastDial");
    const { useAuthStore } = await import("../auth");

    // Прошлый сотрудник набирал номер — DialPad.tsx::handleCall кладёт его сюда.
    localStorage.setItem(LAST_DIAL_KEY, "927001122");
    expect(localStorage.getItem(LAST_DIAL_KEY)).toBe("927001122");

    useAuthStore.getState().logout();

    expect(localStorage.getItem(LAST_DIAL_KEY)).toBeNull();
  });

  it("выход без набранного номера не падает (ключа просто нет)", async () => {
    const { useAuthStore } = await import("../auth");
    expect(() => useAuthStore.getState().logout()).not.toThrow();
  });

  it("clears drafts even when the chats screen has never mounted", async () => {
    const { CLEAN_CHAT_DRAFT_KEY } = await import("../../lib/cleanChatDraft");
    const { useAuthStore } = await import("../auth");
    window.sessionStorage.setItem(CLEAN_CHAT_DRAFT_KEY, "private text");
    useAuthStore.getState().logout();
    expect(window.sessionStorage.getItem(CLEAN_CHAT_DRAFT_KEY)).toBeNull();
    window.sessionStorage.setItem(CLEAN_CHAT_DRAFT_KEY, "previous actor text");
    useAuthStore.getState().setSession({ id: "next", fullName: "Next", phone: "", role: "AGENT" }, "test-token");
    expect(window.sessionStorage.getItem(CLEAN_CHAT_DRAFT_KEY)).toBeNull();
  });
});
