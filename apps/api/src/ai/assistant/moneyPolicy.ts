import { AssistantAttemptLimitError } from "./attemptLimit.js";

// Standard paid-tier prices: https://ai.google.dev/gemini-api/docs/pricing
// Verified 2026-11-03. Flash introductory prices expire after 2026-12-31.
// Output includes thinking. No free allowance, caching discount or batch discount assumed.
export const MONEY_POLICY_EXPIRES = Date.UTC(2027, 0, 1);
export const MAX_ASSISTANT_INPUT_TOKENS = 32_768;
export const MAX_ASSISTANT_OUTPUT_TOKENS = 8_192;
const RATES: Record<string, { input: number; output: number }> = {
  "gemini-3.1-pro-preview": { input: 200, output: 1200 },
  "gemini-3.6-flash": { input: 75, output: 375 },
}; // cents per million tokens; divide token*cents by 100 for microUSD.

export function moneyError(message: string): AssistantAttemptLimitError {
  const error = new AssistantAttemptLimitError();
  error.message = message;
  return error;
}

export function assertCurrentMoneyPolicy(now: number): void {
  if (!Number.isFinite(now) || now < Date.UTC(2026, 10, 3) || now >= MONEY_POLICY_EXPIRES) {
    throw moneyError("Тарифы Gemini требуют повторной проверки");
  }
}

export function generationReservation(model: string, input: number, output: number, now: number): number {
  assertCurrentMoneyPolicy(now);
  if (!Object.hasOwn(RATES, model)) throw moneyError(`Неизвестный тариф Gemini: ${model}`);
  if (!Number.isSafeInteger(input) || input < 1 || input > MAX_ASSISTANT_INPUT_TOKENS
    || !Number.isSafeInteger(output) || output < 1 || output > MAX_ASSISTANT_OUTPUT_TOKENS) {
    throw moneyError("Запрос превышает установленный лимит токенов");
  }
  const rate = RATES[model]!;
  return Number((BigInt(input) * BigInt(rate.input) + BigInt(output) * BigInt(rate.output) + 99n) / 100n);
}

export function dollarLimit(value: string): number {
  if (!/^\d{1,4}(?:\.\d{1,6})?$/.test(value)) throw moneyError("Некорректный денежный лимит Gemini");
  const [whole, fraction = ""] = value.split(".");
  const amount = BigInt(whole!) * 1_000_000n + BigInt(fraction.padEnd(6, "0"));
  if (amount <= 0n || amount > 2_147_483_647n) throw moneyError("Некорректный денежный лимит Gemini");
  return Number(amount);
}
