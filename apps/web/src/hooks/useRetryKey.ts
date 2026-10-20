import { useMemo, useRef } from "react";
import { ApiError, newIdempotencyKey } from "../lib/api";
import { isInProgressError } from "../lib/apiError";

/**
 * КЛЮЧ ПОВТОРА ДЛЯ ФОРМЫ (23.09.2026, apps/api/src/lib/idempotency.ts).
 *
 * Одно намерение — один ключ. Пока ответа нет (обрыв связи, наш таймер,
 * запрос ушёл в офлайн-очередь, сервер ответил «ещё выполняется»), повторное «Сохранить» идёт с ТЕМ ЖЕ ключом:
 * сервер либо отдаст уже созданную запись, либо скажет «ещё выполняется», но
 * второй не создаст. Как только сервер ответил хоть чем-то (успех, «похожий
 * клиент уже есть», ошибка проверки) — ключ сбрасывается: следующее нажатие
 * это уже новое намерение, часто с другими данными (force, исправленное поле).
 */
export interface RetryKey {
  current(): string;
  /** Звать с результатом попытки: сбрасывает ключ, если сервер ответил. */
  settle(err?: unknown): void;
}

export function useRetryKey(): RetryKey {
  const ref = useRef<string | null>(null);
  return useMemo(
    () => ({
      current() {
        if (!ref.current) ref.current = newIdempotencyKey();
        return ref.current;
      },
      settle(err?: unknown) {
        // 409 inProgress: первая попытка ещё идёт на сервере. Ключ остаётся, иначе
        // следующее нажатие возьмёт новый и обойдёт защиту от дубля (WEB-06).
        if (isInProgressError(err)) return;
        if (err === undefined || err instanceof ApiError) ref.current = null;
      },
    }),
    []
  );
}

/** Обёртка вызова под ключ формы: сама решает, сбрасывать ли ключ. */
export async function withRetryKey<T>(retryKey: RetryKey | undefined, run: (key: string | undefined) => Promise<T>): Promise<T> {
  try {
    const result = await run(retryKey?.current());
    retryKey?.settle();
    return result;
  } catch (err) {
    retryKey?.settle(err);
    throw err;
  }
}
