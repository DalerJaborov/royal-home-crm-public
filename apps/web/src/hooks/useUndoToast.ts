import { useCallback } from "react";
import { useUndoToastStore } from "../store/undoToast";

/**
 * Хук примитива «строка-действие с отменой» (спецификация v8 §3, договор
 * дизайна `.toast-undo`): решение одной кнопкой без модалки, итог живёт 10 с
 * с текстом и «Отменить», по истечении — коммит.
 *
 * Таймер живёт в сторе (`store/undoToast.ts`), а не здесь: <Toaster/> и вызывающий
 * код (строка-действие пульта) — разные компоненты, и досрочная отмена, нажатая
 * в <Toaster/>, обязана погасить тот же таймер, что завёл `showUndoToast`.
 */
export function useUndoToast() {
  const push = useUndoToastStore((s) => s.push);
  const undo = useUndoToastStore((s) => s.undo);

  const showUndoToast = useCallback(
    (opts: {
      message: string;
      /** Обратный вызов при нажатии «Отменить». Если не передан — кнопки нет (см. Toaster). */
      onUndo?: () => void;
      /** Вызывается один раз, когда время истекло без отмены. */
      onCommit?: () => void;
      /** мс, по умолчанию 10 000 — как в договоре дизайна. */
      duration?: number;
    }) => push({ message: opts.message, onUndo: opts.onUndo, onCommit: opts.onCommit, durationMs: opts.duration }),
    [push]
  );

  return { showUndoToast, undo };
}
