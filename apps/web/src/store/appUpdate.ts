import { create } from "zustand";

/**
 * «Вышла новая версия» — когда именно подменять сборку под открытой вкладкой.
 *
 * СОСТОЯНИЕ ЖИВЁТ В СТОРЕ, а не в `useState` компонента: `UpdatePrompt` раньше
 * был смонтирован внутри
 * `AppLayout`, то есть под `ProtectedRoute`, который переключает три разных
 * поддерева (`AppSkeleton` во время восстановления сессии, `<Navigate/>` на
 * /login, сам `AppLayout`) — при восстановлении сессии/логине компонент терял
 * состояние. Плюс `/login` вообще не рендерит `AppLayout`, значит детектор
 * обновления не работал на экране входа никогда. Компонент переехал в
 * `App.tsx` сиблингом `<Routes>`, а решение и таймер отсрочки остались здесь —
 * второй, независимый слой защиты от той же ошибки.
 *
 * ЧТО ИЗМЕНИЛОСЬ 10.09.2026 (решение владельца). Полноэкранного экрана
 * обновления больше нет: «оно большое и раздражает, сотрудники не понимают,
 * что такое кэш». Стор решает не «показать оверлей», а «применить подмену
 * сейчас» — `applying`. Само применение молчит; человек видит только тихую
 * строку «Приложение обновлено» уже на новой сборке.
 *
 * ПРАВИЛО МОМЕНТА. Подменяем, когда человек не занят (`isUserActivelyTyping`:
 * ввод, открытая шторка/модалка, несохранённая форма, недогруженный файл).
 * Если занят — ждём, но переход между разделами (`navigating`) считается
 * разрешением: экран в этот момент и так перерисовывается целиком, подмена
 * незаметна. Потолок ожидания прежний — пять минут, дальше обновляем в любом
 * случае: забытая открытая форма не должна держать вкладку на старой сборке
 * до вечера.
 */

const MAX_DEFER_MS = 5 * 60_000;

export interface RequestApplyOptions {
  /** Подменяется в тесте — в браузере это Date.now(). */
  now?: number;
  /** Сигнал пришёл вместе с переходом между разделами. */
  navigating?: boolean;
}

interface AppUpdateState {
  /** Сигнал service worker (готова новая сборка статики). */
  needRefresh: boolean;
  /** Сигнал X-App-Build (lib/appVersion.ts) или /version.json (lib/appUpdate.ts). */
  staleBuild: boolean;
  /** Подмена сборки идёт прямо сейчас (страница вот-вот перезагрузится). */
  applying: boolean;
  /** Когда впервые понадобилось применить обновление — точка отсчёта для
   *  MAX_DEFER_MS, не сбрасывается повторными вызовами requestApply. */
  deferStart: number | null;
  setNeedRefresh: (value: boolean) => void;
  setStaleBuild: (value: boolean) => void;
  /**
   * Центральное решение «применить сейчас или подождать» — вызывается при
   * каждом сигнале (появление needRefresh/staleBuild, переход между разделами,
   * уход вкладки в фон) и с ретраем, пока человек занят. Чистая функция
   * состояния (принимает `now`), без побочных эффектов, кроме записи в сам
   * стор — тестируется без таймеров и без DOM.
   *
   * Возвращает true, если решение отложено (вызывающий код должен повторить
   * попытку позже), false — если решение принято (подмена началась или
   * применять пока нечего).
   */
  requestApply: (busy: boolean, options?: RequestApplyOptions) => boolean;
  reset: () => void;
}

export const useAppUpdateStore = create<AppUpdateState>((set, get) => ({
  needRefresh: false,
  staleBuild: false,
  applying: false,
  deferStart: null,
  setNeedRefresh: (value) => set({ needRefresh: value }),
  setStaleBuild: (value) => set({ staleBuild: value }),
  requestApply: (busy, options = {}) => {
    const { now = Date.now(), navigating = false } = options;
    const state = get();
    if (state.applying) return false;
    if (!state.needRefresh && !state.staleBuild) return false;
    if (state.deferStart === null) set({ deferStart: now });
    const deferStart = get().deferStart as number;
    const waitedTooLong = now - deferStart > MAX_DEFER_MS;
    if (!busy || navigating || waitedTooLong) {
      set({ applying: true });
      return false;
    }
    return true;
  },
  reset: () => set({ needRefresh: false, staleBuild: false, applying: false, deferStart: null }),
}));
