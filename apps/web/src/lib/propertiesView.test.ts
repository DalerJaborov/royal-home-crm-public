import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { initialPropertiesView, rememberPropertiesView } from "./propertiesView";

function memoryStorage() {
  const data = new Map<string, string>();
  return {
    getItem: (key: string) => data.get(key) ?? null,
    setItem: (key: string, value: string) => void data.set(key, value),
  };
}

describe("propertiesView", () => {
  beforeEach(() => {
    vi.stubGlobal("window", { localStorage: memoryStorage() });
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("по умолчанию — плитка", () => {
    expect(initialPropertiesView(null)).toBe("cards");
  });

  it("запоминает выбор человека", () => {
    rememberPropertiesView("table");
    expect(initialPropertiesView(null)).toBe("table");
  });

  it("ссылка важнее сохранённого выбора, мусор в ссылке игнорируется", () => {
    rememberPropertiesView("table");
    expect(initialPropertiesView("cards")).toBe("cards");
    expect(initialPropertiesView("gallery")).toBe("table");
  });

  it("недоступное хранилище не роняет экран", () => {
    const blocked = () => { throw new Error("blocked"); };
    vi.stubGlobal("window", { localStorage: { getItem: blocked, setItem: blocked } });
    expect(() => rememberPropertiesView("table")).not.toThrow();
    expect(initialPropertiesView(null)).toBe("cards");
  });
});
