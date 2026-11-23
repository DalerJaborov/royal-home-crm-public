import { noteAssistantLimit, type AssistantLimitReason } from "./limitNotice.js";

export type { AssistantLimitReason };

/**
 * ПОЧЕМУ ПЛАТНЫЙ ВЫЗОВ НЕ ПУЩЕН — ТОЧНОЙ ПРИЧИНОЙ, А НЕ ОДНИМ «ЛИМИТОМ» (19.11.2026).
 *
 * До этого дня любой отказ денежной защиты был одним классом с одним текстом
 * «лимит вызовов ИИ достигнут или учёт расходов недоступен». На проде 19.11 так
 * выглядел СЛИШКОМ БОЛЬШОЙ ЗАПРОС (вход больше предела токенов), хотя денег за
 * день было потрачено 1,47 $ из 30: сотрудники решили, что деньги кончились и
 * помощница не работает. Код `assistant_attempt_limit` и статус 402 остаются
 * общими — по ним все пути (повторы geminiClient, поиск) узнают «не повторять».
 * Различает отказы только `reason`.
 */
export class AssistantAttemptLimitError extends Error {
  readonly code = "assistant_attempt_limit";
  readonly status = 402; // Terminal locally; never retry a failed reservation.
  constructor(
    readonly reason: AssistantLimitReason = "attempt_cap",
    message = "Достигнут лимит вызовов ИИ или недоступен учёт расходов",
    /** Только для input_too_large: точный подсчёт Google и размер тела, по которым сжимаем. */
    readonly measure?: { inputTokens: number; requestChars: number; limitTokens: number },
  ) {
    super(message);
  }
}

/** Причина отказа денежной защиты или null — по коду, а не instanceof: узкие подмены в тестах класса не отдают. */
export function assistantLimitReasonOf(err: unknown): AssistantLimitReason | null {
  const e = err as { code?: unknown; reason?: unknown } | null;
  if (!e || e.code !== "assistant_attempt_limit") return null;
  return typeof e.reason === "string" ? (e.reason as AssistantLimitReason) : "attempt_cap";
}

/** Точный подсчёт Google у отказа «велик вход» — по нему сжатие решает, сколько убрать. */
export function assistantLimitMeasureOf(err: unknown): AssistantAttemptLimitError["measure"] | null {
  return err instanceof AssistantAttemptLimitError ? err.measure ?? null : null;
}

/**
 * ПРЕДЕЛ ПОПЫТОК ХОДА — ИЗ ЧИСЛА ШАГОВ НАСТРОЕК, А НЕ ОТДЕЛЬНОЙ КОНСТАНТОЙ (17.11.2026).
 * Было 9 попыток при Settings.aiAssistantMaxRounds = 30: каждый повтор после 503 и каждая
 * запасная модель тратят тот же счётчик (geminiClient.ts, callGeminiToolsWithRetries), и
 * оба сбоя attempt_limit на проде случились на 4–5 шаге, задолго до тридцатого. Теперь —
 * попытка на шаг плюс запас на повторы (четверть шагов, не меньше трёх), но не больше ATTEMPT_CAP_CEILING.
 * Отказ по этому пределу — reason «attempt_cap» (одна шкала причин, limitNotice.ts); что сказать
 * человеку — решает ход помощницы (assistant.ts: честная остановка, «сузьте вопрос» при отказах
 * по размеру, «ИИ перегружен», если попытки съели повторы после сбоя Google).
 */
export function assistantTurnAttemptCap(maxRounds: number): number {
  const rounds = Number.isSafeInteger(maxRounds) && maxRounds > 0 ? maxRounds : 1;
  return Math.min(ATTEMPT_CAP_CEILING, rounds + Math.max(3, Math.ceil(rounds / 4)));
}

/**
 * Потолок попыток одного хода (ревью волны 2, 22.11.2026): каждая попытка — платный вызов Gemini, и
 * «шаги настроек + половина» давали 45 вызовов на один вопрос. Оба сбоя прода случились на 4–5 шаге из 9,
 * то есть хватает запаса вдвое-втрое; 15 — это девять прежних плюс повторы после 503 и запасная модель.
 */
export const ATTEMPT_CAP_CEILING = 15;

/** Reservations are intentionally not refunded after an uncertain provider outcome. */
export function createAssistantAttemptLimit(reserve: () => Promise<boolean>, maximum = 9) {
  let used = 0;
  const take = async () => {
    if (used >= maximum) throw new AssistantAttemptLimitError("attempt_cap", "Слишком много шагов модели за один ответ");
    used++;
    let allowed = false;
    try {
      allowed = await reserve();
    } catch (err) {
      // Уже названный отказ (кривая настройка) — как есть, с записью в журнал.
      if (err instanceof AssistantAttemptLimitError) {
        noteAssistantLimit(err.reason);
        throw err;
      }
      // Accounting unavailable: fail closed.
      noteAssistantLimit("accounting_unavailable");
      throw new AssistantAttemptLimitError("accounting_unavailable", "Недоступен учёт вызовов ИИ");
    }
    if (!allowed) {
      noteAssistantLimit("attempts_daily");
      throw new AssistantAttemptLimitError("attempts_daily", "Дневной предел вызовов ИИ исчерпан");
    }
  };
  /** Сколько попыток хода осталось: на последней модель получает приказ «ответь по найденному». */
  return Object.assign(take, { remaining: () => Math.max(0, maximum - used) });
}
