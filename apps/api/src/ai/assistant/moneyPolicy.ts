import { AssistantAttemptLimitError, type AssistantLimitReason } from "./attemptLimit.js";
import { noteAssistantLimit } from "./limitNotice.js";

// Standard paid-tier prices: https://ai.google.dev/gemini-api/docs/pricing
// Verified 2026-11-03. Flash introductory prices expire after 2026-12-31.
// Output includes thinking. No free allowance, caching discount or batch discount assumed.
export const MONEY_POLICY_EXPIRES = Date.UTC(2027, 0, 1);
/**
 * ПРЕДЕЛ ВХОДА ОДНОГО ВЫЗОВА: 32 768 → 65 536 (19.11.2026, разбор отказа на проде).
 * Замер базовой части запроса (система + описания инструментов) на сиде, без живых
 * вызовов: директор в CRM — 102 инструмента, 82,7 тыс. знаков описаний и 9,8 тыс.
 * знаков системы; Telegram — 48 инструментов, 36 тыс. и 15,3 тыс. знаков. Это около
 * 22–28 тыс. токенов в CRM (ОЦЕНКА по 3–4 знака на токен) — 70–85 % старого предела
 * ДО истории и результатов инструментов: два списка во втором шаге хода его рвали.
 * Цена вызова по резерву ниже (Pro, вход 65 536, выход 1 500 у помощницы):
 * 65 536 × 2 $/М + 1 500 × 12 $/М ≈ 0,149 $; при выходе 8 192 — 0,229 $. Ходовой
 * конверт 1 $ и дневной 30 $ не меняются и держат расход как прежде; 200 000 —
 * порог, после которого Google берёт за Pro вдвое дороже, предел обязан быть ниже.
 */
export const MAX_ASSISTANT_INPUT_TOKENS = 65_536;
export const MAX_ASSISTANT_OUTPUT_TOKENS = 8_192;
const RATES: Record<string, { input: number; output: number }> = {
  "gemini-3.1-pro-preview": { input: 200, output: 1200 },
  "gemini-3.6-flash": { input: 75, output: 375 },
}; // cents per million tokens; divide token*cents by 100 for microUSD.

export function moneyError(
  message: string,
  reason: AssistantLimitReason = "accounting_unavailable",
  measure?: { inputTokens: number; requestChars: number; limitTokens: number },
): AssistantAttemptLimitError {
  // Одна дверь журнала: любой отказ, о котором должно узнать руководство (дневной предел,
  // недоступный учёт, тарифы), пишется здесь, где бы его ни бросили (limitNotice.ts).
  noteAssistantLimit(reason);
  return new AssistantAttemptLimitError(reason, message, measure);
}

export function assertCurrentMoneyPolicy(now: number): void {
  if (!Number.isFinite(now) || now < Date.UTC(2026, 10, 3) || now >= MONEY_POLICY_EXPIRES) {
    throw moneyError("Тарифы Gemini требуют повторной проверки", "policy_expired");
  }
}

export function generationReservation(model: string, input: number, output: number, now: number): number {
  assertCurrentMoneyPolicy(now);
  if (!Object.hasOwn(RATES, model)) throw moneyError(`Неизвестный тариф Gemini: ${model}`, "policy_expired");
  if (Number.isSafeInteger(input) && input > MAX_ASSISTANT_INPUT_TOKENS) {
    throw moneyError("Запрос превышает установленный лимит входных токенов", "input_too_large");
  }
  if (!Number.isSafeInteger(input) || input < 1
    || !Number.isSafeInteger(output) || output < 1 || output > MAX_ASSISTANT_OUTPUT_TOKENS) {
    throw moneyError("Некорректный размер запроса Gemini", "unsupported_request");
  }
  const rate = RATES[model]!;
  return Number((BigInt(input) * BigInt(rate.input) + BigInt(output) * BigInt(rate.output) + 99n) / 100n);
}

/**
 * Сколько входных токенов ещё по карману в остатке конверта хода при этом выходе — тот же
 * тариф и то же округление вверх, что у generationReservation. 0 — не влезет ничего.
 */
export function affordableInputTokens(model: string, output: number, remainingMicroUsd: number): number {
  if (!Object.hasOwn(RATES, model) || !Number.isSafeInteger(remainingMicroUsd) || remainingMicroUsd <= 0) return 0;
  const rate = RATES[model]!;
  const left = BigInt(remainingMicroUsd) * 100n - BigInt(output) * BigInt(rate.output);
  if (left <= 0n) return 0;
  return Math.min(MAX_ASSISTANT_INPUT_TOKENS, Number(left / BigInt(rate.input)));
}

export function dollarLimit(value: string): number {
  if (!/^\d{1,4}(?:\.\d{1,6})?$/.test(value)) throw moneyError("Некорректный денежный лимит Gemini", "policy_expired");
  const [whole, fraction = ""] = value.split(".");
  const amount = BigInt(whole!) * 1_000_000n + BigInt(fraction.padEnd(6, "0"));
  if (amount <= 0n || amount > 2_147_483_647n) throw moneyError("Некорректный денежный лимит Gemini", "policy_expired");
  return Number(amount);
}
