import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { uiPreferencesSchema } from "@royal-home/shared";

/**
 * «РАЗМЕР ТЕКСТА» НОВОГО ВИДА (20.11.2026, владелец: «слишком мелкий шрифт»): обычный / крупный /
 * очень крупный. Хранится на устройстве (royal-home-ui) и в Agent.preferences.textSize; на <html>
 * ставится data-text-size, от него зависит --rh-text-scale в theme-look-royal.css.
 */
const api = vi.hoisted(() => vi.fn());
vi.mock("../../lib/api", () => ({ api: (...args: unknown[]) => api(...args) }));
const values = new Map<string, string>();
const storage = { getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => values.set(key, value), removeItem: (key: string) => values.delete(key) };
vi.stubGlobal("localStorage", storage);
vi.stubGlobal("window", { localStorage: storage });
const dataset: Record<string, string | undefined> = {};
vi.stubGlobal("document", {
  documentElement: { dataset, classList: { toggle: () => {} } },
  querySelector: () => null,
});

async function load() {
  const { useAuthStore } = await import("../auth");
  useAuthStore.setState({ agent: { id: "one", role: "AGENT" } as never, sessionEpoch: 3 });
  const { useUiPrefs } = await import("../uiPrefs");
  return { useUiPrefs };
}
const puts = () => api.mock.calls.filter(([path]) => path === "/me/preferences").map(([, init]) => (init as { body: Record<string, unknown> }).body);

beforeEach(() => {
  values.clear();
  for (const key of Object.keys(dataset)) delete dataset[key];
  api.mockReset();
  api.mockImplementation((path: string) => Promise.resolve(path === "/me" ? { id: "one", preferences: {} } : {}));
  vi.useFakeTimers();
});
afterEach(() => { vi.clearAllTimers(); vi.useRealTimers(); vi.resetModules(); });

describe("размер текста", () => {
  it("выбор сразу ставит атрибут на <html>, уходит на сервер и лежит на устройстве", async () => {
    const { useUiPrefs } = await load();
    expect(useUiPrefs.getState().textSize).toBe("normal");
    useUiPrefs.getState().setTextSize("xlarge");
    expect(dataset.textSize).toBe("xlarge");
    await vi.advanceTimersByTimeAsync(2000);
    const body = puts().at(-1)!;
    expect(body.textSize).toBe("xlarge");
    expect(uiPreferencesSchema.safeParse(body).success).toBe(true);
    expect(values.get("royal-home-ui")).toContain('"textSize":"xlarge"');
    useUiPrefs.getState().setTextSize("normal");
    expect(dataset.textSize).toBeUndefined();
  });

  it("с сервера берётся свой размер; чужое значение схема не пропускает", async () => {
    const { useUiPrefs } = await load();
    useUiPrefs.getState().hydrateFromServer({ theme: undefined, textSize: "large" }, true);
    expect(useUiPrefs.getState().textSize).toBe("large");
    expect(dataset.textSize).toBe("large");
    expect(uiPreferencesSchema.safeParse({ textSize: "huge" }).success).toBe(false);
  });
});
