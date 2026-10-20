/**
 * Запускает `fn` по всем элементам с ограничением одновременности, СОХРАНЯЯ
 * ПОРЯДОК результатов независимо от того, какой элемент ответил первым —
 * важно везде, где куски потом собираются обратно по порядку (расшифровка
 * разговора по кускам, склейка клипов автомонтажа).
 *
 * Вынесено из lib/telephony/callRecordings.ts (31.08.2026) в общий модуль —
 * второе место (lib/reelsAutoMontage.ts), которому нужен тот же приём
 * («несколько независимых внешних вызовов, но не толпой»), не должно
 * копипастить воркер-пул заново.
 */
export async function mapWithConcurrency<T, R>(
  items: T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>
): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let next = 0;
  async function worker(): Promise<void> {
    for (;;) {
      const index = next++;
      if (index >= items.length) return;
      results[index] = await fn(items[index], index);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}

/**
 * Вариант `mapWithConcurrency` для набора РАЗНОРОДНЫХ задач (не один и тот же
 * `fn` на список элементов, а N разных промисов — ровно форма голого
 * `Promise.all([...])`, только с ограниченной конкурентностью).
 *
 * Найдено на приёмке 08.09.2026: `routes/oversight.ts` (`/summary`) и
 * `routes/dashboard.ts` (`/counters`) собирали данные через `Promise.all` из
 * 9–11 задач, каждая из которых сама ходит в БД (часть — несколькими
 * запросами внутри). При 6 одновременных пользователях это упирается в лимит
 * соединений Prisma (`connection_limit`) быстрее, чем кажется: `Promise.all`
 * запускает все задачи СРАЗУ, а не по мере освобождения соединений.
 *
 * Как и `Promise.all`, при первом отказе весь вызов реджектится тем же
 * исключением; остальные задачи доигрывают в фоне, их результат просто
 * отбрасывается (то же поведение, что было бы у отклонённых параллельно
 * промисов внутри `Promise.all`).
 */
export async function runLimited<T extends readonly unknown[]>(
  tasks: { [K in keyof T]: () => Promise<T[K]> },
  limit: number
): Promise<T> {
  const results = await mapWithConcurrency(tasks as unknown as Array<() => Promise<unknown>>, limit, (task) => task());
  return results as unknown as T;
}

/**
 * Пул соединений Prisma исчерпан (`connection_limit`/`pool_timeout` в
 * `DATABASE_URL`) — код ошибки Prisma P2024, либо (на старых версиях клиента)
 * текст «Timed out fetching a new connection from the connection pool».
 * Отличать от «настоящих» ошибок важно там, где иначе временный отказ пула
 * читается как «токен недействителен»/«агент не найден» и разлогинивает
 * пользователя вместо того, чтобы попросить его повторить запрос (найдено на
 * приёмке 08.09.2026: requireAuth и POST /auth/refresh делили один и тот же
 * catch на обе причины).
 *
 * ПОСЛЕ ПЕРЕХОДА НА PRISMA 7 ДЕТЕКТОР ОСЛЕП (аудит 23.09.2026, круг 3, №71).
 * С `@prisma/adapter-pg` пул — это `pg.Pool`, и исчерпанный пул бросает его
 * собственную голую ошибку «timeout exceeded when trying to connect», без
 * кода P2024; лежащая или перезапускающаяся база приходит как P1001 с
 * `meta.driverAdapterError.cause.kind = "DatabaseNotReachable"` (оба вида сняты
 * живым прогоном на этом драйвере). Ни то, ни другое прежняя проверка не
 * узнавала: пул кончился — 500 вместо 503 без повтора на клиенте, а
 * /auth/refresh на любую такую ошибку стирал вход и выкидывал агента из CRM.
 */
export function isPoolExhaustionError(err: unknown): boolean {
  const code = (err as { code?: unknown } | null)?.code;
  if (code === "P2024") return true;
  const message = err instanceof Error ? err.message : String(err);
  return /timed out fetching a new connection|timeout exceeded when trying to connect/i.test(message);
}

/** Коды Prisma «база недоступна/соединение оборвалось»: P1001 не достучались,
 *  P1002 истекло время, P1008 операция не уложилась, P1017 сервер закрыл соединение. */
const TRANSIENT_DB_CODES = new Set(["P1001", "P1002", "P1008", "P1017"]);
const TRANSIENT_ADAPTER_KINDS = new Set([
  "DatabaseNotReachable",
  "ConnectionClosed",
  "SocketTimeout",
  "TooManyConnections",
  "TransactionAlreadyClosed",
]);

/**
 * Временный отказ базы: пул занят, база перезапускается, соединение оборвалось.
 * Правильный ответ на такое — «повторите» (503), а не «вы никто» (401) и не
 * «баг» (500): через секунду тот же запрос пройдёт.
 */
export function isTransientDbError(err: unknown): boolean {
  if (isPoolExhaustionError(err)) return true;
  const e = err as { code?: unknown; meta?: { driverAdapterError?: { cause?: { kind?: unknown } } }; cause?: { kind?: unknown } } | null;
  if (typeof e?.code === "string" && TRANSIENT_DB_CODES.has(e.code)) return true;
  const kind = e?.meta?.driverAdapterError?.cause?.kind ?? e?.cause?.kind;
  if (typeof kind === "string" && TRANSIENT_ADAPTER_KINDS.has(kind)) return true;
  const message = err instanceof Error ? err.message : "";
  return /Connection terminated unexpectedly|ECONNREFUSED|the database system is (starting up|shutting down)/i.test(message);
}
