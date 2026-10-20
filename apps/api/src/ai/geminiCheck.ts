import { geminiGenerateUrlFor, geminiProxyHeaders } from "./geminiTransport.js";

/**
 * ПРОВЕРКА МОДЕЛИ ЖИВЫМ ВЫЗОВОМ — отдельным модулем, потому что ею пользуется и
 * экран настроек, и (в будущем) утренняя самопроверка.
 *
 * Смысл один: спросить у Google ровно то же, что спросит бот, и вернуть его ответ
 * дословно. Никакой интерпретации — 22.08.2026 именно наша интерпретация («модель
 * недоступна») спрятала HTTP 404 закрытой модели на трое суток.
 */

/** Сколько ждём ответа. Проверка — интерактивная: человек стоит у экрана, и минута
 *  ожидания читается как «сломалось». Настоящий разговор бота ждёт дольше (там
 *  ставка выше), поэтому свой срок, а не общий. */
const CHECK_TIMEOUT_MS = 25_000;

export interface GeminiCheckResult {
  ok: boolean;
  /** HTTP-код ответа Google; null — до Google не дошли вовсе (сеть, таймаут, прокси). */
  status: number | null;
  /** Ответ Google дословно (обрезанный) или причина сетевого отказа. */
  detail: string;
  /** Сколько заняла проверка — сама по себе цифра диагностична: 18 секунд на «ок»
   *  означают, что модель отвечает на грани нашего таймаута. */
  ms: number;
  /** Какой по счёту ключ ответил (1 — основной). Ключи перебираются, как в бою. */
  keyIndex: number | null;
}

export async function checkGeminiModel(model: string, apiKeys: string[]): Promise<GeminiCheckResult> {
  const started = Date.now();
  let last: GeminiCheckResult = {
    ok: false,
    status: null,
    detail: "нет ключей для проверки",
    ms: 0,
    keyIndex: null,
  };

  for (const [index, apiKey] of apiKeys.entries()) {
    const attemptStarted = Date.now();
    try {
      const res = await fetch(geminiGenerateUrlFor(model), {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-goog-api-key": apiKey, ...geminiProxyHeaders() },
        // Самый дешёвый осмысленный запрос: нам важен не ответ, а то, каким кодом
        // Google встретит именно эту модель именно этим ключом.
        body: JSON.stringify({ contents: [{ role: "user", parts: [{ text: "ок" }] }] }),
        signal: AbortSignal.timeout(CHECK_TIMEOUT_MS),
      });
      const text = (await res.text()).replace(/\s+/g, " ").trim();
      last = {
        ok: res.ok,
        status: res.status,
        // Успех не показываем целиком: ответ модели тут никого не интересует, а
        // портянка JSON на экране настроек только мешает прочитать главное.
        detail: res.ok ? "Модель ответила" : text.slice(0, 300),
        ms: Date.now() - attemptStarted,
        keyIndex: index + 1,
      };
      // 401/403 — беда КЛЮЧА, а не модели: следующий ключ может ответить, и тогда
      // вердикт по модели должен быть его. Остальные коды относятся к самой модели,
      // и перебирать ключи дальше незачем — ответ будет тот же.
      if (res.ok || (res.status !== 401 && res.status !== 403)) break;
    } catch (err) {
      last = {
        ok: false,
        status: null,
        detail: err instanceof Error ? err.message : "неизвестный сбой",
        ms: Date.now() - attemptStarted,
        keyIndex: index + 1,
      };
    }
  }

  return { ...last, ms: Date.now() - started };
}
