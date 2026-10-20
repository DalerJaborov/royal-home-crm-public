/**
 * Ошибка API — в отдельном модуле, а не в `api.ts`, чтобы её могли использовать
 * и вызывающий код, и офлайн-очередь, не создавая цикла импортов.
 *
 * Модуль намеренно ни от чего не зависит: он на дне графа.
 */
export class ApiError extends Error {
  status: number;
  data: unknown;
  /** Только для 429 — сколько миллисекунд ждать до следующей попытки, взято
   *  из заголовка Retry-After или RateLimit-Reset (lib/api.ts). Читают:
   *  cooldown-ветка в lib/api.ts (отказ без сети, пока идёт пауза) и
   *  retryDelay в lib/queryClient.ts (пауза перед единственным авто-повтором). */
  retryAfterMs?: number;

  constructor(message: string, status: number, data: unknown, retryAfterMs?: number) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.data = data;
    this.retryAfterMs = retryAfterMs;
  }
}

export function isReadOnlyRoleError(error: unknown): boolean {
  return error instanceof ApiError && error.status === 403 && !!error.data && typeof error.data === "object" && "code" in error.data && error.data.code === "READ_ONLY_ROLE";
}

/**
 * «Первая попытка с этим ключом повтора ещё выполняется на сервере» (409 с
 * признаком inProgress, apps/api/src/lib/idempotency.ts). Это не отказ по сути:
 * ключ и запись держим, результат первой попытки заберёт следующий повтор.
 */
export function isInProgressError(err: unknown): boolean {
  return (
    err instanceof ApiError &&
    err.status === 409 &&
    (err.data as { inProgress?: boolean } | undefined)?.inProgress === true
  );
}
