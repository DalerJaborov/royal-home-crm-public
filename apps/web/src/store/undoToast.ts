import { create } from "zustand";

export interface UndoToastEntry {
  id: number;
  /** Итог решения, например «Одобрено · 13:07». */
  message: string;
  /** Вызывается по клику «Отменить» (в течение окна) — обратный эндпоинт. */
  onUndo?: () => void;
  durationMs: number;
}

interface UndoToastState {
  toasts: UndoToastEntry[];
  /** Показать тост и запланировать коммит через `durationMs`, если не отменят. */
  push: (entry: {
    message: string;
    onUndo?: () => void;
    onCommit?: () => void;
    durationMs?: number;
  }) => number;
  /** Досрочная отмена: гасит таймер коммита, вызывает `onUndo`, снимает тост. */
  undo: (id: number) => void;
}

/** Сколько тостов держим одновременно на экране — как в store/toast.ts. */
const MAX_VISIBLE = 3;
const DEFAULT_DURATION_MS = 10_000;

let nextId = 1;
/** Таймеры коммита живут здесь (не в React-состоянии): переход на другой экран
 *  не должен ни потерять отложенный коммит, ни вызвать его дважды. */
const commitTimers = new Map<number, ReturnType<typeof setTimeout>>();

/**
 * Стор тостов с отменой (примитив `.toast-undo` из договора дизайна §rows,
 * спецификация v8 §3: «Одобрено · отменить 10 с», без модалок).
 *
 * Отдельно от `store/toast.ts` (простые «Сохранено»/«Ошибка», авто-закрытие,
 * без действия) — тут каждый тост несёт колбэк «Отменить» и таймер-коммит,
 * смешивать с обычными уведомлениями означало бы городить разные жизненные
 * циклы в одном сторе.
 */
export const useUndoToastStore = create<UndoToastState>((set, get) => ({
  toasts: [],
  push: ({ message, onUndo, onCommit, durationMs = DEFAULT_DURATION_MS }) => {
    const id = nextId++;
    set((state) => ({ toasts: [...state.toasts, { id, message, onUndo, durationMs }].slice(-MAX_VISIBLE) }));
    const timer = setTimeout(() => {
      commitTimers.delete(id);
      set((state) => ({ toasts: state.toasts.filter((t) => t.id !== id) }));
      onCommit?.();
    }, durationMs);
    commitTimers.set(id, timer);
    return id;
  },
  undo: (id) => {
    const timer = commitTimers.get(id);
    if (timer) {
      clearTimeout(timer);
      commitTimers.delete(id);
    }
    const entry = get().toasts.find((t) => t.id === id);
    set((state) => ({ toasts: state.toasts.filter((t) => t.id !== id) }));
    entry?.onUndo?.();
  },
}));
