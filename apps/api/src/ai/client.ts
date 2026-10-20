import { logSystemError } from "../lib/systemError.js";
import { type ChatMessage, type ImageInput } from "./shared.js";
import type { ProviderOperation } from "./providerContract.js";

/**
 * ЕДИНАЯ ТОЧКА ТЕКСТОВОГО ВЫЗОВА ИИ.
 *
 * ПОСТАВЩИК ОДИН — GOOGLE (владелец 02.08.2026: «один поставщик на всю CRM»;
 * 20.08.2026: «замени на Google, на Claude у меня нет денег даже в ключе»).
 *
 * Раньше здесь жил второй поставщик (Anthropic) и переключатель между ними. Его
 * убрали не ради чистоты: неоплаченный ключ отвечает отказом, а отказ поставщика
 * в этом коде превращался в `null` — то есть в «модель ничего не нашла». Аудит бота,
 * единственное место с прямым вызовом Claude, из-за этого показывал бы «нарушений
 * нет» вместо «проверка не работает». Один поставщик — одна причина отказа, и она
 * сразу видна в «Здоровье системы».
 *
 * Общее (типы диалога, разбор JSON, журнал вызовов) живёт в ./shared. Реэкспорт
 * ниже — чтобы десяток мест, импортирующих это отсюда исторически, не переписывать.
 */
export { extractJson, emptyUsage, logAiCall } from "./shared.js";
export type { ChatMessage, ImageInput, SpentTokens, StoredAttachment } from "./shared.js";

export async function callAiText<T>(params: {
  endpoint: string;
  system: string;
  /** Стабильный префикс системного промта. У Gemini префикс-кэша в этом клиенте
   *  нет — обе части просто склеиваются. Параметр оставлен: им пользуются вызовы,
   *  где промт логически делится на «правила» и «данные». */
  systemStable?: string;
  user?: string;
  messages?: ChatMessage[];
  maxTokens?: number;
  effort?: "low" | "medium" | "high";
  images?: ImageInput[];
  schema?: Record<string, unknown>;
  /**
   * Задача простая — разбор, классификация, извлечение полей, а не разговор с
   * клиентом. У Google модель одна и та же, поэтому признак ни на что не влияет;
   * он сохранён, чтобы вызывающий код не переписывать, если однажды появится
   * более дешёвая ступень.
   */
  simple?: boolean;
  /** С какой модели начать перебор — см. callGemini (geminiClient.ts). */
  preferModel?: string;
  /** Диалог/звонок, в рамках которого сделан вызов — см. logAiCall в ./shared.js. */
  conversationId?: string | null;
  /** Карточка клиента (только id) — для журнала блокировки промта, см. callGemini. */
  clientId?: string | null;
  /** См. callGemini (geminiClient.ts) — явный сигнал «Google заблокировал промт
   *  по содержимому», не отказ поставщика. Форвардится как есть. */
  onBlocked?: (reason: string) => void;
  /** Server-created shared limits/accounting; never parsed from model output. */
  providerOperation?: ProviderOperation;
}): Promise<T | null> {
  params.providerOperation?.check();
  // Блокировка промта — решение по содержимому, а не по поставщику: повтор
  // ниже получит тот же blockReason на том же тексте, поэтому при блокировке
  // его пропускаем (15.09.2026) вместо того, чтобы гарантированно жечь вторую
  // попытку и писать «повтор тоже не помог» в журнал на каждый такой вызов.
  let blocked = false;
  const primary = await callGeminiText<T>({
    ...params,
    onBlocked: (reason) => {
      blocked = true;
      params.onBlocked?.(reason);
    },
  });
  params.providerOperation?.check();
  if (primary !== null) return primary;
  if (blocked) return null;

  /**
   * ПОВТОР У ТОГО ЖЕ ПОСТАВЩИКА, А НЕ ПЕРЕХОД К ЧУЖОМУ.
   *
   * Раньше отказ переключал ход на второго поставщика. Задумка была правильной, а
   * цена оказалась высокой: два месяца Gemini молча отвечал 404 (модель закрыли), и
   * КАЖДЫЙ ход вытягивал Claude — снаружи всё работало, поломки не было видно
   * никому. Обнаружилась она 02.08, когда у Claude кончились деньги и бот замолчал
   * совсем: скрытый отказ дожил до момента, когда прикрывать его стало нечем.
   *
   * Поэтому здесь повтор у него же: сетевой сбой и разовая пустота лечатся второй
   * попыткой не хуже, а отказ поставщика больше не прячется за чужой спиной.
   */
  const retry = await callGeminiText<T>(params);
  params.providerOperation?.check();
  void logSystemError(
    "ai",
    retry !== null
      ? `Gemini не ответил с первого раза (${params.endpoint}) — помог повтор`
      : `Gemini не ответил (${params.endpoint}), повтор тоже не помог`
  );
  return retry;
}

/** Один вызов Google. Вынесен отдельно, чтобы повтор выше не дублировал сборку.
 *  systemStable уходит ОТДЕЛЬНЫМ полем: с включённым явным кэшем (Настройки → ИИ)
 *  клиент Gemini кэширует его у Google, а без кэша сам склеивает части ровно так же,
 *  как это делалось здесь, — побайтово (см. fullSystem в geminiClient.ts). */
async function callGeminiText<T>(params: Parameters<typeof callAiText>[0]): Promise<T | null> {
  const { callGemini } = await import("./geminiClient.js");
  return callGemini<T>(params);
}
