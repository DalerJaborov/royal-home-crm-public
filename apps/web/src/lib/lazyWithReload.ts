import { lazy, type ComponentType } from "react";
import {
  buildFreshUrl,
  dropServiceWorkerAndCaches,
  swapViaServiceWorker,
  waitForWaitingWorker,
} from "./appUpdateReload";

/**
 * Ленивая загрузка компонента, устойчивая к деплою при открытой вкладке.
 *
 * Проблема, которую это лечит (реальная ошибка из журнала 25.07):
 * «Failed to fetch dynamically imported module: .../PropertyMapView-CappoH8w.js».
 * Vite режет сборку на куски с хешем в имени. У сотрудника вкладка висит с утра,
 * мы деплоим — старые куски исчезают с сервера. Он открывает карту объектов,
 * браузер идёт за куском со старым хешем и получает 404. Для сотрудника это
 * выглядит как «раздел сломался», хотя ломаться нечему: просто страница старше
 * сервера.
 *
 * Чиним перезагрузкой, но сначала обновляем service worker: он держит в кэше
 * старый index.html, и без принудительного update перезагрузка вернула бы ту же
 * старую сборку и ту же ошибку. SW живёт в registerType: "prompt" — обновлённый
 * воркер надо ещё и разбудить сообщением SKIP_WAITING (см. src/sw.ts и код ниже).
 *
 * Защита от петли: одна перезагрузка в минуту на вкладку. Если после неё модуль
 * всё равно не грузится — причина не в деплое (сеть, блокировщик, сбой раздачи),
 * и ошибку надо показать, а не крутить бесконечный reload.
 */
const RELOAD_MARK = "royal-home:chunk-reload-at";
const HARD_RESET_MARK = "royal-home:chunk-hard-reset-at";
const RELOAD_COOLDOWN_MS = 60_000;

function reloadedRecently(): boolean {
  try {
    const last = Number(sessionStorage.getItem(RELOAD_MARK) ?? 0);
    return Number.isFinite(last) && Date.now() - last < RELOAD_COOLDOWN_MS;
  } catch {
    // Приватный режим может запрещать sessionStorage — тогда считаем, что не перезагружались.
    return false;
  }
}

function markReloaded() {
  try {
    sessionStorage.setItem(RELOAD_MARK, String(Date.now()));
  } catch {
    /* см. выше */
  }
}

function hardResetRecently(): boolean {
  try {
    const last = Number(sessionStorage.getItem(HARD_RESET_MARK) ?? 0);
    return Number.isFinite(last) && Date.now() - last < RELOAD_COOLDOWN_MS;
  } catch {
    return false;
  }
}

function markHardReset() {
  try {
    sessionStorage.setItem(HARD_RESET_MARK, String(Date.now()));
  } catch {
    /* см. выше */
  }
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- React.lazy типизирован через ComponentType<any>
export function lazyWithReload<T extends ComponentType<any>>(factory: () => Promise<{ default: T }>) {
  return lazy(async () => {
    try {
      return await factory();
    } catch (err) {
      // ВТОРАЯ СТУПЕНЬ ВМЕСТО СДАЧИ (15.09.2026).
      //
      // Раньше здесь было `if (reloadedRecently()) throw err` — то есть после
      // одной неудачной перезагрузки раздел показывал экран «Страница не смогла
      // отрисоваться», и человек оставался заперт на старой сборке до тех пор,
      // пока сам не догадается закрыть вкладку. Именно так 15.09 после двух
      // выкатов подряд перестал открываться /messages.
      //
      // Одна перезагрузка помогает не всегда: `SKIP_WAITING` активирует нового
      // воркера АСИНХРОННО, и перезагрузка успевала уйти раньше смены
      // управляющего — старый воркер снова отдавал прекешированную оболочку с
      // тем же мёртвым именем куска. Поэтому ступень вторая — жёсткая: снять
      // воркер, вычистить кэши сборки и уйти на адрес с меткой обхода кэша, тем
      // же способом, каким это делает лестница обновления (appUpdateReload.ts).
      // Сдаёмся только если и жёсткий сброс не помог: тогда причина не в
      // выкате (сеть, блокировщик, сбой раздачи) и ошибку надо показать.
      if (hardResetRecently()) throw err;
      if (reloadedRecently()) {
        markHardReset();
        console.warn("[chunk] Перезагрузка не помогла — снимаем воркер и кэши сборки", err);
        await dropServiceWorkerAndCaches();
        window.location.replace(buildFreshUrl(window.location));
        return new Promise<{ default: T }>(() => {});
      }
      markReloaded();
      console.warn("[chunk] Кусок сборки не найден — обновляем страницу под новую версию", err);

      try {
        // sw.ts живёт в registerType: "prompt" — новый воркер после update()
        // остаётся ЖДУЩИМ, пока ему не пришлют SKIP_WAITING (skipWaiting при
        // install из sw.ts убран 15.08). Без этого сообщения перезагрузка ниже
        // вернула бы ту же старую оболочку из прекеша старого воркера и ту же
        // ошибку 404 на куске (26.08.2026; шапка файла раньше утверждала обратное).
        //
        // ЖДАТЬ обязательно (09.09.2026): установка прекеша — это 137 файлов,
        // сразу после update() воркер ещё в installing, waiting пуст, и
        // сообщение уходило в никуда — ровно тот же промах, что держал вкладку
        // в петле «Обновляю Royal Home…» (см. appUpdateReload.ts).
        if (await waitForWaitingWorker()) {
          const registration = await navigator.serviceWorker?.getRegistration();
          registration?.waiting?.postMessage({ type: "SKIP_WAITING" });
          // ЖДЁМ СМЕНЫ УПРАВЛЯЮЩЕГО, А НЕ ПЕРЕЗАГРУЖАЕМСЯ СРАЗУ (15.09.2026).
          // `SKIP_WAITING` активирует воркера асинхронно; перезагрузка следом
          // уходила раньше, чем новый воркер брал страницу под контроль, и
          // старый отдавал ту же оболочку с мёртвым именем куска. Тот же
          // приём, что у лестницы обновления: перезагрузка по
          // `controllerchange`, со сторожем по таймауту на случай, если смена
          // не случится вовсе.
          await swapViaServiceWorker(
            async () => {},
            () => window.location.reload()
          );
          return new Promise<{ default: T }>(() => {});
        }
      } catch {
        // Обновить SW не вышло — перезагрузка всё равно имеет смысл.
      }
      window.location.reload();

      // Страница уже перезагружается: возвращаем промис, который никогда не
      // разрешится, чтобы React не успел показать экран ошибки на прощание.
      return new Promise<{ default: T }>(() => {});
    }
  });
}
