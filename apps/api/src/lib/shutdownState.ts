/**
 * ОБЩИЙ МЕХАНИЗМ ДЛЯ ФОНОВЫХ VOID-ЗАДАЧ ПРИ ОСТАНОВКЕ (17.09.2026).
 *
 * Журнал прода 16.09 20:19: «[api] Публикация живого события client.updated:
 * Cannot use a pool after calling end on the pool». `index.ts` (мягкая
 * остановка по SIGTERM/SIGINT) зовёт `prisma.$disconnect()` и выходит, а
 * фоновые задачи — публикация живых событий (`void publishClientUpdated(...)`
 * и вся семья в `livePublish.ts`/`eventBus.ts`), обход хвоста таблицы,
 * пульс кронов, `lastContactAt` после ответа в переписке — запускаются из
 * обработчиков как `void asyncFn()` и в момент остановки ещё летят. Если они
 * дописывают в базу ПОСЛЕ закрытия пула, отказ уходит в `logSystemError` как
 * настоящий баг (создаёт строку ErrorLog, будит директора пушем), хотя это
 * ожидаемая гонка при остановке, а не поломка интеграции.
 *
 * Мест с таким `void ...prisma...` — десятки (грубая оценка: `logSystemError`
 * сам вызывается из ~150 точек, плюс отдельные `void prisma.X().catch(...)`
 * в обход него). Чинить каждое по отдельности значит разойтись с реальностью
 * через неделю — ровно та ошибка, из-за которой в CLAUDE.md есть правило «нашёл
 * баг — ищи весь класс». Вместо этого здесь один флаг и один реестр:
 *
 *  - `beginShutdown()` — index.ts зовёт ПЕРВОЙ строкой в обработчике сигнала,
 *    до `server.close()`. Дальше `isShuttingDown()` истинно для всего процесса.
 *  - `trackBackgroundTask()` — фоновая задача регистрирует свой промис здесь;
 *    `drainBackgroundTasks()` дожидается всех зарегистрированных с потолком
 *    (сама остановка не должна виснуть из-за медленной публикации).
 *  - `guardBackgroundFailure()` — единая точка решения «это баг или гонка при
 *    остановке»: во время остановки печатает ОДНУ строку уровня info и выходит,
 *    иначе отдаёт вызывающему сигнал «пиши как обычно» (в `logSystemError`
 *    ту же проверку делает сама функция — этот хелпер для мест, которые в неё
 *    не заходят, например `console.error` напрямую).
 *
 * `logSystemError` (systemError.ts) — самая частая точка входа, и она уже
 * проверяет `isShuttingDown()` сама: это закрывает подавляющее большинство
 * `void logSystemError(...)` по всему проекту ОДНИМ изменением, без правки
 * полутора сотен вызовов.
 */

const inFlight = new Set<Promise<unknown>>();
let shuttingDown = false;

export function isShuttingDown(): boolean {
  return shuttingDown;
}

/** Зовётся один раз, в начале обработчика SIGTERM/SIGINT. Повторные вызовы — no-op. */
export function beginShutdown(): void {
  shuttingDown = true;
}

/** Только для тестов: вернуть флаг в исходное состояние между сценариями. */
export function __resetShutdownStateForTests(): void {
  shuttingDown = false;
  inFlight.clear();
}

/**
 * Зарегистрировать fire-and-forget промис, чтобы `drainBackgroundTasks()` мог
 * его дождаться перед `prisma.$disconnect()`. Промис возвращается как есть —
 * вызывающему ничего не нужно менять в своей цепочке `.catch(...)`.
 */
export function trackBackgroundTask<T>(promise: Promise<T>): Promise<T> {
  inFlight.add(promise);
  const untrack = () => inFlight.delete(promise);
  promise.then(untrack, untrack);
  return promise;
}

/**
 * Дождаться зарегистрированных фоновых задач с потолком времени. Дольше ждать
 * смысла нет: сервер и так уже закрывает соединения, а зависшая публикация не
 * должна держать выход дольше положенного (см. `SHUTDOWN_GRACE_MS` в index.ts).
 */
export async function drainBackgroundTasks(timeoutMs: number): Promise<void> {
  if (inFlight.size === 0) return;
  const settled = Promise.allSettled([...inFlight]);
  await new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, timeoutMs);
    timer.unref?.();
    settled.then(() => {
      clearTimeout(timer);
      resolve();
    });
  });
}

/**
 * Единая точка решения для мест, которые печатают отказ САМИ (`console.error`),
 * в обход `logSystemError`. Возвращает `true`, если вызывающий уже всё
 * напечатал (гонка при остановке) и дальше ничего делать не нужно; `false` —
 * значит это настоящий отказ, печатай/пиши как обычно.
 */
export function guardBackgroundFailure(label: string, err: unknown): boolean {
  if (!isShuttingDown()) return false;
  const message = err instanceof Error ? err.message : String(err);
  console.log(`[shutdown] фоновая задача «${label}» пропущена при остановке: ${message}`);
  return true;
}
