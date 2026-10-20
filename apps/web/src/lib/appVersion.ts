/**
 * Расхождение версий сервера и открытой вкладки — независимый от service
 * worker сигнал (владелец 20.08.2026, второе исследование по автообновлению).
 *
 * У триггеров «вкладка ушла в фон» и «переход между разделами» есть слепое
 * пятно: агент, который держит один и тот же экран открытым весь день не
 * сворачивая телефон и никуда не переходя, не поймает ни один из них — а API
 * тем временем может уже уйти на новый контракт.
 *
 * `noteServerBuild` вызывается из api.ts на каждом ответе и сравнивает заголовок
 * X-App-Build (app.ts на сервере — момент запуска процесса) с тем, что видели
 * первым за эту сессию вкладки.
 *
 * САМЫЙ БЫСТРЫЙ ИЗ ТРЁХ КАНАЛОВ — и с 10.09.2026 он больше не ждёт опроса.
 * Раньше `UpdatePrompt` спрашивал `isServerBuildStale()` раз в 20 секунд, то
 * есть знание о новой сборке лежало готовым до двадцати секунд впустую. Теперь
 * расхождение проталкивается подписчикам в тот же миг, когда пришёл ответ API —
 * а запросы в CRM идут постоянно, так что обычно это первый из трёх сигналов.
 */
type Listener = () => void;

let seenBuild: string | null = null;
let stale = false;
const listeners = new Set<Listener>();

export function noteServerBuild(build: string | null): void {
  if (!build) return;
  if (seenBuild === null) {
    seenBuild = build;
    return;
  }
  if (build === seenBuild || stale) return;
  stale = true;
  for (const listener of listeners) {
    try {
      listener();
    } catch {
      // подписчик упал — это не повод ронять разбор ответа API
    }
  }
}

export function isServerBuildStale(): boolean {
  return stale;
}

/**
 * Подписка на расхождение сборок. Если оно уже случилось до подписки —
 * слушатель вызывается сразу: сигнал одноразовый, и пропустить его из-за
 * порядка монтирования нельзя.
 */
export function onServerBuildStale(listener: Listener): () => void {
  if (stale) {
    listener();
    return () => {};
  }
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** Только для тестов: вернуть модуль в исходное состояние. */
export function resetServerBuildState(): void {
  seenBuild = null;
  stale = false;
  listeners.clear();
}
