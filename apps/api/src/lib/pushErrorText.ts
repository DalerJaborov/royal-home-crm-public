/**
 * ТЕКСТ ОШИБКИ ДЛЯ ПУША ДИРЕКТОРУ (ночная проверка 01.10.2026, №239).
 *
 * В пуш «Новая проблема в CRM» уходил хвост системной ошибки как есть: UUID
 * записей, «HTTP 503», английский текст исключения. Директору это ничего не
 * говорит, а на экране телефона съедает место. Здесь из сообщения остаётся
 * понятное по-русски; полный текст по-прежнему лежит в журнале ошибок.
 *
 * Чистая функция, без базы и сети — проверяется тестом `push-new-error-body`.
 * Регулярки по русскому тексту без `\w`/`\b` (они на кириллице молчат).
 */

const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi;
const HTTP_CODE = /(?:HTTP\s*|status(?:\s+code)?\s*|код\s*)(\d{3})/gi;
const CYRILLIC = /[А-Яа-яЁё]/;
const LATIN = /[A-Za-z]/;
/** Границы «фраз» в сообщении: двоеточие, точка с запятой, тире, конец предложения. */
const PHRASE_SPLIT = /\s*(?::\s|;\s|\s[—–-]\s|\.\s)\s*/;

export const PUSH_ERROR_FALLBACK = "подробности — в журнале ошибок";
const MAX_LENGTH = 160;

/** Слово вместо кода ответа: человеку «503» не нужен, нужно — чья это сторона. */
export function httpCodeWords(code: number): string {
  if (code === 429) return "превышен лимит запросов";
  if (code === 401 || code === 403) return "доступ запрещён";
  if (code === 404) return "не найдено";
  if (code === 408 || code === 504) return "сервис не ответил вовремя";
  if (code >= 500) return "сервис временно недоступен";
  if (code >= 400) return "запрос отклонён";
  return "неожиданный ответ сервиса";
}

/** Обрезка по границе слова (по пробелу), чтобы слово не рвалось посередине. */
function cutAtWord(text: string, max: number): string {
  if (text.length <= max) return text;
  const head = text.slice(0, max);
  const lastSpace = head.lastIndexOf(" ");
  return `${(lastSpace > max / 2 ? head.slice(0, lastSpace) : head).replace(/[\s,;:—–-]+$/, "")}…`;
}

export function pushBodyFromSystemError(sourceLabel: string, message: string): string {
  const parts = message
    .replace(UUID, "")
    .replace(/\s+/g, " ")
    .trim()
    .split(PHRASE_SPLIT)
    .map((part) => part.trim())
    .filter(Boolean);

  const keep: string[] = [];
  for (const part of parts) {
    const code = new RegExp(HTTP_CODE.source, "i").exec(part)?.[1];
    if (CYRILLIC.test(part)) {
      // Русская фраза: код ответа внутри неё меняем на слова, остальное оставляем.
      keep.push(part.replace(HTTP_CODE, (_all, c: string) => httpCodeWords(Number(c))));
    } else if (code) {
      // Английская фраза с кодом («Request failed with status code 429»): код — словами, остальное прочь.
      keep.push(httpCodeWords(Number(code)));
    } else if (!LATIN.test(part)) {
      keep.push(part); // цифры и знаки без латиницы, например «5 попыток»
    }
    // Остальная латиница — технический хвост исключения, в пуш не идёт.
  }

  const text = keep
    // Остатки после вырезанного UUID: пустые скобки и кавычки.
    .map((part) => part.replace(/\(\s*\)|«\s*»|""/g, "").replace(/\s+/g, " ").trim())
    .filter((part) => /[А-Яа-яЁёA-Za-z0-9]/.test(part))
    .join(": ");
  return `${sourceLabel}: ${cutAtWord(text || PUSH_ERROR_FALLBACK, MAX_LENGTH)}`;
}
