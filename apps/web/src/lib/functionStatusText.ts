/**
 * «СОСТОЯНИЕ ФУНКЦИЙ» БЕЗ ВНУТРЕННЕГО ЯЗЫКА (20.11.2026, класс К17 аудита).
 *
 * Сервер пишет причины и ошибки как есть: «Gemini не ответил (marketing-insights), повтор тоже не
 * помог», «переменная GEMINI_API_KEY не задана». Директору это ничего не говорит, а имена моделей,
 * внутренних запросов и ключей — не для экрана. Здесь текст приводится к человеческому виду на
 * экране; сами данные и журнал сервера не меняются.
 */
const MODEL_NAME = /\b(?:Gemini|Claude|Anthropic|OpenAI|GPT|DeepSeek)[\w.-]*/gi;
const SECRET_TOKEN = /\b(?:AIza[0-9A-Za-z_-]{20,}|sk-[0-9A-Za-z_-]{16,}|[A-Fa-f0-9]{32,}|[0-9A-Za-z_-]{24,}\.[0-9A-Za-z_-]{6,}\.[0-9A-Za-z_-]{20,})\b/g;
const ENV_NAME = /\b[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)+\b/g;
const INTERNAL_ENDPOINT = /\s*\((?=[^)]*[a-z])[a-z][a-z0-9]*(?:[-_./][a-z0-9]+)+\)/g;

export function plainFunctionText(text: string | null | undefined): string {
  let out = String(text ?? "");
  if (!out) return out;
  // Самое частое: отказ ИИ после повтора. Одной фразой, без названия модели и запроса.
  out = out.replace(/(?:Gemini|ИИ)\s+не ответил\s*(?:\([^)]*\))?,?\s*повтор тоже не помог/gi, "ИИ не ответил, повтор тоже не помог");
  out = out.replace(SECRET_TOKEN, "(данные скрыты)");
  out = out.replace(/переменн[а-яё]*\s+[A-Z][A-Z0-9_]+/g, "настройка сервера");
  out = out.replace(ENV_NAME, "настройка сервера");
  out = out.replace(INTERNAL_ENDPOINT, "");
  out = out.replace(MODEL_NAME, "ИИ");
  out = out.replace(/\bAPI[\s-]?(?:key|ключ)\b/gi, "ключ доступа");
  return out.replace(/(?:ИИ\s+){2,}/g, "ИИ ").replace(/\s{2,}/g, " ").trim();
}
