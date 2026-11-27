// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../hooks/useSettings", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../hooks/useSettings")>()),
  useSettings: () => ({ data: { aiAssistantEnabled: true }, isError: false }),
}));
vi.mock("./AssistantPanelLazy", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./AssistantPanelLazy")>()),
  preloadAssistantPanel: () => {},
}));

import { useAssistantUi } from "../store/assistantUi";
import { QUICK_CREATE_HOLD_MS, useQuickCreate } from "./quickCreate";

/**
 * «+» — одна дверь на быстрые действия и голос (пачка shell2, 27.11.2026). Ревью 27.11: таймер
 * удержания не гасился, когда кнопка уходила с экрана посреди удержания — помощник открывался
 * сам через 450 мс уже без кнопки под пальцем.
 */
function Plus() {
  const quick = useQuickCreate();
  return <button type="button" {...quick.buttonProps}>+</button>;
}

const openAssistant = vi.fn();

beforeEach(() => {
  vi.useFakeTimers();
  openAssistant.mockReset();
  useAssistantUi.setState({ openAssistant });
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe("useQuickCreate", () => {
  it("удержание открывает помощника с голосом", () => {
    render(<Plus />);
    fireEvent.pointerDown(screen.getByRole("button"));
    act(() => { vi.advanceTimersByTime(QUICK_CREATE_HOLD_MS); });
    expect(openAssistant).toHaveBeenCalledWith({ autoStartVoice: true });
  });

  it("кнопка ушла с экрана посреди удержания — помощник сам не открывается", () => {
    const view = render(<Plus />);
    fireEvent.pointerDown(screen.getByRole("button"));
    view.unmount();
    act(() => { vi.advanceTimersByTime(QUICK_CREATE_HOLD_MS * 2); });
    expect(openAssistant).not.toHaveBeenCalled();
  });
});
