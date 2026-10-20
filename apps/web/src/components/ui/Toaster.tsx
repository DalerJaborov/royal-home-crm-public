import { useUndoToastStore } from "../../store/undoToast";
import { Rh2Portal } from "../rh2/Rh2Scope";
import { useToastStack } from "../rh2/useToastStack";

/**
 * Примитив эталона: строка-итог с отменой (`.toast` + `.toast .undo`,
 * спецификация v8 §3, договор дизайна §6.9 — «Одобрено · 13:07 · отменить», 10 с).
 *
 * `role="status"` (не `alert`) — озвучивается вежливо, не прерывает то, что
 * читалка говорит сейчас: решение прошло без модалки, прерывать нечего.
 * Собственный компонент, а не расширение `<Toasts/>` — тот стор рассчитан на
 * авто-закрывающиеся уведомления без действия (см. store/undoToast.ts).
 *
 * Окно отмены остаётся десятью секундами и живёт в сторе, а не здесь: таймер
 * коммита переживает переход на другой экран (store/undoToast.ts). Портал с
 * областью `.rh2` — потому что строка показывается с любого экрана, в том числе
 * ещё не перенесённого (см. Rh2Scope.tsx).
 */
export function Toaster() {
  const toasts = useUndoToastStore((s) => s.toasts);
  const undo = useUndoToastStore((s) => s.undo);
  // Undo stays nearest the bottom action area; regular notices stack above it.
  // The priority changes geometry only in Clean, never the commit deadline.
  const stack = useToastStack(toasts.length, 1);

  if (toasts.length === 0) return null;

  return (
    <Rh2Portal>
      {toasts.map((t, i) => (
        <div
          key={t.id}
          ref={stack.ref(i)}
          className="toast"
          role="status"
          aria-live="polite"
          style={stack.style(i)}
        >
          <span>{t.message}</span>
          {t.onUndo && (
            <button type="button" className="undo" onClick={() => undo(t.id)}>
              Отменить
            </button>
          )}
        </div>
      ))}
    </Rh2Portal>
  );
}
