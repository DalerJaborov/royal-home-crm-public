/**
 * Заголовок X-App-Build в ответах API — ПОДСКАЗКА «загляни в /version.json», а
 * не приговор «вкладка устарела» (21.11.2026).
 *
 * КАК БЫЛО И ПОЧЕМУ СЛОМАЛОСЬ. С 20.08.2026 расхождение заголовка с первым
 * увиденным значением само по себе объявляло вкладку устаревшей. Но сервер
 * кладёт туда момент запуска процесса API (apps/api/src/app.ts), а не версию
 * фронта: любой перезапуск API без смены фронта (выкат только сервера, рестарт
 * контейнера) помечал КАЖДУЮ открытую вкладку устаревшей. Вкладка честно
 * перезагружалась в ту же самую сборку, счётчик попыток рос, и после третьего
 * такого раза защита от петли глушила обновление навсегда — когда настоящая
 * новая сборка выходила, вкладка её уже не брала (iPhone владельца, 21.11:
 * «Страница не найдена» на новом разделе, старый интерфейс больше суток).
 *
 * КАК ТЕПЕРЬ. Смена заголовка лишь будит проверку /version.json
 * (lib/appUpdate.ts → checkAppVersionNow). Решение «есть обновление» принимает
 * ТОЛЬКО сравнение версии фронта из /version.json с версией вкладки
 * (`__APP_VERSION__`) — один источник правды на оба сигнала.
 *
 * Сигнал многоразовый: каждое новое значение заголовка — новый повод проверить
 * (раньше сигнал был одноразовым, и второй выкат за жизнь вкладки им уже не
 * ловился).
 */
type Listener = () => void;

let seenBuild: string | null = null;
const listeners = new Set<Listener>();

export function noteServerBuild(build: string | null): void {
  if (!build) return;
  if (seenBuild === null) {
    seenBuild = build;
    return;
  }
  if (build === seenBuild) return;
  seenBuild = build;
  for (const listener of [...listeners]) {
    try {
      listener();
    } catch {
      // подписчик упал — это не повод ронять разбор ответа API
    }
  }
}

/** Подписка на смену заголовка X-App-Build. Возвращает отписку. */
export function onServerBuildChange(listener: Listener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** Только для тестов: вернуть модуль в исходное состояние. */
export function resetServerBuildState(): void {
  seenBuild = null;
  listeners.clear();
}

/**
 * Заголовки «на какой сборке эта вкладка» — для сторожа на сервере
 * (apps/api/src/lib/clientBuildWatch.ts): он считает вкладки, застрявшие на
 * старой сборке дольше получаса после выхода новой, и раз в час пишет сводку в
 * журнал. Без этого о застрявшем телефоне узнавали только от его хозяина.
 *
 * `typeof` — не украшение: в vitest константы сборки не определены.
 */
export function clientBuildHeaders(): Record<string, string> {
  const headers: Record<string, string> = {};
  if (typeof __APP_VERSION__ === "string" && __APP_VERSION__) headers["X-Client-Build"] = __APP_VERSION__;
  if (typeof __APP_BUILT_AT__ === "number" && Number.isFinite(__APP_BUILT_AT__)) {
    headers["X-Client-Build-Time"] = String(__APP_BUILT_AT__);
  }
  return headers;
}
