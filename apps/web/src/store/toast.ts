import { create } from "zustand";

export type ToastKind = "success" | "error";

export interface Toast {
  id: number;
  kind: ToastKind;
  text: string;
}

interface ToastState {
  toasts: Toast[];
  /** Полноэкранный оверлей поверх (сейчас — только IncomingLeadWindow, лид на
   *  весь экран) держит это в true, пока открыт. */
  suspended: boolean;
  show: (text: string, kind?: ToastKind) => void;
  dismiss: (id: number) => void;
  setSuspended: (v: boolean) => void;
}

/** Сколько уведомлений держим на экране: выше стопка перекрывает интерфейс,
 *  а читать её всё равно уже некогда. Старые вытесняются новыми. */
const MAX_VISIBLE = 3;

let nextId = 1;

/**
 * Всплывающие уведомления. Живут в сторе, а не в React-контексте, потому что
 * показывать их нужно и из мест вне дерева компонентов: глобальный обработчик
 * мутаций в lib/queryClient.ts сообщает «Сохранено» на каждое успешное действие,
 * не дожидаясь, пока каждый экран отчитается сам.
 */
export const useToastStore = create<ToastState>((set) => ({
  toasts: [],
  suspended: false,
  show: (text, kind = "success") =>
    set((state) => {
      /**
       * ПОЛНОЭКРАННЫЙ ЛИД ПЕРЕКРЫВАЛ СОБОЙ «СОХРАНЕНО» (14.09.2026, скриншот
       * владельца) — глобальная пилюля «Сохранено» на ЛЮБУЮ фоновую мутацию
       * всплывала прямо поверх кнопок Принять/Отклонить, потому что Toasts
       * ничего не знал про открытый IncomingLeadWindow. Ошибки не глушим —
       * «не удалось принять лид» обязана быть видна именно сейчас.
       */
      if (kind === "success" && state.suspended) return state;
      // Один и тот же текст подряд не дублируем: быстрые правки полей иначе
      // выстраивают колонку из одинаковых «Сохранено».
      const last = state.toasts[state.toasts.length - 1];
      if (last && last.text === text && last.kind === kind) return state;
      return { toasts: [...state.toasts, { id: nextId++, kind, text }].slice(-MAX_VISIBLE) };
    }),
  dismiss: (id) => set((state) => ({ toasts: state.toasts.filter((t) => t.id !== id) })),
  setSuspended: (v) => set({ suspended: v }),
}));

/** Короткий доступ из некомпонентного кода (queryClient, обработчики ошибок). */
export const toast = {
  success: (text: string) => useToastStore.getState().show(text, "success"),
  error: (text: string) => useToastStore.getState().show(text, "error"),
};
