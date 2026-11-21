import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { uiPreferencesSchema } from "@royal-home/shared";

/**
 * РАСКЛАДКА ГЛАВНОЙ В ЛИЧНЫХ НАСТРОЙКАХ (ревью #326, 20.11.2026).
 *
 * 1) Обычное сохранение (тема, подсказка) НЕ шлёт местную раскладку — берёт с сервера:
 *    иначе старая вкладка на другом устройстве откатывала раскладку с телефона, а API
 *    до этой правки отвечал 400 на любое сохранение.
 * 2) Раскладка уходит только отдельным сохранением из setHomeBlocks; отказ — откат.
 * 3) Ответ /me не перетирает свою несохранённую раскладку (решение «местное новее»
 *    принимается раньше), а чужую (прежний вход на общем устройстве) — заменяет.
 */
const api = vi.hoisted(() => vi.fn());
vi.mock("../../lib/api", () => ({ api: (...args: unknown[]) => api(...args) }));
const values = new Map<string, string>();
const storage = { getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => values.set(key, value), removeItem: (key: string) => values.delete(key) };
vi.stubGlobal("localStorage", storage);
vi.stubGlobal("window", { localStorage: storage });

const SERVER_HOME = { blocks: { AGENT: { hidden: ["agentTiles"] } } };
let serverPrefs: Record<string, unknown> = {};

async function load() {
  const { useAuthStore } = await import("../auth");
  useAuthStore.setState({ agent: { id: "one", role: "AGENT" } as never, sessionEpoch: 7 });
  const { useUiPrefs } = await import("../uiPrefs");
  return { useUiPrefs, useAuthStore };
}
const puts = () => api.mock.calls.filter(([path]) => path === "/me/preferences").map(([, init]) => (init as { body: Record<string, unknown> }).body);

beforeEach(() => {
  values.clear();
  serverPrefs = { home: SERVER_HOME };
  api.mockReset();
  api.mockImplementation((path: string) => Promise.resolve(path === "/me" ? { id: "one", preferences: serverPrefs } : {}));
  vi.useFakeTimers();
});
afterEach(() => { vi.clearAllTimers(); vi.useRealTimers(); vi.resetModules(); });

describe("раскладка главной и сохранение настроек", () => {
  it("смена темы шлёт раскладку С СЕРВЕРА, а не местную; без серверной — без `home` вовсе", async () => {
    const { useUiPrefs } = await load();
    useUiPrefs.getState().hydrateFromServer({ theme: undefined }, true);
    // Местная раскладка расходится с серверной (другая вкладка/устройство сохранили своё).
    useUiPrefs.setState({ homeBlocks: { AGENT: { hidden: ["agentMonth"] } }, homeBlocksOwnerId: "one" });
    useUiPrefs.getState().setTheme("royal-home-2026-night");
    await vi.advanceTimersByTimeAsync(2000);
    expect(puts().at(-1)).toMatchObject({ theme: "royal-home-2026-night", home: SERVER_HOME });

    serverPrefs = {};
    useUiPrefs.getState().dismissHint("hint-x");
    await vi.advanceTimersByTimeAsync(2000);
    const body = puts().at(-1)!;
    expect(body.dismissedHints).toContain("hint-x");
    // API до этой правки строгий: без `home` в теле обычное сохранение проходит и там.
    expect("home" in body).toBe(false);
    expect(uiPreferencesSchema.omit({ home: true }).strict().safeParse(body).success).toBe(true);
  });

  it("setHomeBlocks — отдельное сохранение со своей раскладкой; отказ сервера откатывает", async () => {
    const { useUiPrefs } = await load();
    useUiPrefs.getState().hydrateFromServer({ theme: undefined, home: SERVER_HOME }, true);
    useUiPrefs.getState().setHomeBlocks("AGENT", { hidden: ["agentMonth"] });
    expect(useUiPrefs.getState().homeBlocks.AGENT).toEqual({ hidden: ["agentMonth"] });
    await vi.advanceTimersByTimeAsync(100);
    expect(puts().at(-1)).toMatchObject({ home: { blocks: { AGENT: { hidden: ["agentMonth"] } } } });

    api.mockImplementation((path: string) => path === "/me" ? Promise.resolve({ id: "one", preferences: serverPrefs }) : Promise.reject(new Error("400")));
    useUiPrefs.getState().setHomeBlocks("AGENT", { hidden: ["agentPending"] });
    await vi.advanceTimersByTimeAsync(100);
    expect(useUiPrefs.getState().homeBlocks.AGENT).toEqual({ hidden: ["agentMonth"] });
  });

  it("/me не перетирает свою раскладку, пока местное новее; чужую — заменяет", async () => {
    const { useUiPrefs } = await load();
    // После перезагрузки: своя раскладка и несохранённая тема лежат в браузере.
    useUiPrefs.setState({ serverHydrated: false, homeBlocks: { AGENT: { hidden: ["agentMonth"] } }, homeBlocksOwnerId: "one", updatedAt: 10, syncedAt: 5 });
    useUiPrefs.getState().hydrateFromServer({ theme: undefined, home: SERVER_HOME });
    expect(useUiPrefs.getState().homeBlocks.AGENT).toEqual({ hidden: ["agentMonth"] });

    // Та же картина, но раскладка в браузере осталась от ДРУГОГО сотрудника.
    useUiPrefs.setState({ serverHydrated: false, homeBlocks: { AGENT: { hidden: ["agentMonth"] } }, homeBlocksOwnerId: "two", updatedAt: 10, syncedAt: 5 });
    useUiPrefs.getState().hydrateFromServer({ theme: undefined, home: SERVER_HOME });
    expect(useUiPrefs.getState().homeBlocks.AGENT).toEqual({ hidden: ["agentTiles"] });
    expect(useUiPrefs.getState().homeBlocksOwnerId).toBe("one");

    // Местное не новее — серверная раскладка применяется.
    useUiPrefs.setState({ serverHydrated: false, homeBlocks: { AGENT: { hidden: ["agentMonth"] } }, homeBlocksOwnerId: "one", updatedAt: 5, syncedAt: 10 });
    useUiPrefs.getState().hydrateFromServer({ theme: undefined, home: SERVER_HOME });
    expect(useUiPrefs.getState().homeBlocks.AGENT).toEqual({ hidden: ["agentTiles"] });
  });
});
