/**
 * СЕКРЕТЫ В ЖУРНАЛ НЕ ПОПАДАЮТ — ОДНА ДВЕРЬ ДЛЯ ВСЕХ ЗАПИСЕЙ ОШИБОК (26.11.2026).
 *
 * Больше двадцати вызовов Graph API кладут маркер доступа прямо в адрес
 * (`?access_token=…`), запросы к Telegram несут ключ бота в пути
 * (`api.telegram.org/bot<id>:<ключ>/`), заголовок `Authorization: Bearer …`
 * попадает в текст исключения у части клиентов, а браузер шлёт в журнал адрес
 * страницы с подписанной ссылкой (`?k=…`, `?token=…`). Журнал ошибок читают все с
 * правом auditLog.view, лог контейнера — все с доступом к серверу. Поэтому секрет
 * вычищается здесь, в одной функции, которую зовут все записи в ErrorLog
 * (lib/systemError.ts, routes/errorLog.ts), а не в каждом из ~150 вызовов.
 * Сторож — tests/secret-redaction.test.ts: каждый файл, пишущий в ErrorLog,
 * обязан звать эту функцию.
 *
 * Правила маски:
 *  - значение заменяется на `***`, имя параметра остаётся — по журналу видно,
 *    какой ключ был в адресе, но не сам ключ;
 *  - короче четырёх знаков значение не трогается: секретом оно не бывает, а маска
 *    не должна удлинять запись;
 *  - обычный текст ошибки не меняется: имя параметра должно стоять после
 *    разделителя (`?`, `&`, `;`, пробел, начало строки, кавычка, скобка) и сразу
 *    перед `=` или `:` с кавычками JSON.
 */

const MASK = "***";
const MIN_SECRET_LEN = 4;

/** Имена параметров, значение которых — секрет. Сравнение без учёта регистра. */
const SECRET_PARAM_NAMES = [
  "access_token", "refresh_token", "input_token", "id_token", "token", "auth_token", "bot_token",
  "api_key", "apikey", "api-key", "key", "client_secret", "secret", "app_secret", "password", "passwd",
  // k — подпись ссылки на вложение (#428), t — токен ссылки на медиа (lib/crmPublicUrl.ts).
  "sig", "signature", "k", "t", "hub.verify_token",
  // НЕ `code`: ai/geminiClient.ts пишет в текст ошибки `code=<номер ошибки>`, маска
  // унесла бы единственную подсказку о причине. Одноразовый код OAuth живёт секунды.
];
// Под флагом `u` экранировать можно только синтаксические символы: `\-` вне класса — ошибка.
const NAMES = SECRET_PARAM_NAMES.map((n) => n.replace(/\./g, "\\.")).join("|");

/** `?access_token=XYZ`, `&key=XYZ`, ` token=XYZ` — значение до конца параметра. */
const QUERY_PARAM = new RegExp(`(^|[?&;\\s,(\\[{'"])((?:${NAMES})=)([^&#\\s"'<>)\\]},;]+)`, "giu");
/** `"access_token":"XYZ"` и `access_token: 'XYZ'` в JSON-подобном тексте ответа. */
const JSON_FIELD = new RegExp(`((?:^|[\\s,{(\\["'])(?:${NAMES})["']?\\s*:\\s*["'])([^"'\\s]+)(["'])`, "giu");
/** `Bearer XYZ` / `Basic XYZ` в тексте заголовка. */
const AUTH_SCHEME = /\b(Bearer|Basic)(\s+)([A-Za-z0-9._~+/=-]+)/gu;
/** Ключ бота Telegram в пути: `/bot123456:AA…/`. */
const TELEGRAM_BOT_PATH = /(\/bot)(\d{5,}:[A-Za-z0-9_-]{20,})/gu;

function maskValue(value: string): string {
  return value.length >= MIN_SECRET_LEN ? MASK : value;
}

/** Вычищает секреты из текста записи журнала. Никогда не удлиняет текст. */
export function redactSecretsInText<T extends string | null | undefined>(text: T): T {
  if (typeof text !== "string" || text.length === 0) return text;
  return (text as string)
    .replace(QUERY_PARAM, (_all, sep: string, name: string, value: string) => `${sep}${name}${maskValue(value)}`)
    .replace(JSON_FIELD, (_all, head: string, value: string, tail: string) => `${head}${maskValue(value)}${tail}`)
    .replace(AUTH_SCHEME, (_all, scheme: string, space: string, value: string) => `${scheme}${space}${value.length >= 8 ? MASK : value}`)
    .replace(TELEGRAM_BOT_PATH, (_all, prefix: string) => `${prefix}${MASK}`) as T;
}
