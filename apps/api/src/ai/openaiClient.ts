/**
 * OPENAI — ОБЩИЙ ТРАНСПОРТ (25.09.2026, решение владельца: обложки объектов
 * рисует ChatGPT, «он лучший для фото»).
 *
 * Одно место на всё, что ходит в api.openai.com: откуда брать ключ, таймаут,
 * повторы, перевод ошибки OpenAI в понятную русскую строку и запись расхода в
 * общий журнал ИИ (`AiLog`, тот же, где Gemini) — иначе строка «расходы на ИИ»
 * врала бы в меньшую сторону ровно на OpenAI.
 *
 * Ключ: `Settings.openaiApiKey` (зашифрован, как geminiApiKey) → `OPENAI_API_KEY`
 * из .env. Порядок «Настройки || .env» — общий для всех ключей проекта.
 */
import { prisma } from "../db.js";
import { decryptSecretSafe } from "../crypto.js";

export const OPENAI_BASE_URL = "https://api.openai.com/v1";
/** Генерация картинки high у gpt-image-1 идёт 30–90 с — 120 с с запасом. */
export const OPENAI_IMAGE_TIMEOUT_MS = 120_000;
/** Чтение цифр с картинки — короткий вызов. */
export const OPENAI_CHAT_TIMEOUT_MS = 45_000;
const MAX_RETRIES = 2;

export type OpenAiKeySource = "settings" | "env";

export interface OpenAiKey {
  key: string;
  source: OpenAiKeySource;
}

/** Ключ OpenAI: Настройки приоритетнее .env. null — не настроен нигде. */
export async function resolveOpenAiKey(): Promise<OpenAiKey | null> {
  const settings = await prisma.settings.findUnique({ where: { id: "singleton" }, select: { openaiApiKey: true } });
  const fromSettings = decryptSecretSafe(settings?.openaiApiKey ?? null)?.trim();
  if (fromSettings) return { key: fromSettings, source: "settings" };
  const fromEnv = process.env.OPENAI_API_KEY?.trim();
  if (fromEnv) return { key: fromEnv, source: "env" };
  return null;
}

/** Ошибка вызова OpenAI с уже переведённым текстом для людей. */
export class OpenAiError extends Error {
  constructor(
    message: string,
    readonly status: number | null,
    readonly code: string | null = null
  ) {
    super(message);
    this.name = "OpenAiError";
  }
}

interface OpenAiErrorBody {
  error?: { message?: string; type?: string; code?: string | null };
}

/**
 * Деньги на счёте кончились (01.10.2026): OpenAI отвечает 429 с текстом «You have no
 * credits remaining. Add credits…» и БЕЗ кода `insufficient_quota` — раньше такой ответ
 * принимали за лимит «запросов в минуту» и ждали до четырёх минут на каждую картинку,
 * публикация Reel вставала. Узнаём и по коду, и по тексту (регистр не важен).
 */
const OUT_OF_MONEY_TEXT = /no credits|insufficient|billing|exceeded your current quota/i;
export function isOutOfMoney(body: unknown): boolean {
  const err = (body as OpenAiErrorBody | null)?.error;
  if (err?.code === "insufficient_quota" || err?.code === "billing_hard_limit_reached") return true;
  if (err?.type === "insufficient_quota") return true;
  return OUT_OF_MONEY_TEXT.test(err?.message ?? "");
}

/** Код `OpenAiError` при нехватке денег: тот же, что у штатного ответа OpenAI. */
export const OPENAI_OUT_OF_MONEY_CODE = "insufficient_quota";

/** `{error:{message,type,code}}` → понятная русская строка. */
export function describeOpenAiError(status: number, body: unknown): string {
  const err = (body as OpenAiErrorBody | null)?.error;
  const code = err?.code ?? err?.type ?? "";
  const original = err?.message ? ` (${err.message.slice(0, 200)})` : "";
  if (status === 401) return `OpenAI не принял ключ — проверьте ключ в Настройках${original}`;
  if (isOutOfMoney(body))
    return `На счёте OpenAI закончились деньги — пополните баланс на platform.openai.com → Billing${original}`;
  if (status === 429) return `OpenAI просит подождать: слишком много запросов${original}`;
  if (code === "moderation_blocked" || code === "content_policy_violation")
    return `OpenAI отказался рисовать: сработал фильтр содержимого${original}`;
  if (status === 400) return `OpenAI отклонил запрос${original}`;
  if (status === 403) return `У ключа OpenAI нет доступа к этой модели (нужна верификация организации для gpt-image-1)${original}`;
  if (status >= 500) return `Сбой на стороне OpenAI (HTTP ${status})${original}`;
  return `OpenAI ответил HTTP ${status}${original}`;
}

export interface OpenAiRequestOptions {
  /** Тело: FormData уходит как multipart, объект — как JSON. */
  body: FormData | Record<string, unknown>;
  timeoutMs: number;
  /** Ключ уже прочитан вызывающим — второй запрос к базе не нужен. */
  apiKey?: string;
  /** Пауза перед повтором, мс (тесты ставят 0). */
  retryDelayMs?: number;
}

function shouldRetry(status: number): boolean {
  return status === 429 || status >= 500;
}

/**
 * POST к OpenAI: таймаут через AbortController, до двух повторов на 429/5xx с
 * паузой. Таймаут НЕ повторяется — ещё 120 с ожидания держали бы публикацию.
 * Бросает `OpenAiError` с русским текстом.
 */
export async function openAiPost<T>(endpoint: string, options: OpenAiRequestOptions): Promise<T> {
  const apiKey = options.apiKey ?? (await resolveOpenAiKey())?.key;
  if (!apiKey) throw new OpenAiError("Ключ OpenAI не задан — вставьте его в Настройках → Обложки для соцсетей", null, "no_key");
  const retryDelayMs = options.retryDelayMs ?? 2_000;
  const isForm = options.body instanceof FormData;
  const pace = retryDelayMs > 0; // тесты ставят 0 — тогда не ждём по-настоящему
  let attempt = 0;
  let rateLimited = 0;
  let rateWaited = 0;

  for (;;) {
    // Другой запрос уже получил «слишком много запросов» — ждём вместе с ним, а не
    // бьёмся о тот же лимит всей очередью (добор обложек идёт по несколько объектов).
    const gate = pace ? (blockedUntil.get(endpoint) ?? 0) - Date.now() : 0;
    if (gate > 0) await sleep(gate + Math.random() * 3_000);

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), options.timeoutMs);
    let response: Response;
    let text: string;
    try {
      response = await fetch(`${OPENAI_BASE_URL}${endpoint}`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${apiKey}`,
          ...(isForm ? {} : { "Content-Type": "application/json" }),
        },
        body: isForm ? (options.body as FormData) : JSON.stringify(options.body),
        signal: controller.signal,
      });
      // Тело читаем ВНУТРИ таймаута и повтора (29.09.2026): картинка приходит
      // мегабайтами base64, и обрыв на середине («terminated», ECONNRESET) раньше
      // летел наружу мимо повтора — «Перерисовать» падала с первого же сбоя сети.
      text = await response.text();
    } catch (err) {
      clearTimeout(timer);
      if (controller.signal.aborted) {
        throw new OpenAiError(`OpenAI не ответил за ${Math.round(options.timeoutMs / 1000)} с`, null, "timeout");
      }
      if (attempt < MAX_RETRIES) {
        attempt++;
        await sleep(retryDelayMs * attempt);
        continue;
      }
      throw new OpenAiError(`Нет связи с OpenAI: ${describeNetworkError(err)}`, null, "network");
    }
    clearTimeout(timer);

    let body: unknown = null;
    try {
      body = text ? JSON.parse(text) : null;
    } catch {
      body = null;
    }
    if (response.ok) {
      if (body === null) throw new OpenAiError("OpenAI прислал неполный ответ", response.status, "bad_body");
      return body as T;
    }
    const outOfMoney = isOutOfMoney(body);
    // Нет денег — сразу отказ: ни ожиданий, ни повторов (всё равно не пройдёт).
    const code = outOfMoney ? OPENAI_OUT_OF_MONEY_CODE : ((body as OpenAiErrorBody | null)?.error?.code ?? null);

    // 429 «слишком много запросов в минуту» (30.09.2026: у аккаунта лимит 5 картинок
    // в минуту, и 27 из 42 обложек падали после двух коротких повторов): ждём столько,
    // сколько просит сам OpenAI, и пробуем снова. Кончились деньги — это не лимит в минуту.
    if (response.status === 429 && !outOfMoney && rateLimited < RATE_LIMIT_RETRIES) {
      const waitMs = pace ? rateLimitWaitMs(response, body) : 0;
      if (rateWaited + waitMs <= RATE_LIMIT_TOTAL_MS) {
        rateLimited++;
        rateWaited += waitMs;
        if (waitMs > 0) blockedUntil.set(endpoint, Math.max(blockedUntil.get(endpoint) ?? 0, Date.now() + waitMs));
        await sleep(waitMs);
        continue;
      }
    }
    if (response.status !== 429 && shouldRetry(response.status) && attempt < MAX_RETRIES) {
      attempt++;
      await sleep(retryDelayMs * attempt);
      continue;
    }
    throw new OpenAiError(describeOpenAiError(response.status, body), response.status, code);
  }
}

/** До какого момента (мс) запросы к эндпоинту ждут после ответа 429 — общее на процесс. */
const blockedUntil = new Map<string, number>();
const RATE_LIMIT_RETRIES = 8;
const RATE_LIMIT_MAX_WAIT_MS = 65_000;
/** Всего ждём по лимиту не дольше четырёх минут на запрос — публикацию это не подвесит. */
const RATE_LIMIT_TOTAL_MS = 240_000;

/** Сколько ждать после 429: заголовок Retry-After, иначе «try again in 12s» из текста ошибки; +1 с запаса. */
export function rateLimitWaitMs(response: { headers?: { get?: (name: string) => string | null } }, body: unknown): number {
  const header = Number(response.headers?.get?.("retry-after"));
  if (Number.isFinite(header) && header > 0) return Math.min(RATE_LIMIT_MAX_WAIT_MS, header * 1000 + 1000);
  const message = String((body as OpenAiErrorBody | null)?.error?.message ?? "");
  const m = /try again in ([\d.]+)\s*(ms|s)\b/i.exec(message);
  if (m) {
    const ms = Number(m[1]) * (m[2].toLowerCase() === "ms" ? 1 : 1000);
    if (Number.isFinite(ms)) return Math.min(RATE_LIMIT_MAX_WAIT_MS, Math.ceil(ms) + 1000);
  }
  return 15_000;
}

/** «terminated» от fetch прячет настоящую причину в `cause` (ECONNRESET и т.п.). */
function describeNetworkError(err: unknown): string {
  if (!(err instanceof Error)) return String(err);
  const cause = (err as { cause?: unknown }).cause;
  const inner = cause instanceof Error ? cause.message : typeof cause === "string" ? cause : "";
  return inner && !err.message.includes(inner) ? `${err.message} (${inner})` : err.message;
}

function sleep(ms: number): Promise<void> {
  return ms > 0 ? new Promise((resolve) => setTimeout(resolve, ms)) : Promise.resolve();
}

/**
 * Цена картинки gpt-image-1, $ (прайс OpenAI: 1024×1024 low 0.011 / medium 0.042 /
 * high 0.167; 1024×1536 — 0.016 / 0.063 / 0.25). Входные картинки edits
 * тарифицируются токенами сверху, это единицы центов — в оценку не входят.
 */
const IMAGE_PRICE_USD: Record<OpenAiImageQuality, { square: number; portrait: number }> = {
  low: { square: 0.011, portrait: 0.016 },
  medium: { square: 0.042, portrait: 0.063 },
  high: { square: 0.167, portrait: 0.25 },
};

export type OpenAiImageQuality = "low" | "medium" | "high";

export function isOpenAiImageQuality(value: unknown): value is OpenAiImageQuality {
  return value === "low" || value === "medium" || value === "high";
}

export function estimateImageCostUsd(quality: OpenAiImageQuality, size: "1024x1024" | "1024x1536"): number {
  const price = IMAGE_PRICE_USD[quality];
  return size === "1024x1024" ? price.square : price.portrait;
}

/** Модели картинок, которые умеет наш конвейер (Настройки → Обложки). */
export const OPENAI_IMAGE_MODELS = ["gpt-image-2.5-sunburst", "gpt-image-2.5-flare", "gpt-image-2", "gpt-image-1"] as const;
export type OpenAiImageModel = (typeof OPENAI_IMAGE_MODELS)[number];
export function isOpenAiImageModel(value: unknown): value is OpenAiImageModel {
  return typeof value === "string" && (OPENAI_IMAGE_MODELS as readonly string[]).includes(value);
}

/** Ответ images/* с расходом токенов (у gpt-image-2 и 2.5 цена — только по токенам). */
export interface ImageUsage {
  input_tokens?: number;
  output_tokens?: number;
  input_tokens_details?: { text_tokens?: number; image_tokens?: number };
}

/**
 * Цена запроса картинок по токенам (прайс OpenAI, сверено 25.09.2026 на
 * developers.openai.com/api/docs/models/gpt-image-2.5-sunburst): текст на вход
 * $5/1M, картинки на вход $8/1M, картинки на выход $30/1M; у gpt-image-2 и
 * 2.5-flare/sunburst ставки одинаковые. null — в ответе нет usage.
 */
export function imageCostFromUsage(usage: ImageUsage | undefined): number | null {
  if (!usage || usage.output_tokens == null) return null;
  const text = usage.input_tokens_details?.text_tokens ?? 0;
  const image = usage.input_tokens_details?.image_tokens ?? Math.max(0, (usage.input_tokens ?? 0) - text);
  const cost = (text * 5 + image * 8 + usage.output_tokens * 30) / 1_000_000;
  return Math.round(cost * 1_000_000) / 1_000_000;
}

/** Запись вызова OpenAI в общий журнал ИИ. Журнал не роняет то, что записывает. */
export async function logOpenAiCall(params: {
  endpoint: string;
  model: string;
  costUsd: number | null;
  ms: number;
  ok: boolean;
  inputTokens?: number;
  outputTokens?: number;
}): Promise<void> {
  try {
    const tokens = (params.inputTokens ?? 0) + (params.outputTokens ?? 0);
    await prisma.aiLog.create({
      data: {
        endpoint: params.endpoint,
        model: params.model,
        tokens: tokens || undefined,
        inputTokens: params.inputTokens || undefined,
        outputTokens: params.outputTokens || undefined,
        costUsd: params.costUsd ?? undefined,
        ms: params.ms,
        ok: params.ok,
      },
    });
  } catch (logError) {
    console.error("[ai-log openai]", logError instanceof Error ? logError.message : logError);
  }
}
