/**
 * ПРОВЕРКА BASE64 ОДНИМ ПРОХОДОМ, БЕЗ РЕГУЛЯРНЫХ ВЫРАЖЕНИЙ — одна дверь для больших вложений (21.11.2026).
 *
 * Прод 20.11 09:40 и 21.11 07:11 (диалог Instagram, вложение без текста): ход бота клиента падал `RangeError` ровно на
 * `/^[A-Za-z0-9+/]+={0,2}$/.test(data)` (dist/ai/geminiManagedMedia.js:35:76) — проверке вложения до 20 МБ движком регулярных
 * выражений V8, у которого свой предел стека отката; весь ход останавливался (`customer_core_unavailable`). Тот же класс —
 * шаблон с повтором группы `(?:[A-Za-z0-9+/]{4})*`: на 20 МБ он даёт «RangeError: Maximum call stack size exceeded»
 * воспроизводимо (тест base64-text-linear.test.ts). Цикл по кодам символов не зависит ни от стека, ни от движка, а длину
 * вызывающий ограничивает сам.
 */
function base64Char(code: number): boolean {
  return code >= 65 && code <= 90 || code >= 97 && code <= 122 || code >= 48 && code <= 57 || code === 43 || code === 47;
}

/** Алфавит A–Z a–z 0–9 + /, затем не больше двух «=» в самом конце. Возвращает число «=» или -1. */
function base64Padding(data: string): number {
  const length = data.length;
  let pad = 0;
  while (pad < 2 && pad < length && data.charCodeAt(length - 1 - pad) === 61) pad++;
  for (let i = 0; i < length - pad; i++) if (!base64Char(data.charCodeAt(i))) return -1;
  return pad;
}

/** Строгий base64: непустой, длина кратна 4, «=» только 0–2 в конце (то же, что `/^[A-Za-z0-9+/]+={0,2}$/` + длина % 4). */
export function isStrictBase64(data: string): boolean {
  if (!data.length || data.length % 4 !== 0) return false;
  const pad = base64Padding(data);
  return pad >= 0 && pad < data.length;
}

/** Base64 без обязательного «=» в конце (то же, что `/^[A-Za-z0-9+/]*={0,2}$/` и длина % 4 ≠ 1). */
export function isLooseBase64(data: string): boolean {
  return data.length % 4 !== 1 && base64Padding(data) >= 0;
}
