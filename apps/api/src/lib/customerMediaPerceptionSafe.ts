import { safeCauseCode } from "../ai/customerAgentCore.js";
import { logSystemError } from "./systemError.js";

/**
 * РАЗБОР ВЛОЖЕНИЯ НЕ РОНЯЕТ ХОД (часовая сверка 21.11.2026, прод: «Ход бота клиента остановлен: customer_core_unavailable
 * (RangeError)» — ошибка внутри разбора вложения без текста, клиенту тишина). Разбор медиа — необязательная часть хода:
 * контекст жив (не отмена, не срок, не новый ход) — ход идёт дальше без разбора, клиенту обычный ответ на вложение, причина —
 * в журнал (закрытый код, текст ошибки без слов клиента, место в нашем коде). Отмена, срок или сменившийся контекст — как
 * раньше: ошибка уходит наверх, ход не планируется на устаревшем входе. Если упала сама проверка контекста — наверх идёт
 * ИСХОДНАЯ ошибка разбора, и она же — в журнал (ревью #358).
 */
export async function perceiveCustomerMediaSafely<T>(input: {
  perceive: () => Promise<T>;
  wait: { signal: AbortSignal; deadlineAt: number };
  current: (wait: { signal: AbortSignal; deadlineAt: number }) => Promise<boolean>;
}): Promise<T | undefined> {
  try {
    return await input.perceive();
  } catch (error) {
    if (input.wait.signal.aborted || Date.now() >= input.wait.deadlineAt) throw error;
    let alive: boolean;
    try {
      alive = await input.current(input.wait);
    } catch {
      logPerceptionFailure(error, "ход остановлен, проверка контекста не удалась");
      throw error;
    }
    if (!alive) throw error;
    logPerceptionFailure(error, "ход без разбора");
    return undefined;
  }
}

function logPerceptionFailure(error: unknown, outcome: string): void {
  const cause = safeCauseCode(error);
  const frame = error instanceof Error ? (error.stack ?? "").split("\n")
    .find(line => /apps[\\/]api[\\/](?:src|dist)|\/app\/(?:src|dist)\//u.test(line))?.trim().replace(/^at\s+/u, "").slice(0, 200) : undefined;
  const message = error instanceof Error && error.message ? ` «${error.message.replace(/\s+/gu, " ").slice(0, 120)}»` : "";
  void logSystemError("ai", `Разбор вложения не удался, ${outcome}: ${cause}${message}${frame ? ` в ${frame}` : ""}`,
    { dedupKey: `customer-media-perception:${cause}:${frame ?? "-"}`, quietPult: true });
}
