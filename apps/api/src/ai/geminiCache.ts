import { createHash } from "node:crypto";
import { prisma } from "../db.js";
import { geminiProxyHeaders, geminiUrl } from "./geminiTransport.js";
import { logSystemError } from "../lib/systemError.js";
import { isProviderOperationError, type ProviderOperation, type ProviderAttempt } from "./providerContract.js";

/**
 * ЯВНЫЙ КЭШ СИСТЕМНОГО ПРОМТА GEMINI (тумблер Settings.geminiExplicitCachingEnabled,
 * выключен по умолчанию).
 *
 * ЗАЧЕМ. Неявный кэш Google (работает всегда, бесплатно, сам) срабатывает примерно
 * в половине случаев — это задокументированное поведение поставщика («no guarantee»,
 * github.com/googleapis/python-genai/issues/1880), и наши журналы это подтверждают:
 * у lead-qualify cacheReadTokens то есть, то нет при одинаковом префиксе. Явный кэш
 * (cachedContents API) — гарантированные 90% скидки на закэшированную часть, но за
 * него платится хранение по TTL и один полный проход текста при создании.
 *
 * ОГРАНИЧЕНИЕ GOOGLE, ОПРЕДЕЛИВШЕЕ ФОРМУ МОДУЛЯ: generateContent с cachedContent
 * НЕ принимает systemInstruction/tools/toolConfig в самом запросе — 400 на каждый
 * вызов. Всё это обязано лежать ВНУТРИ кэша, созданного заранее. Поэтому кэшируется
 * связка (модель + стабильный текст + схема инструмента), а не только текст.
 *
 * МИНИМУМ 2048 ТОКЕНОВ. Кэш короче Google не принимает (400 с явным текстом про
 * минимум). Стабильная часть промта lead-qualify в разы больше, но на всякий случай
 * отказ создания обрабатывается как «кэша нет» — вызов уходит обычным путём.
 *
 * TTL ЧАС. Хранение тарифицируется за токено-часы: час покрывает плотный разговор
 * и стоит копейки, а простаивающий ночью кэш не копит счёт. Продление — пересозданием
 * по истечении (запись в своей таблице истекает раньше, чем у Google, с запасом
 * минута — чтобы не сослаться на кэш, который Google уже удалил).
 */

const TTL_SECONDS = 3600;
/** Свой срок годности короче настоящего: ссылка на только что умерший кэш — это 4xx
 *  на живом ходе клиента, дешевле пересоздать на минуту раньше. */
const EXPIRY_SAFETY_MS = 60_000;

export interface CacheableRequest {
  model: string;
  /** Стабильная часть системного промта (см. buildStableSystem в leadQualifier.ts). */
  systemStable: string;
  /** Схема инструмента submit_reply, если вызов структурированный. Кэшируется вместе
   *  с текстом: Google не разрешает tools в запросе рядом с cachedContent. */
  toolSchema?: Record<string, unknown>;
  providerOperation?: ProviderOperation;
}

function cacheHash(apiKey: string, req: CacheableRequest): string {
  return createHash("sha256")
    // Cache resources are credential/project scoped. Only the final digest is
    // stored; neither the key nor its intermediate fingerprint is logged.
    .update(createHash("sha256").update(apiKey).digest("hex"))
    .update("\0generateContent+cachedContents:v1\0")
    .update(req.providerOperation?.profileRevision ?? "legacy")
    .update("\0")
    .update(req.model)
    .update("\0")
    .update(req.systemStable)
    .update("\0")
    .update(req.toolSchema ? JSON.stringify(req.toolSchema) : "")
    .digest("hex");
}

/** Сборка tools/toolConfig — ровно та же форма, что в geminiClient.ts у обычного
 *  запроса; разойтись им нельзя, иначе ответы кэшированного и обычного пути будут
 *  разной структуры. */
function toolsFor(schema: Record<string, unknown>): Record<string, unknown> {
  return {
    tools: [
      {
        functionDeclarations: [
          {
            name: "submit_reply",
            description: "Отправить структурированный ответ клиенту. Всегда используй этот инструмент для ответа.",
            parameters: schema,
          },
        ],
      },
    ],
    toolConfig: { functionCallingConfig: { mode: "ANY", allowedFunctionNames: ["submit_reply"] } },
  };
}

/**
 * Имя действующего кэша у Google ("cachedContents/...") или null — тогда вызывающий
 * собирает запрос обычным путём, как до появления этого модуля.
 *
 * null возвращается на ЛЮБОЙ сбой намеренно: кэш — оптимизация, и его отказ не
 * имеет права стоить клиенту ответа. Худшее, что случается при сбое, — вызов
 * дороже на копейки.
 */
export async function resolveGeminiCache(apiKey: string, req: CacheableRequest): Promise<string | null> {
  let providerAttempt: ProviderAttempt | undefined;
  let attemptOutcome: Parameters<ProviderAttempt["finish"]>[0] = "error";
  try {
    req.providerOperation?.check();
    const hash = cacheHash(apiKey, req);
    const existing = await prisma.geminiCache.findUnique({ where: { hash } });
    req.providerOperation?.check();
    if (existing && existing.expiresAt.getTime() > Date.now()) return existing.name;

    const body: Record<string, unknown> = {
      model: `models/${req.model}`,
      displayName: `crm-${hash.slice(0, 16)}`,
      systemInstruction: { parts: [{ text: req.systemStable }] },
      ttl: `${TTL_SECONDS}s`,
      ...(req.toolSchema ? toolsFor(req.toolSchema) : {}),
    };
    // Единственный fetch в этом файле без AbortController (найдено аудитом
    // 02.09.2026, docs/audit-02-09-2026/07-deadcode.md) — сетевая ОШИБКА уже
    // ловится try/catch ниже, но ЗАВИСШИЙ (не отвечающий) запрос ничем не был
    // ограничен и добавлял задержку сверх обычного таймаута основной модели.
    // 15 с — это кэш-оптимизация перед главным вызовом, не сам ответ клиенту.
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 15_000);
    let res: Response;
    try {
      providerAttempt = await req.providerOperation?.begin({ provider: "google", api: "cachedContents", adapter: "cache", model: req.model,
        profileRevision: req.providerOperation.profileRevision, pricingRevision: req.providerOperation.pricingRevision,
        endpoint: "gemini-cache", maxOutputTokens: 0, features: { cache: true, functions: !!req.toolSchema } }, 15_000);
      req.providerOperation?.check();
      res = await fetch(geminiUrl("/v1beta/cachedContents"), {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-goog-api-key": apiKey, ...geminiProxyHeaders() },
        body: JSON.stringify(body),
        signal: providerAttempt?.signal ?? controller.signal,
      });
    } finally {
      clearTimeout(timeout);
    }
    if (!res.ok) {
      const detail = (await res.text()).slice(0, 300);
      // Одна строка на процесс — не на каждый ход: отказ создания кэша повторится
      // на каждом вызове, пока не починят причину, и журнал не должен от этого тонуть.
      reportCreateFailureOnce(req.model, res.status, detail);
      return null;
    }
    const data = (await res.json()) as { name?: string; usageMetadata?: unknown };
    providerAttempt?.reportUsage(data.usageMetadata);
    providerAttempt?.check();
    if (!data.name) return null;
    attemptOutcome = "success";

    const expiresAt = new Date(Date.now() + TTL_SECONDS * 1000 - EXPIRY_SAFETY_MS);
    // upsert, а не create: два процесса (api и worker) могут создать кэш одновременно.
    // Оба кэша у Google валидны; в таблице побеждает последний — ссылаться можно на любой.
    await prisma.geminiCache.upsert({
      where: { hash },
      create: { hash, name: data.name, model: req.model, expiresAt },
      update: { name: data.name, model: req.model, expiresAt },
    });
    // Просроченные записи подчищаются мимоходом: отдельный крон ради таблицы на
    // десяток строк — лишняя сущность. У Google они умирают сами по TTL.
    void prisma.geminiCache.deleteMany({ where: { expiresAt: { lt: new Date() } } }).catch(() => null);
    return data.name;
  } catch (err) {
    if (isProviderOperationError(err)) throw err;
    void logSystemError(
      "ai",
      `Явный кэш Gemini: сбой (${err instanceof Error ? err.message : String(err)}) — вызов пошёл обычным путём`
    );
    return null;
  } finally {
    await providerAttempt?.finish(attemptOutcome);
  }
}

const createFailuresReported = new Set<string>();

function reportCreateFailureOnce(model: string, status: number, detail: string): void {
  const key = `${model}:${status}`;
  if (createFailuresReported.has(key)) return;
  createFailuresReported.add(key);
  void logSystemError(
    "ai",
    `Явный кэш Gemini: создание отклонено (${model}, HTTP ${status}: ${detail.replace(/\s+/g, " ")}) — ` +
      `вызовы идут обычным путём, дороже, но работают. Повторно об этом не пишем до перезапуска.`
  );
}
