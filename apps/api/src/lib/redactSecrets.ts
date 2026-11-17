/**
 * ВЫЧИСТКА СЕКРЕТОВ ИЗ ТЕКСТА ОШИБКИ (17.11.2026) — одна функция на помощника сотрудников.
 *
 * Тексты сбоев (журнал ошибок, проверка каналов, фоновые задачи) приходят от внешних сервисов
 * дословно и бывают с адресом запроса: `https://api.telegram.org/bot<id>:<ключ>/sendMessage`,
 * `?access_token=…`, заголовком `Bearer …`. `logSystemError` маскирует только телефоны, так что
 * без этого шага ключ уходил в модель и в Telegram. Отдельно от `sanitizeTraceText`
 * (lib/botTurnTracePrivacy.ts): тот для трассы бота и заодно гасит ссылки, почты и номера —
 * здесь нужен точечный проход, который не портит остальной текст ошибки.
 */
export const REDACTED = "•••";

const RULES: Array<[RegExp, string]> = [
  // Токен бота Telegram: в адресе `bot<цифры>:<строка>` и сам по себе `<цифры>:<строка>`.
  [/\bbot\d{6,}:[A-Za-z0-9_-]{20,}/gi, `bot${REDACTED}`],
  [/(?<![\w:])\d{6,}:[A-Za-z0-9_-]{30,}(?![\w-])/g, REDACTED],
  [/\bBearer\s+[A-Za-z0-9._~+/=-]{8,}/gi, `Bearer ${REDACTED}`],
  // Ключи с известными приставками и JWT.
  [/\bsk-[A-Za-z0-9_-]{16,}/g, REDACTED],
  [/\bAIza[A-Za-z0-9_-]{30,}/g, REDACTED],
  [/\bEAA[A-Za-z0-9]{20,}/g, REDACTED],
  [/\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g, REDACTED],
  // `имя=значение` (адрес запроса, форма): ключ, токен, пароль и им подобные.
  [
    /\b((?:[a-z]+[_-])*(?:access[_-]?token|refresh[_-]?token|token|api[_-]?key|apikey|key|secret|password|passwd|pwd|client[_-]?secret))\s*=\s*(?:"[^"]*"|'[^']*'|[^\s&"',;]+)/gi,
    `$1=${REDACTED}`,
  ],
  // `имя: значение` — только для слов, которые в обычной ошибке не встречаются как термин
  // («key: …» не трогаем: «primary key: id» — обычный текст).
  [
    /\b((?:[a-z]+[_-])*(?:token|secret|password|passwd|api[_-]?key|apikey|authorization))\s*:\s*(?!Bearer\b)(?:"[^"]*"|'[^']*'|[^\s&"',;})\]]+)/gi,
    `$1: ${REDACTED}`,
  ],
];

/** Текст без секретов; пустое/отсутствующее значение возвращается как есть. */
export function redactSecrets(text: string): string;
export function redactSecrets(text: string | null | undefined): string | null | undefined;
export function redactSecrets(text: string | null | undefined): string | null | undefined {
  if (!text) return text;
  let out = text;
  for (const [pattern, replacement] of RULES) out = out.replace(pattern, replacement);
  return out;
}
