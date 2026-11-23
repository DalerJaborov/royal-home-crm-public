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

/**
 * ПОТОЛОК ОТСРОЧКИ ИЗ-ЗА ДОЛГОЙ РАБОТЫ (lib/workGuard.ts) — 15 минут (21.11.2026).
 *
 * До этого идущая работа (загрузка файлов, автосохранение черновика объекта)
 * держала вкладку от обновления БЕЗ ПОТОЛКА. Но реестр работы снимается не
 * всегда: открытый мастер объекта с заполненными полями держит запись
 * «Черновик объекта» всё время, пока мастер открыт, а файл, упавший повторяемой
 * причиной, — пока его не убрали руками. Такая вкладка не обновлялась никогда.
 *
 * Через 15 минут обновляемся всё равно: перед подменой работе дают досохранить
 * (flushWork), а очереди файлов живут в IndexedDB (lib/uploadQueue.ts,
 * lib/draftUploadStore.ts) и продолжаются после перезагрузки сами.
 */
export const MAX_WORK_DEFER_MS = 15 * 60_000;

export interface RequestApplyOptions {
  /** Подменяется в тесте — в браузере это Date.now(). */
  now?: number;
  /** Сигнал пришёл вместе с переходом между разделами. */
  navigating?: boolean;
}

interface AppUpdateState {
  /** Сигнал service worker (готова новая сборка статики). */
  needRefresh: boolean;
  /** /version.json отдаёт не ту версию, что вклеена во вкладку (lib/appUpdate.ts). */
  staleBuild: boolean;
  /** Версия фронта на сервере по последней удачной проверке /version.json. */
  serverVersion: string | null;
  /** Подмена сборки идёт прямо сейчас (страница вот-вот перезагрузится). */
  applying: boolean;
  /**
   * Сами пробовать больше нельзя (попытки в окне исчерпаны,
   * lib/appUpdateReload.ts) — показываем плашку «Есть обновление · Обновить».
   */
  blocked: boolean;
  /** Когда впервые понадобилось применить обновление — точка отсчёта для
   *  MAX_DEFER_MS, не сбрасывается повторными вызовами requestApply. */
  deferStart: number | null;
  /** С какого момента обновление ждёт идущую работу (MAX_WORK_DEFER_MS). */
  workBusySince: number | null;
  setNeedRefresh: (value: boolean) => void;
  /**
   * Итог проверки /version.json: версия сервера и вывод «отличается ли она от
   * вкладки». Совпала после расхождения — выкат откатили: обновляться некуда.
   */
  setServerVersion: (serverVersion: string, currentVersion: string) => void;
  /** Только сигнал «устарела» без версии — для тестов и старых вызовов. */
  setStaleBuild: (value: boolean) => void;
  setBlocked: (value: boolean) => void;
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
  /**
   * Решение по долгой работе: "wait" — ждём (повторить позже), "proceed" — либо
   * работы нет, либо ждём уже дольше MAX_WORK_DEFER_MS; `forced` — второй
   * случай, вызывающий обязан дать работе досохраниться и подменять, не
   * дожидаясь свободного человека.
   */
  noteWorkBusy: (busy: boolean, now?: number) => { decision: "wait" | "proceed"; forced: boolean };
  /** Подмена не состоялась (сдача по счётчику, страница не ушла) — можно пробовать снова;
   *  отсчёт ожидания занятого человека — с нуля. */
  finishApply: () => void;
  reset: () => void;
}

export const useAppUpdateStore = create<AppUpdateState>((set, get) => ({
  needRefresh: false,
  staleBuild: false,
  serverVersion: null,
  applying: false,
  blocked: false,
  deferStart: null,
  workBusySince: null,
  setNeedRefresh: (value) => set({ needRefresh: value }),
  setServerVersion: (serverVersion, currentVersion) => {
    const stale = serverVersion !== currentVersion;
    const state = get();
    if (state.serverVersion === serverVersion && state.staleBuild === stale) return;
    // Откат выката (сервер снова на нашей сборке) — гасим и плашку: обновлять нечего.
    set(stale ? { serverVersion, staleBuild: true } : { serverVersion, staleBuild: false, blocked: false });
  },
  setStaleBuild: (value) => set({ staleBuild: value }),
  setBlocked: (value) => {
    if (get().blocked !== value) set({ blocked: value });
  },
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
  noteWorkBusy: (busy, now = Date.now()) => {
    if (!busy) {
      if (get().workBusySince !== null) set({ workBusySince: null });
      return { decision: "proceed", forced: false };
    }
    const since = get().workBusySince ?? now;
    if (get().workBusySince === null) set({ workBusySince: now });
    if (now - since >= MAX_WORK_DEFER_MS) return { decision: "proceed", forced: true };
    return { decision: "wait", forced: false };
  },
  // Отсчёт «человек занят» начинается заново: иначе повтор через десять минут
  // после сдачи видел бы давно истёкшие пять минут ожидания и перезагружал
  // вкладку посреди набора текста (ревью #379).
  finishApply: () => set({ applying: false, deferStart: null }),
  reset: () =>
    set({
      needRefresh: false,
      staleBuild: false,
      serverVersion: null,
      applying: false,
      blocked: false,
      deferStart: null,
      workBusySince: null,
    }),
}));
