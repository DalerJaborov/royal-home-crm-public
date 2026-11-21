/**
 * ЕДИНСТВЕННЫЙ ИСТОЧНИК ПРАВДЫ «вышла новая версия фронта» — `/version.json`,
 * который кладёт vite.config.ts при сборке (`versionJsonPlugin`). Поле `version`
 * (GIT_SHA выката либо момент сборки) сравнивается с вклеенным в вкладку
 * `__APP_VERSION__`. Файл отдаётся без кэша (то же правило, что у index.html,
 * см. apps/web/nginx.conf), весит десятки байт и не требует входа — работает и
 * на /login.
 *
 * С 21.11.2026 остальные сигналы только БУДЯТ эту проверку, а не решают сами:
 *  - смена заголовка X-App-Build в ответах API (lib/appVersion.ts) — это отметка
 *    запуска процесса API, она меняется и без смены фронта;
 *  - возврат во вкладку (`visibilitychange`), восстановление из bfcache
 *    (`pageshow` — Safari на iPhone возвращает вкладку именно так, без
 *    visibilitychange), фокус окна (`focus`), появление сети (`online`).
 *
 * Опрос раз в 10 секунд, пока вкладка видима, и он НЕ останавливается после
 * первого расхождения: версия сервера может смениться ещё раз (второй выкат за
 * время, пока вкладка ждёт), а может и откатиться обратно — вкладка обязана
 * знать актуальную цель, иначе счётчик попыток (lib/appUpdateReload.ts)
 * считает чужую пару сборок.
 */
const POLL_INTERVAL_MS = 10_000;
/** Подряд пришедшие focus + visibilitychange + pageshow — одна проверка, а не три. */
const CHECK_THROTTLE_MS = 2_000;

let polling = false;
let activeCheckNow: (() => void) | null = null;

/**
 * Проверить /version.json немедленно (если опрос запущен). Зовётся на смену
 * X-App-Build — см. шапку файла.
 */
export function checkAppVersionNow(): void {
  activeCheckNow?.();
}

/**
 * Запустить опрос. `onServerVersion` получает версию фронта на сервере после
 * КАЖДОЙ удачной проверки — совпадает она с вкладкой или нет, решает
 * вызывающий (UpdatePrompt): совпадение после расхождения — это откат выката,
 * и обновляться тогда некуда.
 */
export function startAppVersionPoll(onServerVersion: (version: string) => void): () => void {
  let stopped = false;
  let timer: number | undefined;
  let lastCheckAt = 0;
  let inFlight = false;

  function schedule() {
    if (stopped) return;
    window.clearTimeout(timer);
    // Вкладка в фоне — не тикаем: браузер душит фоновые таймеры, а на возврате
    // сработает checkNow и даст более свежий ответ.
    if (typeof document !== "undefined" && document.hidden) return;
    timer = window.setTimeout(check, POLL_INTERVAL_MS);
  }

  async function check() {
    if (stopped || inFlight) return;
    inFlight = true;
    lastCheckAt = Date.now();
    try {
      const res = await fetch(`/version.json?t=${Date.now()}`, { cache: "no-store" });
      if (res.ok) {
        const data = (await res.json()) as { version?: unknown };
        if (typeof data.version === "string" && data.version && !stopped) onServerVersion(data.version);
      }
    } catch {
      // сеть недоступна/офлайн/битый ответ — не повод считать, что обновление есть
    } finally {
      inFlight = false;
    }
    schedule();
  }

  function checkNow() {
    if (stopped) return;
    if (Date.now() - lastCheckAt < CHECK_THROTTLE_MS) return;
    window.clearTimeout(timer);
    void check();
  }

  function onVisibility() {
    if (!document.hidden) checkNow();
  }

  // Второй раз в той же вкладке опрос не заводим (StrictMode монтирует эффекты
  // дважды), но подписки всё равно снимаем корректно — отсюда общий return.
  const owns = !polling;
  if (owns) {
    polling = true;
    activeCheckNow = checkNow;
    document.addEventListener("visibilitychange", onVisibility);
    window.addEventListener("pageshow", checkNow);
    window.addEventListener("focus", checkNow);
    window.addEventListener("online", checkNow);
    void check();
  }

  return () => {
    stopped = true;
    if (!owns) return;
    polling = false;
    if (activeCheckNow === checkNow) activeCheckNow = null;
    window.clearTimeout(timer);
    document.removeEventListener("visibilitychange", onVisibility);
    window.removeEventListener("pageshow", checkNow);
    window.removeEventListener("focus", checkNow);
    window.removeEventListener("online", checkNow);
  };
}

/**
 * Пока вкладка видима — раз в минуту просим браузер перепроверить sw.js
 * (`registration.update()`). Сам браузер делает это только при навигации и не
 * чаще раза в сутки по своему таймеру; вкладка, открытая с утра на одном
 * экране, иначе узнаёт о новом воркере последней. Новый воркер при этом лишь
 * встаёт в ожидание (registerType: "prompt", см. vite.config.ts) — подмену
 * по-прежнему делает только applyAppUpdate одним движением.
 */
export const SW_UPDATE_INTERVAL_MS = 60_000;

export function startServiceWorkerUpdatePoll(
  getRegistration: () => ServiceWorkerRegistration | null | undefined,
  intervalMs = SW_UPDATE_INTERVAL_MS
): () => void {
  function tick() {
    if (typeof document !== "undefined" && document.visibilityState !== "visible") return;
    if (typeof navigator !== "undefined" && navigator.onLine === false) return;
    const registration = getRegistration();
    if (!registration || registration.installing) return;
    void registration.update().catch(() => {
      // сеть/сертификат/воркер снят — следующий тик попробует снова
    });
  }
  const interval = setInterval(tick, intervalMs);
  return () => clearInterval(interval);
}
