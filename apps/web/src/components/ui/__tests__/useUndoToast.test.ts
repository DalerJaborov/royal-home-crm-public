import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useUndoToastStore } from "../../../store/undoToast";

/**
 * Тестируем стор напрямую (без @testing-library/react — её нет в зависимостях,
 * а для таймера-коммита рендер компонента ничего не проверяет: логика чистая).
 * `useUndoToast` — тонкая обёртка над этими же методами (см. hooks/useUndoToast.ts).
 */
describe("undoToast: строка-действие с отменой (10 с)", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    useUndoToastStore.setState({ toasts: [] });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("коммитит через 10 с, если не отменили", () => {
    const onCommit = vi.fn();
    const onUndo = vi.fn();
    useUndoToastStore.getState().push({ message: "Одобрено · 13:07", onUndo, onCommit });

    expect(useUndoToastStore.getState().toasts).toHaveLength(1);

    vi.advanceTimersByTime(9999);
    expect(onCommit).not.toHaveBeenCalled();
    expect(useUndoToastStore.getState().toasts).toHaveLength(1);

    vi.advanceTimersByTime(1);
    expect(onCommit).toHaveBeenCalledTimes(1);
    expect(onUndo).not.toHaveBeenCalled();
    expect(useUndoToastStore.getState().toasts).toHaveLength(0);
  });

  it("отмена в пределах окна вызывает onUndo и гасит коммит", () => {
    const onCommit = vi.fn();
    const onUndo = vi.fn();
    const id = useUndoToastStore.getState().push({ message: "Одобрено · 13:07", onUndo, onCommit });

    vi.advanceTimersByTime(3000);
    useUndoToastStore.getState().undo(id);

    expect(onUndo).toHaveBeenCalledTimes(1);
    expect(useUndoToastStore.getState().toasts).toHaveLength(0);

    // Коммит не должен догнать после отмены, даже если время истекло бы.
    vi.advanceTimersByTime(10_000);
    expect(onCommit).not.toHaveBeenCalled();
  });

  it("уважает свою длительность (duration), не всегда 10 с", () => {
    const onCommit = vi.fn();
    useUndoToastStore.getState().push({ message: "Передан Маниже", onCommit, durationMs: 5000 });

    vi.advanceTimersByTime(5000);
    expect(onCommit).toHaveBeenCalledTimes(1);
  });

  it("держит не больше 3 тостов одновременно", () => {
    useUndoToastStore.getState().push({ message: "1" });
    useUndoToastStore.getState().push({ message: "2" });
    useUndoToastStore.getState().push({ message: "3" });
    useUndoToastStore.getState().push({ message: "4" });

    const messages = useUndoToastStore.getState().toasts.map((t) => t.message);
    expect(messages).toEqual(["2", "3", "4"]);
  });
});
