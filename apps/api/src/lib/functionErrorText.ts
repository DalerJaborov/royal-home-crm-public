/**
 * ПРИЧИНА СБОЯ ПО-ЧЕЛОВЕЧЕСКИ ДЛЯ ЭКРАНА «СОСТОЯНИЕ ФУНКЦИЙ» (20.11.2026, класс К17 аудита, ревью #340).
 *
 * Сырой текст ошибки («Gemini 429 RESOURCE_EXHAUSTED: quota exceeded», «fetch failed UND_ERR_CONNECT_TIMEOUT
 * (api.telegram.org)») директору ничего не говорит. Сервер, который знает, что именно сломалось, отдаёт
 * рядом короткую фразу: что за сервис и что делать. Сам сырой текст остаётся в данных — экран прячет его
 * в блок «Для разработчика». Чистая функция: правила одним списком, без обращений к базе и сети.
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
  [/youtube|googleapis/i, "YouTube"],
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
  if (/\b429\b|RESOURCE_EXHAUSTED|quota|rate[\s_-]?limit|insufficient_quota|billing/i.test(text)) {
    return `Кончился лимит ${service ?? "сервиса"} — подождите или пополните счёт.`;
  }
  if (/не задан|not set|is missing|missing .*key|no api key|api key (is )?required/i.test(text)) {
    return `Не задан ключ ${service ?? "сервиса"} — добавьте его в Настройках.`;
  }
  if (/\b401\b|\b403\b|unauthori[sz]ed|permission_denied|invalid[\s_-]*(api[\s_-]*)?(key|token)|API key not valid/i.test(text)) {
    return `${name} не принял ключ — проверьте ключ в Настройках.`;
  }
  if (/fetch failed|ECONN|ETIMEDOUT|UND_ERR|ENOTFOUND|EAI_AGAIN|timed? ?out|timeout|socket hang up|не ответил|\b50[234]\b/i.test(text)) {
    return `${name} не отвечает — проверьте позже.`;
  }
  return service ? `Сбой в работе ${service}. Подробности — в блоке «Для разработчика».` : FALLBACK;
}
