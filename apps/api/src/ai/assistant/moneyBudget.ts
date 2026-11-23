import { Prisma } from "../../generated/prisma/client.js";
import { prisma } from "../../db.js";
import { dushanbeDayKey } from "@royal-home/shared";
import type { AssistantProviderAttempt } from "../geminiClient.js";
import type { EmbeddingAttemptMetadata } from "../embeddings.js";
import { geminiProxyHeaders, geminiUrl } from "../geminiTransport.js";
import { affordableInputTokens, assertCurrentMoneyPolicy, dollarLimit, generationReservation, MAX_ASSISTANT_INPUT_TOKENS, moneyError } from "./moneyPolicy.js";
import { assistantLimitReasonOf } from "./attemptLimit.js";

/** Меньше этого ужимать запрос под остаток конверта бессмысленно: ответ не соберётся. */
const MIN_AFFORDABLE_INPUT_TOKENS = 4_096;

type DailyReservation = (amount: number, day: string, limit: number) => Promise<boolean>;
export interface AssistantMoneyWallet {
  reserve(amountMicroUsd: number, signal?: AbortSignal): Promise<void>;
  /** Остаток конверта хода, microUSD: по нему ход решает, стоит ли ужать запрос под остаток. */
  remaining?(): number;
}
interface WalletOptions {
  dailyUsd?: string;
  turnUsd?: string;
  now?: () => number;
  reserveDaily?: DailyReservation;
}

async function reserveDaily(amount: number, day: string, limit: number): Promise<boolean> {
  const rows = await prisma.$queryRaw<{ count: number }[]>(Prisma.sql`
    INSERT INTO "AgentAiActionCounter" ("id", "agentId", "action", "day", "count", "createdAt", "updatedAt")
    VALUES (gen_random_uuid()::text, 'assistant-gemini-global', 'assistant-gemini-reserved-microusd', ${day}, ${amount}, now(), now())
    ON CONFLICT ("agentId", "action", "day") DO UPDATE
    SET "count" = "AgentAiActionCounter"."count" + EXCLUDED."count", "updatedAt" = now()
    WHERE "AgentAiActionCounter"."count" <= ${limit - amount}
    RETURNING "count"
  `);
  return rows.length === 1;
}

/** Conservative reserved envelope, NOT actual billing. Holds are never refunded, including timeout/error.
 * Share one wallet for all generation and embedding attempts within a single assistant turn.
 * The global database counter coordinates different processes. Other products/ElevenLabs are outside this cap.
 */
export function createAssistantMoneyWallet(options: WalletOptions = {}): AssistantMoneyWallet {
  const now = options.now ?? Date.now;
  // docker-compose пробрасывает незаданную переменную пустой строкой (`${VAR:-}`), поэтому `??` мало: пусто = не задано.
  const daily = dollarLimit(options.dailyUsd?.trim() || process.env.ASSISTANT_GEMINI_DAILY_USD?.trim() || "30");
  const turn = dollarLimit(options.turnUsd?.trim() || process.env.ASSISTANT_GEMINI_TURN_USD?.trim() || "1");
  const day = dushanbeDayKey(now());
  let used = 0;
  // Отказ называется своей причиной (19.11.2026): «конверт хода», «дневной предел» и
  // «учёт недоступен» — три разных ответа человеку, а не один «лимит».
  return { async reserve(amount, signal) {
    if (signal?.aborted) throw moneyError("Резерв отменён", "aborted");
    if (day !== dushanbeDayKey(now())) throw moneyError("Ход перешёл через полночь по Душанбе", "day_rollover");
    if (!Number.isSafeInteger(amount) || amount <= 0) throw moneyError("Некорректная сумма резерва Gemini", "unsupported_request");
    if (amount > daily) {
      // Предел дня меньше одного вызова — это настройка, а не исчерпанный день (ревью 19.11).
      throw moneyError("Один вызов дороже дневного денежного лимита Gemini: проверьте ASSISTANT_GEMINI_DAILY_USD", "policy_expired");
    }
    if (used + amount > turn) throw moneyError("Достигнут денежный лимит Gemini на один ответ", "money_turn");
    used += amount; // Synchronous claim prevents concurrent calls overspending the turn.
    let allowed: boolean;
    try {
      allowed = await (options.reserveDaily ?? reserveDaily)(amount, day, daily);
    } catch {
      // Fail closed: an uncertain database outcome is never refunded or retried.
      throw moneyError("Недоступен денежный резерв Gemini", "accounting_unavailable");
    }
    if (signal?.aborted) throw moneyError("Резерв отменён", "aborted");
    if (day !== dushanbeDayKey(now())) throw moneyError("Ход перешёл через полночь по Душанбе", "day_rollover");
    if (!allowed) {
      throw moneyError("Достигнут дневной денежный лимит Gemini", "money_daily");
    }
  }, remaining: () => Math.max(0, turn - used) };
}

interface GuardOptions { wallet?: AssistantMoneyWallet; fetch?: typeof fetch; now?: () => number }

function validateBody(attempt: AssistantProviderAttempt): { serialized: string; output: number } {
  if (attempt.kind !== "generate") throw moneyError("Поиск Google недоступен при строгом денежном лимите", "unsupported_request");
  const body = attempt.body;
  const permitted = new Set(["contents", "systemInstruction", "tools", "toolConfig", "generationConfig", "safetySettings"]);
  if (Object.keys(body).some(key => !permitted.has(key))) throw moneyError("Неподдерживаемые параметры тарификации Gemini", "unsupported_request");
  const config = body.generationConfig as Record<string, unknown> | undefined;
  if (!config || (config.candidateCount !== undefined && config.candidateCount !== 1)
    || config.responseModalities !== undefined) throw moneyError("Неподдерживаемый режим генерации Gemini", "unsupported_request");
  const tools = body.tools;
  if (tools !== undefined && (!Array.isArray(tools) || tools.some(tool => !tool || typeof tool !== "object"
    || Object.keys(tool).some(key => key !== "functionDeclarations")))) throw moneyError("Платные встроенные инструменты не разрешены", "unsupported_request");
  const serialized = JSON.stringify(body);
  if (Buffer.byteLength(serialized) > 6 * 1024 * 1024) throw moneyError("Слишком большой запрос Gemini", "input_too_large");
  // Inspect only content parts, never user text or arbitrary function argument keys.
  const contents = [body.systemInstruction, ...(Array.isArray(body.contents) ? body.contents : [])].filter(Boolean);
  for (const content of contents) {
    const parts = (content as { parts?: unknown }).parts;
    if (!Array.isArray(parts)) throw moneyError("Некорректное содержимое Gemini", "unsupported_request");
    for (const part of parts) {
      if (!part || typeof part !== "object") throw moneyError("Некорректная часть запроса Gemini", "unsupported_request");
      const record = part as Record<string, unknown>;
      const allowedParts = new Set(["text", "functionCall", "functionResponse", "thoughtSignature", "thought", "inlineData", "inline_data"]);
      if (Object.keys(record).some(key => !allowedParts.has(key))) throw moneyError("Неподдерживаемые медиа Gemini", "unsupported_request");
      const media = (record.inlineData ?? record.inline_data) as Record<string, unknown> | undefined;
      if (media) {
        const mime = media.mimeType ?? media.mime_type;
        if (attempt.model !== "gemini-3.1-pro-preview" || typeof mime !== "string"
          || !/^(image\/(jpeg|png|webp)|application\/pdf|audio\/(ogg|mpeg|mp3|mp4|wav|webm))$/.test(mime)
          || typeof media.data !== "string") throw moneyError("Неподдерживаемые медиа Gemini", "unsupported_request");
      }
    }
  }
  return { serialized, output: config.maxOutputTokens as number };
}

// Ошибки здесь — простые: их ловит и переводит в один отказ «учёт недоступен» вызывающий
// (иначе журнал получил бы две строки на один сбой подсчёта).
async function readCount(response: Response): Promise<number> {
  if (!response.ok || !response.body) throw new Error("Не удалось подсчитать токены Gemini");
  const reader = response.body.getReader();
  let size = 0;
  const chunks: Uint8Array[] = [];
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      size += value.length;
      if (size > 16_384) throw new Error("Некорректный ответ подсчёта токенов");
      chunks.push(value);
    }
    const result: unknown = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    if (!result || typeof result !== "object" || !("totalTokens" in result)
      || !Number.isSafeInteger(result.totalTokens) || Number(result.totalTokens) < 1) throw new Error("Некорректный ответ подсчёта токенов");
    return Number(result.totalTokens);
  } finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
}

export function createAssistantMoneyGuard(options: GuardOptions = {}) {
  const now = options.now ?? Date.now;
  const wallet = options.wallet ?? createAssistantMoneyWallet({ now });
  return async (attempt: AssistantProviderAttempt): Promise<void> => {
    const { serialized, output } = validateBody(attempt);
    generationReservation(attempt.model, 1, output, now()); // Unknown/expired rates rejected before network.
    const signal = AbortSignal.any([...(attempt.signal ? [attempt.signal] : []), AbortSignal.timeout(8_000)]);
    if (signal.aborted) throw moneyError("Подсчёт токенов отменён", "aborted");
    let input: number;
    try {
      const response = await (options.fetch ?? fetch)(geminiUrl(`/v1beta/models/${attempt.model}:countTokens`), {
        method: "POST", redirect: "error", signal,
        headers: { "Content-Type": "application/json", ...geminiProxyHeaders(), "x-goog-api-key": attempt.apiKey },
        body: JSON.stringify({ generateContentRequest: { ...JSON.parse(serialized), model: `models/${attempt.model}` } }),
      });
      input = await readCount(response);
    } catch {
      // Отмена хода — «aborted»; истёкшие 8 с подсчёта — это недоступный учёт, а не отмена.
      if (attempt.signal?.aborted) throw moneyError("Подсчёт токенов отменён", "aborted");
      throw moneyError("Недоступен точный подсчёт токенов Gemini");
    }
    if (signal.aborted) throw moneyError("Подсчёт токенов отменён", attempt.signal?.aborted ? "aborted" : "accounting_unavailable");
    if (JSON.stringify(attempt.body) !== serialized) throw moneyError("Запрос Gemini изменился после подсчёта", "unsupported_request");
    // Слишком большой вход — не отказ, а повод сжать запрос (assistant.ts): точный подсчёт
    // Google и длина тела нужны, чтобы понять, сколько убрать. Денег до этой точки не взято.
    if (input > MAX_ASSISTANT_INPUT_TOKENS) {
      throw moneyError("Запрос превышает установленный лимит входных токенов", "input_too_large",
        { inputTokens: input, requestChars: serialized.length, limitTokens: MAX_ASSISTANT_INPUT_TOKENS });
    }
    try {
      await wallet.reserve(generationReservation(attempt.model, input, output, now()), signal);
    } catch (err) {
      // Конверт хода кончается: если ужатый запрос ещё влезет в остаток — ход сожмёт и повторит
      // (тот же путь, что у «велик вход»), иначе отказ как был.
      const affordable = assistantLimitReasonOf(err) === "money_turn" && wallet.remaining
        ? affordableInputTokens(attempt.model, output, wallet.remaining()) : 0;
      if (affordable >= MIN_AFFORDABLE_INPUT_TOKENS && affordable < input) {
        throw moneyError("Достигнут денежный лимит Gemini на один ответ", "money_turn",
          { inputTokens: input, requestChars: serialized.length, limitTokens: affordable });
      }
      throw err;
    }
    if (JSON.stringify(attempt.body) !== serialized) throw moneyError("Запрос Gemini изменился после резервирования", "unsupported_request");
  };
}

export function createAssistantEmbeddingMoneyGuard(options: Pick<GuardOptions, "wallet" | "now"> = {}) {
  const now = options.now ?? Date.now;
  const wallet = options.wallet ?? createAssistantMoneyWallet({ now });
  return async (attempt: EmbeddingAttemptMetadata): Promise<void> => {
    assertCurrentMoneyPolicy(now());
    if (attempt.model !== "gemini-embedding-001" || !Number.isSafeInteger(attempt.inputCharacters)
      || attempt.inputCharacters < 1 || attempt.inputCharacters > 1200 || attempt.outputDimensions !== 768
      || !["RETRIEVAL_DOCUMENT", "RETRIEVAL_QUERY"].includes(attempt.taskType)) throw moneyError("Неподдерживаемый тариф или размер эмбеддинга Gemini", "unsupported_request");
    // Model's full 2048-token input limit at $0.15/M, rounded UP to integer microUSD.
    // https://ai.google.dev/gemini-api/docs/embeddings ; no character/token equivalence assumed.
    await wallet.reserve(308);
  };
}
