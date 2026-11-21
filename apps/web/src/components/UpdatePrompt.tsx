import { useEffect, useRef } from "react";
import { useLocation } from "react-router-dom";
import { useRegisterSW } from "virtual:pwa-register/react";
import { onServerBuildChange } from "../lib/appVersion";
import { checkAppVersionNow, startAppVersionPoll, startServiceWorkerUpdatePoll } from "../lib/appUpdate";
import { runUpdateStep } from "../lib/appUpdateFlow";
import { consumeUpdateNotice, markUpdateApplied } from "../lib/appUpdateNotice";
import { prepareAppUpdate } from "../lib/appUpdatePrefetch";
import {
  applyAppUpdate,
  ATTEMPT_WINDOW_MS,
  forceFreshReload,
  resetAttemptsIfUpdated,
  stripFreshMarker,
  UNKNOWN_TARGET,
} from "../lib/appUpdateReload";
import { isMutationInFlight } from "../lib/isMutationInFlight";
import { isUserActivelyTyping, startTypingActivityTracker } from "../lib/isUserActivelyTyping";
import { queryClient } from "../lib/queryClient";
import { flushWork, isBusy as isWorkBusy } from "../lib/workGuard";
import { useAppUpdateStore } from "../store/appUpdate";
import { toast } from "../store/toast";
import { UpdateBanner } from "./UpdateBanner";

/**
 * «Вышла новая версия» — обновление вкладки без участия человека.
 *
 * ЗАЧЕМ. CRM держат открытой весь рабочий день, а приложение обновляется выкатом
 * на сервер. Раньше новая версия подхватывалась молча и только при следующем
 * полном открытии: агент с утренней вкладкой мог до вечера работать на
 * вчерашней сборке — исправленная ошибка у него всё ещё воспроизводилась, и он
 * честно сообщал, что её не починили.
 *
 * РЕШЕНИЕ ВЛАДЕЛЬЦА 10.09.2026. Полноэкранный экран обновления убран: «оно
 * большое и раздражает; сотрудники не понимают, что такое кэш, обновление
 * должно происходить само и моментально». Человек видит только тихую строку
 * «Приложение обновлено» — уже ПОСЛЕ подмены, на новой сборке.
 *
 * ИСКЛЮЧЕНИЕ С 21.11.2026 — плашка «Есть обновление · Обновить». Она появляется
 * только если обновление само не применилось несколько раз подряд (счётчик в
 * lib/appUpdateReload.ts). До этого в таком случае вкладка молча оставалась на
 * старой сборке НАВСЕГДА (iPhone владельца, сутки на старом интерфейсе).
 *
 * ОТКУДА УЗНАЁМ. Решает только `/version.json` (lib/appUpdate.ts): версия
 * фронта на сервере против `__APP_VERSION__` вкладки. Его будят:
 *  - смена заголовка X-App-Build в ответах API (lib/appVersion.ts) — только как
 *    повод проверить: это отметка запуска API, она меняется и без смены фронта;
 *  - возврат во вкладку, восстановление из bfcache, фокус, появление сети;
 *  - опрос раз в 10 секунд, пока вкладка видима.
 * Отдельно — service worker (`needRefresh`): он же и есть готовая к подмене
 * сборка; раз в минуту, пока вкладка видима, просим браузер перепроверить sw.js.
 *
 * КОГДА ПОДМЕНЯЕМ — lib/appUpdateFlow.ts (один шаг решения, покрыт тестами):
 * как только человек не занят; переход между разделами — разрешение; потолок
 * ожидания пять минут, а при идущей долгой работе (загрузки) — пятнадцать.
 *
 * МОНТИРУЕТСЯ В App.tsx, сиблингом `<Routes>` (НЕ внутри AppLayout/Outlet, не
 * внутри ProtectedRoute) — см. store/appUpdate.ts: работает и на /login.
 */

/** Сколько ждём фоновый прогрев в момент подмены. Обычно он давно закончился
 *  (начат при первом же сигнале) — эта граница нужна на случай мёртвой сети:
 *  лучше перезагрузиться и сходить за файлами заново, чем стоять. */
const PREFETCH_WAIT_MS = 2_000;

/** Пауза перед строкой «Приложение обновлено»: на старте вкладки сначала
 *  восстанавливается сессия и собирается экран. */
const NOTICE_DELAY_MS = 600;

/** Подмена начата, а страница так и не ушла (диалог «Покинуть сайт?», сбой
 *  перезагрузки) — через столько снимаем «applying», чтобы следующий сигнал
 *  мог попробовать снова, а не упирался в вечное «уже применяем». */
const APPLY_STALL_MS = 15_000;

export function UpdatePrompt() {
  const registrationRef = useRef<ServiceWorkerRegistration | null>(null);
  // needRefresh приходит ПАРОЙ [значение, setter] — как useState. Разбирать её
  // обязательно: массив истинен всегда (поймано e2e 20.08.2026).
  const {
    needRefresh: [needRefresh],
    updateServiceWorker,
  } = useRegisterSW({
    onRegisteredSW(_swUrl, registration) {
      registrationRef.current = registration ?? null;
    },
    // Ошибку регистрации не показываем человеку: приложение и без service worker
    // работает целиком, теряется только офлайн-режим.
    onRegisterError(error) {
      console.error("[pwa] service worker не зарегистрирован:", error);
    },
  });
  const { pathname } = useLocation();
  const setNeedRefresh = useAppUpdateStore((s) => s.setNeedRefresh);
  const setServerVersion = useAppUpdateStore((s) => s.setServerVersion);
  const applying = useAppUpdateStore((s) => s.applying);
  const blocked = useAppUpdateStore((s) => s.blocked);
  const needRefreshStore = useAppUpdateStore((s) => s.needRefresh);
  const staleBuildStore = useAppUpdateStore((s) => s.staleBuild);
  const serverVersion = useAppUpdateStore((s) => s.serverVersion);
  const shouldRefresh = needRefreshStore || staleBuildStore;
  const retryTimerRef = useRef<number | undefined>(undefined);
  // needRefresh нужен внутри асинхронной подмены уже после решения — берём его
  // из ref, чтобы не тащить эффект применения в зависимость от каждого сигнала.
  const needRefreshRef = useRef(needRefresh);
  needRefreshRef.current = needRefresh;

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
    const timer = window.setTimeout(() => toast.success("Приложение обновлено"), NOTICE_DELAY_MS);
    return () => window.clearTimeout(timer);
  }, []);

  // Отмечаем поля, в которые человек действительно печатал: только они делают
  // вкладку «занятой» (см. lib/isUserActivelyTyping.ts).
  useEffect(() => startTypingActivityTracker(), []);

  // Смена X-App-Build — только повод заглянуть в /version.json, не решение.
  useEffect(() => onServerBuildChange(checkAppVersionNow), []);

  // Единственный источник решения «есть новая сборка фронта».
  useEffect(
    () => startAppVersionPoll((version) => setServerVersion(version, __APP_VERSION__)),
    [setServerVersion]
  );

  // Раз в минуту, пока вкладка видима, — перепроверить sw.js.
  useEffect(() => startServiceWorkerUpdatePoll(() => registrationRef.current), []);

  // Готовим обновление ЗАРАНЕЕ: файлы новой сборки качаются, пока человек
  // работает, чтобы сама подмена не ждала сеть (см. lib/appUpdatePrefetch.ts).
  useEffect(() => {
    if (shouldRefresh) void prepareAppUpdate();
  }, [shouldRefresh]);

  function tryApply(navigating = false) {
    window.clearTimeout(retryTimerRef.current);
    const step = runUpdateStep({
      currentVersion: __APP_VERSION__,
      navigating,
      workBusy: isWorkBusy(),
      userTyping: isUserActivelyTyping,
      mutationInFlight: () => isMutationInFlight(queryClient),
    });
    if (step.flushWork) flushWork();
    if (step.retryInMs !== null) {
      retryTimerRef.current = window.setTimeout(() => tryApply(), step.retryInMs);
    }
  }

  // Сигнал появился или сменилась цель (вышла ещё более новая сборка — счётчик
  // попыток для неё свой) — пробуем применить.
  useEffect(() => {
    if (shouldRefresh) tryApply();
    // eslint-disable-next-line react-hooks/exhaustive-deps -- реагируем только на сигнал и смену цели
  }, [shouldRefresh, serverVersion]);

  // Переход между разделами: экран в этот момент перерисовывается целиком, и
  // подмена незаметна — применяем, даже если человек считается занятым.
  useEffect(() => {
    if (shouldRefresh) tryApply(true);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- реагируем только на смену маршрута
  }, [pathname]);

  // Вкладка ушла в фон — лучший момент из возможных. Вернулась — тоже пробуем:
  // таймер повтора в фоне мог заснуть (Safari замораживает фоновые вкладки).
  useEffect(() => {
    if (!shouldRefresh) return;
    function onVisibility() {
      tryApply();
    }
    document.addEventListener("visibilitychange", onVisibility);
    return () => document.removeEventListener("visibilitychange", onVisibility);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- tryApply читает всё из стора
  }, [shouldRefresh]);

  /**
   * САМА ПОДМЕНА.
   *
   * СНАЧАЛА АКТИВИРОВАТЬ ЖДУЩИЙ ВОРКЕР, ПОТОМ ПЕРЕЗАГРУЖАТЬ (26.08.2026), и
   * ОДНИМ движением (vite.config.ts, «часть файлов новая, часть старая»): sw.ts
   * НЕ делает skipWaiting при install, новый воркер активируется только по
   * сообщению SKIP_WAITING, а страница перезагружается по controllerchange.
   * Ветку и защиту от вечной петли держит lib/appUpdateReload.ts.
   */
  useEffect(() => {
    if (!applying) return;
    let cancelled = false;
    let stallTimer: number | undefined;

    async function run() {
      // Точка сохранения черновиков — шлётся ДО подмены (lib/draftBeforeUpdate.ts).
      window.dispatchEvent(new CustomEvent("rh:before-app-update"));
      // Прогрев начат ещё при первом сигнале — обычно уже готов.
      await Promise.race([
        prepareAppUpdate(),
        new Promise<void>((resolve) => setTimeout(resolve, PREFETCH_WAIT_MS)),
      ]);
      if (cancelled) return;
      markUpdateApplied(__APP_VERSION__);
      const store = useAppUpdateStore.getState();
      const branch = await applyAppUpdate({
        needRefresh: needRefreshRef.current,
        updateServiceWorker,
        currentVersion: __APP_VERSION__,
        targetVersion: store.serverVersion ?? UNKNOWN_TARGET,
      });
      if (cancelled) return;
      if (branch === "gave-up") {
        // Попытки в окне кончились между решением и подменой — плашка и повтор.
        useAppUpdateStore.getState().finishApply();
        tryApply();
        return;
      }
      // Страница не ушла (человек ответил «Остаться» на вопрос браузера о
      // несохранённом, перезагрузка сорвалась). Сразу не повторяем — иначе тот
      // же вопрос всплывал бы каждые 15 секунд: плашка, а сами — через окно.
      stallTimer = window.setTimeout(() => {
        const state = useAppUpdateStore.getState();
        state.finishApply();
        state.setBlocked(true);
        window.clearTimeout(retryTimerRef.current);
        retryTimerRef.current = window.setTimeout(() => tryApply(), ATTEMPT_WINDOW_MS);
      }, APPLY_STALL_MS);
    }

    void run();
    return () => {
      cancelled = true;
      window.clearTimeout(stallTimer);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- запускается ровно один раз, когда решение принято
  }, [applying]);

  useEffect(() => () => window.clearTimeout(retryTimerRef.current), []);

  if (!blocked || !shouldRefresh) return null;
  return (
    <UpdateBanner
      onUpdate={async () => {
        window.dispatchEvent(new CustomEvent("rh:before-app-update"));
        flushWork();
        markUpdateApplied(__APP_VERSION__);
        await forceFreshReload();
      }}
    />
  );
}
