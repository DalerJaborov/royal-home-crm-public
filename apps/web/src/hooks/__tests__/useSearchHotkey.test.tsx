// @vitest-environment jsdom
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { renderHook } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { isSearchHotkey, useSearchHotkey } from "../useSearchHotkey";

/**
 * Клик-аудит 26.11.2026: Ctrl+K открывал поиск только из Sidebar, а «чистая» оболочка (у всех)
 * его не монтирует — горячая клавиша молчала. Теперь хук есть и в Topbar.
 */
const press = (init: KeyboardEventInit) => window.dispatchEvent(new KeyboardEvent("keydown", { cancelable: true, ...init }));

describe("Ctrl+K — поиск", () => {
  it("Ctrl+K и Cmd+K (в любой раскладке регистра) открывают поиск", () => {
    const open = vi.fn();
    renderHook(() => useSearchHotkey(true, open));
    press({ key: "k", ctrlKey: true });
    press({ key: "K", metaKey: true });
    expect(open).toHaveBeenCalledTimes(2);
  });

  it("просто «к», Ctrl+Alt+K и другие сочетания — нет", () => {
    const open = vi.fn();
    renderHook(() => useSearchHotkey(true, open));
    press({ key: "k" });
    press({ key: "k", ctrlKey: true, altKey: true });
    press({ key: "j", ctrlKey: true });
    expect(open).not.toHaveBeenCalled();
    expect(isSearchHotkey({ key: "k", ctrlKey: false, metaKey: false, altKey: false })).toBe(false);
  });

  it("enabled=false не слушает (старая оболочка: Sidebar держит клавишу, Topbar — нет)", () => {
    const open = vi.fn();
    renderHook(() => useSearchHotkey(false, open));
    press({ key: "k", ctrlKey: true });
    expect(open).not.toHaveBeenCalled();
  });

  it("после размонтирования слушатель снят", () => {
    const open = vi.fn();
    const { unmount } = renderHook(() => useSearchHotkey(true, open));
    unmount();
    press({ key: "k", ctrlKey: true });
    expect(open).not.toHaveBeenCalled();
  });

  it("обе оболочки подключены: Topbar (чистая, enabled=clean) и Sidebar (старая)", () => {
    const src = join(__dirname, "..", "..", "components");
    expect(readFileSync(join(src, "Topbar.tsx"), "utf8")).toMatch(/useSearchHotkey\(clean,/);
    expect(readFileSync(join(src, "Sidebar.tsx"), "utf8")).toMatch(/useSearchHotkey\(true,/);
  });
});
