import { dushanbeDayKey } from "@royal-home/shared";
import { logSystemError } from "../../lib/systemError.js";

/** Причины отказа денежной защиты (класс AssistantAttemptLimitError в attemptLimit.ts). */
export type AssistantLimitReason =
  /** Вход больше MAX_ASSISTANT_INPUT_TOKENS: сжать запрос и повторить, иначе «сузьте вопрос». */
  | "input_too_large"
  /** Попыток модели за один ход больше потолка хода. */
  | "attempt_cap"
  /** Денежный конверт одного хода (ASSISTANT_GEMINI_TURN_USD) исчерпан. */
  | "money_turn"
  /** Дневной денежный предел (ASSISTANT_GEMINI_DAILY_USD) исчерпан. */
  | "money_daily"
  /** Дневной потолок числа вызовов (ASSISTANT_GEMINI_DAILY_ATTEMPTS) исчерпан. */
  | "attempts_daily"
  /** База учёта или точный подсчёт токенов недоступны — закрыто при сбое. */
  | "accounting_unavailable"
  /** Тарифы устарели (MONEY_POLICY_EXPIRES) или модель без тарифа. */
  | "policy_expired"
  /** Запрос вне поддержанного тарифицируемого вида (наш код, не человек). */
  | "unsupported_request"
  /** Ход начался до полуночи по Душанбе, а платный шаг — после. */
  | "day_rollover"
  /** Ход отменён во время резервирования. */
  | "aborted";

/**
 * ЖУРНАЛ И УВЕДОМЛЕНИЕ РУКОВОДСТВУ ПО ОТКАЗАМ ДЕНЕЖНОЙ ЗАЩИТЫ — ОДНО МЕСТО (19.11.2026).
 *
 * Зовётся там, где отказ рождается (кошелёк хода, счётчик вызовов, подсчёт токенов), а
 * не в каждом входе (CRM, Telegram, голос, файлы): тогда дневной предел, исчерпанный
 * хоть на разборе чека, хоть в ответе помощницы, даёт ОДНУ запись и ОДИН пуш
 * директорам в день — ключ дедупа содержит день по Душанбе, а пуш «Новая проблема»
 * logSystemError шлёт только на первый раз за всю историю ключа.
 *
 * Слишком большой запрос, потолок шагов и конверт хода здесь не журналятся: это не
 * поломка, а размер вопроса, и решается сжатием или «сузьте вопрос» (assistant.ts).
 * Тексты без слов из BILLING_RE (lib/paymentReminders.ts): иначе напоминание
 * «пополните баланс поставщика» сработало бы ложно.
 */
const DAY_MS = 24 * 60 * 60 * 1000;

export function noteAssistantLimit(reason: AssistantLimitReason, now: number = Date.now()): void {
  if (reason === "money_daily" || reason === "attempts_daily") {
    const what = reason === "money_daily" ? "дневной предел расходов на ИИ" : "дневной предел числа вызовов ИИ";
    void logSystemError(
      "ai",
      `Помощница: ${what} исчерпан, до полуночи по Душанбе платные ответы остановлены. ` +
        `Предел меняется переменными ASSISTANT_GEMINI_DAILY_USD / ASSISTANT_GEMINI_DAILY_ATTEMPTS.`,
      { dedupKey: `assistant-${reason}:${dushanbeDayKey(now)}`, dedupWindowMs: DAY_MS },
    );
    return;
  }
  if (reason === "accounting_unavailable" || reason === "policy_expired" || reason === "unsupported_request") {
    const what = reason === "accounting_unavailable"
      ? "учёт расходов на ИИ недоступен (база счётчика или подсчёт токенов Google)"
      : reason === "policy_expired"
        ? "тарифы или пределы расходов Gemini требуют проверки (срок тарифов в moneyPolicy.ts, модель без тарифа или неверные ASSISTANT_GEMINI_*_USD)"
        : "запрос к Gemini вне поддержанного тарифицируемого вида";
    void logSystemError("ai", `Помощница временно недоступна: ${what}. Платные вызовы закрыты до починки.`, {
      dedupKey: `assistant-${reason}`,
    });
  }
}
