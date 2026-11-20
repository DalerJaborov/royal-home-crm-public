/**
 * ПРИЧИНА СБОЯ ПО-ЧЕЛОВЕЧЕСКИ ДЛЯ ЭКРАНА «СОСТОЯНИЕ ФУНКЦИЙ» (20.11.2026, класс К17 аудита, ревью #340).
 *
 * Сырой текст ошибки («Gemini 429 RESOURCE_EXHAUSTED: quota exceeded», «fetch failed UND_ERR_CONNECT_TIMEOUT
 * (api.telegram.org)») директору ничего не говорит. Сервер, который знает, что именно сломалось, отдаёт
 * рядом короткую фразу: что за сервис и что делать. Сам сырой текст остаётся в данных — экран прячет его
 * в блок «Для разработчика». Чистая функция: правила одним списком, без обращений к базе и сети.
 *
 * Правило важнее догадки: фраза не должна врать. «Не отвечает» говорим только про обрыв и таймаут;
 * отказ сервиса на сам запрос (400, SAFETY, «location is not supported») — это «отклонил запрос»,
 * и чинит его разработчик, а не ожидание.
 */
const SERVICES: Array<[RegExp, string]> = [
  [/gemini|generativelanguage|google\s*ai/i, "Gemini"],
  [/openai|\bgpt[-\s\d]/i, "OpenAI"],
  [/anthropic|claude/i, "Claude"],
  [/deepseek/i, "DeepSeek"],
  [/telegram|api\.telegram\.org/i, "Telegram"],
  [/elevenlabs/i, "ElevenLabs"],
  [/graph\.facebook|facebook|instagram|\bmeta\b|whatsapp/i, "Meta"],
  [/tiktok/i, "TikTok"],
  [/fcm\.googleapis|\bfcm\b|firebase/i, "Уведомления на телефон (Google)"],
  [/youtube/i, "YouTube"],
];

function serviceOf(raw: string): string | null {
  for (const [re, name] of SERVICES) if (re.test(raw)) return name;
  return null;
}

const FALLBACK = "Сбой в работе. Подробности — в блоке «Для разработчика».";

/** Одна фраза для человека: сервис (если узнали) + что делать. Пустой вход — null. */
export function describeFunctionError(raw: string | null | undefined): string | null {
  const text = String(raw ?? "").trim();
  if (!text) return null;
  const service = serviceOf(text);
  const name = service ?? "Внешний сервис";

  if (/повтор тоже не помог/i.test(text)) return `${name} не ответил, повтор тоже не помог — проверьте позже.`;
  // Ключ Meta истёк (код 190): чинится переподключением, а не ожиданием.
  if (/\(#190\)|\bcode[":\s]+190\b|session has expired|access token (has )?expired|error validating access token/i.test(text)) {
    return "Ключ Meta истёк — переподключите в Настройках, «Каналы».";
  }
  if (/\b429\b|\b402\b|payment required|RESOURCE_EXHAUSTED|quota|rate[\s_-]?limit|insufficient_quota|billing/i.test(text)) {
    return `Кончился лимит ${service ?? "сервиса"} — подождите или пополните счёт.`;
  }
  // Не задана переменная сервера (ИМЯ_В_ВЕРХНЕМ_РЕГИСТРЕ): человек её не добавит, это дело разработчика.
  if (/не задан[аоы]?\s+[A-Z][A-Z0-9]*_[A-Z0-9_]+|[A-Z][A-Z0-9]*_[A-Z0-9_]+\s+(не задан[аоы]?|is not set|is missing)/.test(text)) {
    return "Не задана настройка сервера — скажите разработчику.";
  }
  if (/не задан|not set|is missing|missing .*key|no api key|api key (is )?required/i.test(text)) {
    return `Не задан ключ ${service ?? "сервиса"} — добавьте его в Настройках.`;
  }
  if (/\b401\b|\b403\b|unauthori[sz]ed|permission_denied|invalid[\s_-]*(api[\s_-]*)?(key|token)|API key not valid/i.test(text)) {
    return `${name} не принял ключ — проверьте ключ в Настройках.`;
  }
  // Сервис ответил, но отказал на сам запрос — ждать бесполезно.
  if (/\b400\b|INVALID_ARGUMENT|FAILED_PRECONDITION|location is not supported|\bSAFETY\b|\bBLOCKED\b|bad request/i.test(text)) {
    return `${name} отклонил запрос — нужен разработчик.`;
  }
  if (/fetch failed|ECONN|ETIMEDOUT|UND_ERR|ENOTFOUND|EAI_AGAIN|timed? ?out|timeout|socket hang up|не ответил|\b50[234]\b/i.test(text)) {
    return `${name} не отвечает — проверьте позже.`;
  }
  return service ? `Сбой в работе: ${service}. Подробности — в блоке «Для разработчика».` : FALLBACK;
}
