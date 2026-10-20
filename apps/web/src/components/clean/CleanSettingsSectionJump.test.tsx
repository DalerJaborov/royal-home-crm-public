import { describe, expect, it, vi } from "vitest";
import { focusSettingsSection } from "./CleanSettingsSectionJump";
describe("settings section navigation", () => {
  it.each(["false", "true"])("focuses the real accordion and only expands a collapsed section (%s)", (expanded) => {
    const accordion = { getAttribute: () => expanded, click: vi.fn(), focus: vi.fn(), scrollIntoView: vi.fn() };
    focusSettingsSection({ closest: () => accordion } as unknown as HTMLElement);
    expect(accordion.click).toHaveBeenCalledTimes(expanded === "false" ? 1 : 0);
    expect(accordion.focus).toHaveBeenCalledWith({ preventScroll: true });
    expect(accordion.scrollIntoView).toHaveBeenCalledWith({ behavior: "auto", block: "start" });
  });
  it("restores an ordinary heading after focus leaves without adding a tab stop", () => {
    let onBlur!: () => void;
    const heading = { closest: () => null, hasAttribute: () => false, tabIndex: 0,
      focus: vi.fn(), scrollIntoView: vi.fn(), removeAttribute: vi.fn(),
      addEventListener: (_event: string, handler: () => void) => { onBlur = handler; },
    };
    focusSettingsSection(heading as unknown as HTMLElement);
    expect(heading.tabIndex).toBe(-1);
    onBlur();
    expect(heading.removeAttribute).toHaveBeenCalledWith("tabindex");
  });
});
