import { Prisma } from "../../generated/prisma/client.js";
import { prisma } from "../../db.js";
import { dushanbeDayKey } from "@royal-home/shared";
import type { AssistantProviderAttempt } from "../geminiClient.js";
import type { EmbeddingAttemptMetadata } from "../embeddings.js";
import { geminiProxyHeaders, geminiUrl } from "../geminiTransport.js";
import { assertCurrentMoneyPolicy, dollarLimit, generationReservation, moneyError } from "./moneyPolicy.js";

type DailyReservation = (amount: number, day: string, limit: number) => Promise<boolean>;
export interface AssistantMoneyWallet { reserve(amountMicroUsd: number, signal?: AbortSignal): Promise<void> }
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
  return { async reserve(amount, signal) {
    if (signal?.aborted || day !== dushanbeDayKey(now()) || !Number.isSafeInteger(amount) || amount <= 0
      || amount > daily || used + amount > turn) throw moneyError("Достигнут денежный лимит Gemini");
    used += amount; // Synchronous claim prevents concurrent calls overspending the turn.
    let allowed = false;
    try { allowed = await (options.reserveDaily ?? reserveDaily)(amount, day, daily); } catch { /* Fail closed. */ }
    if (!allowed || signal?.aborted || day !== dushanbeDayKey(now())) throw moneyError("Недоступен денежный резерв Gemini");
  } };
}

interface GuardOptions { wallet?: AssistantMoneyWallet; fetch?: typeof fetch; now?: () => number }

function validateBody(attempt: AssistantProviderAttempt): { serialized: string; output: number } {
  if (attempt.kind !== "generate") throw moneyError("Поиск Google недоступен при строгом денежном лимите");
  const body = attempt.body;
  const permitted = new Set(["contents", "systemInstruction", "tools", "toolConfig", "generationConfig", "safetySettings"]);
  if (Object.keys(body).some(key => !permitted.has(key))) throw moneyError("Неподдерживаемые параметры тарификации Gemini");
  const config = body.generationConfig as Record<string, unknown> | undefined;
  if (!config || (config.candidateCount !== undefined && config.candidateCount !== 1)
    || config.responseModalities !== undefined) throw moneyError("Неподдерживаемый режим генерации Gemini");
  const tools = body.tools;
  if (tools !== undefined && (!Array.isArray(tools) || tools.some(tool => !tool || typeof tool !== "object"
    || Object.keys(tool).some(key => key !== "functionDeclarations")))) throw moneyError("Платные встроенные инструменты не разрешены");
  const serialized = JSON.stringify(body);
  if (Buffer.byteLength(serialized) > 6 * 1024 * 1024) throw moneyError("Слишком большой запрос Gemini");
  // Inspect only content parts, never user text or arbitrary function argument keys.
  const contents = [body.systemInstruction, ...(Array.isArray(body.contents) ? body.contents : [])].filter(Boolean);
  for (const content of contents) {
    const parts = (content as { parts?: unknown }).parts;
    if (!Array.isArray(parts)) throw moneyError("Некорректное содержимое Gemini");
    for (const part of parts) {
      if (!part || typeof part !== "object") throw moneyError("Некорректная часть запроса Gemini");
      const record = part as Record<string, unknown>;
      const allowedParts = new Set(["text", "functionCall", "functionResponse", "thoughtSignature", "thought", "inlineData", "inline_data"]);
      if (Object.keys(record).some(key => !allowedParts.has(key))) throw moneyError("Неподдерживаемые медиа Gemini");
      const media = (record.inlineData ?? record.inline_data) as Record<string, unknown> | undefined;
      if (media) {
        const mime = media.mimeType ?? media.mime_type;
        if (attempt.model !== "gemini-3.1-pro-preview" || typeof mime !== "string"
          || !/^(image\/(jpeg|png|webp)|application\/pdf|audio\/(ogg|mpeg|mp3|mp4|wav|webm))$/.test(mime)
          || typeof media.data !== "string") throw moneyError("Неподдерживаемые медиа Gemini");
      }
    }
  }
  return { serialized, output: config.maxOutputTokens as number };
}

async function readCount(response: Response): Promise<number> {
  if (!response.ok || !response.body) throw moneyError("Не удалось подсчитать токены Gemini");
  const reader = response.body.getReader();
  let size = 0;
  const chunks: Uint8Array[] = [];
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      size += value.length;
      if (size > 16_384) throw moneyError("Некорректный ответ подсчёта токенов");
      chunks.push(value);
    }
    const result: unknown = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    if (!result || typeof result !== "object" || !("totalTokens" in result)
      || !Number.isSafeInteger(result.totalTokens) || Number(result.totalTokens) < 1) throw moneyError("Некорректный ответ подсчёта токенов");
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
    if (signal.aborted) throw moneyError("Подсчёт токенов отменён");
    let input: number;
    try {
      const response = await (options.fetch ?? fetch)(geminiUrl(`/v1beta/models/${attempt.model}:countTokens`), {
        method: "POST", redirect: "error", signal,
        headers: { "Content-Type": "application/json", ...geminiProxyHeaders(), "x-goog-api-key": attempt.apiKey },
        body: JSON.stringify({ generateContentRequest: { ...JSON.parse(serialized), model: `models/${attempt.model}` } }),
      });
      input = await readCount(response);
    } catch { throw moneyError("Недоступен точный подсчёт токенов Gemini"); }
    if (signal.aborted || JSON.stringify(attempt.body) !== serialized) throw moneyError("Запрос Gemini изменился после подсчёта");
    await wallet.reserve(generationReservation(attempt.model, input, output, now()), signal);
    if (JSON.stringify(attempt.body) !== serialized) throw moneyError("Запрос Gemini изменился после резервирования");
  };
}

export function createAssistantEmbeddingMoneyGuard(options: Pick<GuardOptions, "wallet" | "now"> = {}) {
  const now = options.now ?? Date.now;
  const wallet = options.wallet ?? createAssistantMoneyWallet({ now });
  return async (attempt: EmbeddingAttemptMetadata): Promise<void> => {
    assertCurrentMoneyPolicy(now());
    if (attempt.model !== "gemini-embedding-001" || !Number.isSafeInteger(attempt.inputCharacters)
      || attempt.inputCharacters < 1 || attempt.inputCharacters > 1200 || attempt.outputDimensions !== 768
      || !["RETRIEVAL_DOCUMENT", "RETRIEVAL_QUERY"].includes(attempt.taskType)) throw moneyError("Неподдерживаемый тариф или размер эмбеддинга Gemini");
    // Model's full 2048-token input limit at $0.15/M, rounded UP to integer microUSD.
    // https://ai.google.dev/gemini-api/docs/embeddings ; no character/token equivalence assumed.
    await wallet.reserve(308);
  };
}
