import { useEffect, useRef } from "react";
import { useLocation } from "react-router-dom";
import { useRegisterSW } from "virtual:pwa-register/react";
import { onServerBuildStale } from "../lib/appVersion";
import { startAppVersionPoll } from "../lib/appUpdate";
import { consumeUpdateNotice, markUpdateApplied } from "../lib/appUpdateNotice";
import { prepareAppUpdate } from "../lib/appUpdatePrefetch";
import {
  applyAppUpdate,
  isUpdateLoopSuppressed,
  resetAttemptsIfUpdated,
  stripFreshMarker,
} from "../lib/appUpdateReload";
import { isMutationInFlight } from "../lib/isMutationInFlight";
import { isUserActivelyTyping, startTypingActivityTracker } from "../lib/isUserActivelyTyping";
import { queryClient } from "../lib/queryClient";
import { isBusy as isWorkBusy } from "../lib/workGuard";
import { useAppUpdateStore } from "../store/appUpdate";
import { toast } from "../store/toast";

/**
 * «Вышла новая версия» — обновление вкладки без участия человека и без экрана.
 *
 * ЗАЧЕМ. CRM держат открытой весь рабочий день, а приложение обновляется выкатом
 * на сервер. Раньше новая версия подхватывалась молча и только при следующем
 * полном открытии: агент с утренней вкладкой мог до вечера работать на
 * вчерашней сборке — исправленная ошибка у него всё ещё воспроизводилась, и он
 * честно сообщал, что её не починили. Разобраться в таком «баге» невозможно: у
 * одного он есть, у другого нет, и оба правы.
 *
 * РЕШЕНИЕ ВЛАДЕЛЬЦА 10.09.2026. Полноэкранный экран обновления убран: «оно
 * большое и раздражает; сотрудники не понимают, что такое кэш, обновление
 * должно происходить само и моментально». Компонент `UpdateOverlay.tsx` удалён,
 * его прогрев переехал в `lib/appUpdatePrefetch.ts` и работает в фоне. Человек
 * видит только тихую строку «Приложение обновлено» — уже ПОСЛЕ подмены, на
 * новой сборке, обычной пилюлей `.toast` (договор дизайна §6.1: никаких
 * кричащих карточек).
 *
 * ОТКУДА УЗНАЁМ — три независимых канала, все три быстрые:
 *
 *  1. X-App-Build в ответах API (`lib/appVersion.ts`) — проталкивается
 *     подпиской в тот же миг, когда пришёл ответ; запросы идут постоянно, так
 *     что обычно это первый сигнал;
 *  2. `/version.json` раз в 10 секунд плюс немедленная проверка при возврате во
 *     вкладку и при восстановлении сети (`lib/appUpdate.ts`) — единственный,
 *     который не ждёт ни действия человека, ни входа (работает и на /login);
 *  3. service worker (`needRefresh` из useRegisterSW) — самый медленный, зато
 *     он же и есть готовая к подмене сборка.
 *
 * КОГДА ПОДМЕНЯЕМ (решение живёт в store/appUpdate.ts, здесь только сигналы и
 * ретраи): как только человек не занят. Если занят — ждём, но переход между
 * разделами считается разрешением: экран и так перерисовывается. Потолок
 * ожидания пять минут.
 *
 * МОНТИРУЕТСЯ В App.tsx, сиблингом `<Routes>` (НЕ внутри AppLayout/Outlet, не
 * внутри ProtectedRoute) — см. store/appUpdate.ts: раньше жил внутри AppLayout
 * и терял состояние при пересборке ProtectedRoute, а на самом /login не
 * монтировался вовсе, то есть детектор обновления ничего не видел на экране
 * входа.
 */

/** Как часто перепроверяем, освободился ли человек. */
const RETRY_WHILE_BUSY_MS = 2_000;

/** Сколько ждём фоновый прогрев в момент подмены. Обычно он давно закончился
 *  (начат при первом же сигнале) — эта граница нужна на случай мёртвой сети:
 *  лучше перезагрузиться и сходить за файлами заново, чем стоять. */
const PREFETCH_WAIT_MS = 2_000;

/** Пауза перед строкой «Приложение обновлено»: на старте вкладки сначала
 *  восстанавливается сессия и собирается экран. Строка ждёт этого, иначе она
 *  выпадает на скелет и человек её не свяжет с приложением. */
const NOTICE_DELAY_MS = 600;

// isUserActivelyTyping вынесен в lib/isUserActivelyTyping.ts (юнит-тест не должен
// тянуть virtual:pwa-register/react — виртуальный модуль недоступен в vitest).

export function UpdatePrompt() {
  // needRefresh приходит ПАРОЙ [значение, setter] — как useState. Разбирать её
  // обязательно: массив истинен всегда, поэтому без деструктуризации условие
  // «пора обновиться» срабатывало на каждый переход, и CRM перезагружалась по
  // кругу на любом разделе (поймано e2e 20.08.2026: ни один экран не открывался).
  const {
    needRefresh: [needRefresh],
    updateServiceWorker,
  } = useRegisterSW({
    // Ошибку регистрации не показываем человеку: приложение и без service worker
    // работает целиком, теряется только офлайн-режим. Тревожить этим агента незачем,
    // а в журнал ошибок это уже попадёт через errorReporter.
    onRegisterError(error) {
      console.error("[pwa] service worker не зарегистрирован:", error);
    },
  });
  const { pathname } = useLocation();
  const setNeedRefresh = useAppUpdateStore((s) => s.setNeedRefresh);
  const setStaleBuild = useAppUpdateStore((s) => s.setStaleBuild);
  const applying = useAppUpdateStore((s) => s.applying);
  const requestApply = useAppUpdateStore((s) => s.requestApply);
  const needRefreshStore = useAppUpdateStore((s) => s.needRefresh);
  const staleBuildStore = useAppUpdateStore((s) => s.staleBuild);
  const shouldRefresh = needRefreshStore || staleBuildStore;
  const retryTimerRef = useRef<number | undefined>(undefined);
  // needRefresh нужен внутри асинхронной подмены уже после решения — берём его
  // из ref, чтобы не тащить эффект применения в зависимость от каждого сигнала.
  const needRefreshRef = useRef(needRefresh);
  needRefreshRef.current = needRefresh;

  // Зеркалим needRefresh от useRegisterSW (живёт в самом хуке, не в сторе —
  // виртуальный модуль pwa-register сам решает, когда его пересоздавать) в
  // стор, чтобы остальная логика (requestApply/shouldRefresh) читала из
  // одного места вместе со staleBuild.
  useEffect(() => {
    setNeedRefresh(needRefresh);
  }, [needRefresh, setNeedRefresh]);

  // Старт вкладки: счётчик попыток обновления больше не про нас, если сборка
  // сменилась, — и ровно в этом случае показываем тихую строку об обновлении.
  useEffect(() => {
    // Пришли после жёсткого сброса — убираем служебный параметр из адреса.
    stripFreshMarker();
    resetAttemptsIfUpdated(__APP_VERSION__);
    if (!consumeUpdateNotice(__APP_VERSION__)) return;
    const timer = window.setTimeout(
      () => toast.success("Приложение обновлено"),
      NOTICE_DELAY_MS
    );
    return () => window.clearTimeout(timer);
  }, []);

  // Отмечаем поля, в которые человек действительно печатал: только они делают
  // вкладку «занятой». Без этого автофокус экрана входа с подставленным «+992»
  // держал бы вкладку от обновления до потолка в пять минут (см. модуль).
  useEffect(() => startTypingActivityTracker(), []);

  // Канал 1 — заголовок сборки в ответах API. Подписка, а не опрос: расхождение
  // становится известно в тот же миг, когда пришёл ответ.
  useEffect(() => onServerBuildStale(() => setStaleBuild(true)), [setStaleBuild]);

  // Канал 2 — /version.json: не ждёт ни навигации, ни ответа API, ни входа.
  useEffect(() => startAppVersionPoll(() => setStaleBuild(true)), [setStaleBuild]);

  // Готовим обновление ЗАРАНЕЕ: файлы новой сборки качаются, пока человек
  // работает, чтобы сама подмена не ждала сеть (см. lib/appUpdatePrefetch.ts).
  useEffect(() => {
    if (shouldRefresh) void prepareAppUpdate();
  }, [shouldRefresh]);

  function tryApply(navigating = false) {
    // Обновление уже не применилось несколько раз подряд — больше не пытаемся:
    // работать на старой сборке лучше, чем крутиться в петле перезагрузок.
    if (isUpdateLoopSuppressed(__APP_VERSION__)) return;
    // Идёт загрузка файлов (lib/workGuard.ts): перезагрузка страницы оборвала бы
    // отдачу на середине, поэтому ждём без потолка MAX_DEFER_MS — даже при
    // переходе между разделами. Файлы без обновления доедут, с обновлением —
    // могут не доехать; сборка подождёт.
    if (isWorkBusy()) {
      window.clearTimeout(retryTimerRef.current);
      retryTimerRef.current = window.setTimeout(() => tryApply(), RETRY_WHILE_BUSY_MS);
      return;
    }
    // Мутация в полёте (например, приём лида) — тот же вес, что и печатающий
    // человек: обрыв запроса при перезагрузке не бросает TypeError, значит
    // queueOffline его не подхватит (см. lib/isMutationInFlight.ts).
    const busy = isUserActivelyTyping() || isMutationInFlight(queryClient);
    const deferred = requestApply(busy, { navigating });
    if (deferred) {
      window.clearTimeout(retryTimerRef.current);
      retryTimerRef.current = window.setTimeout(() => tryApply(), RETRY_WHILE_BUSY_MS);
    }
  }

  // Сигнал появился — пробуем применить сразу.
  useEffect(() => {
    if (shouldRefresh) tryApply();
    // eslint-disable-next-line react-hooks/exhaustive-deps -- реагируем только на появление сигнала обновления
  }, [shouldRefresh]);

  // Переход между разделами: экран в этот момент перерисовывается целиком, и
  // подмена незаметна — применяем, даже если человек считается занятым.
  useEffect(() => {
    if (shouldRefresh) tryApply(true);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- реагируем только на смену маршрута
  }, [pathname]);

  // Вкладка ушла в фон — лучший момент из возможных. `navigating` не ставим:
  // несохранённая форма остаётся несохранённой и в свёрнутой вкладке.
  useEffect(() => {
    if (!shouldRefresh) return;
    function onHidden() {
      if (document.hidden) tryApply();
    }
    document.addEventListener("visibilitychange", onHidden);
    return () => document.removeEventListener("visibilitychange", onHidden);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- tryApply стабилен по смыслу: зависит от тех же needRefresh/staleBuild
  }, [shouldRefresh]);

  /**
   * САМА ПОДМЕНА.
   *
   * СНАЧАЛА АКТИВИРОВАТЬ ЖДУЩИЙ ВОРКЕР, ПОТОМ ПЕРЕЗАГРУЖАТЬ (26.08.2026).
   * Голый window.location.reload() здесь не работает: sw.ts с 15.08 НЕ делает
   * skipWaiting при install (registerType: "prompt") — новый воркер активируется
   * только по сообщению SKIP_WAITING. Перезагрузка отдавала СТАРЫЙ прекешированный
   * index.html от всё ещё управляющего старого воркера, и каждый переход между
   * разделами перезагружал вкладку по кругу.
   *
   * Ветку и защиту от вечной петли держит lib/appUpdateReload.ts — лестница
   * попыток (дать воркеру шанс → снять кэши → сдаться) остаётся страховкой и
   * трогать её нельзя.
   */
  useEffect(() => {
    if (!applying) return;
    let cancelled = false;

    async function run() {
      // Точка сохранения черновиков — шлётся ДО подмены, чтобы подписчик успел
      // записать несохранённое (сейчас персистентных черновиков в приложении
      // нет, см. отчёт P2-auto-update.md, раздел «Черновики»).
      window.dispatchEvent(new CustomEvent("rh:before-app-update"));
      // Прогрев начат ещё при первом сигнале — обычно уже готов.
      await Promise.race([
        prepareAppUpdate(),
        new Promise<void>((resolve) => setTimeout(resolve, PREFETCH_WAIT_MS)),
      ]);
      if (cancelled) return;
      markUpdateApplied(__APP_VERSION__);
      await applyAppUpdate({
        needRefresh: needRefreshRef.current,
        updateServiceWorker,
        currentVersion: __APP_VERSION__,
      });
    }

    void run();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- запускается ровно один раз, когда решение принято
  }, [applying]);

  useEffect(() => () => window.clearTimeout(retryTimerRef.current), []);

  // Ничего не рисуем: обновление молчит, а строка о нём приходит уже на новой
  // сборке обычным уведомлением (см. эффект consumeUpdateNotice выше).
  return null;
}
