/**
 * ПРОВЕРКА BASE64 БЕЗ РЕГУЛЯРНЫХ ВЫРАЖЕНИЙ — одна дверь для больших вложений (21.11.2026).
 *
 * Прод 20.11 09:40 и 21.11 07:11 (диалог Instagram, вложение без текста): ход бота клиента падал `RangeError` ровно на
 * `/^[A-Za-z0-9+/]+={0,2}$/.test(data)` (dist/ai/geminiManagedMedia.js:35:76) — проверке вложения до 20 МБ движком регулярных
 * выражений V8, у которого свой предел стека отката; весь ход останавливался (`customer_core_unavailable`). Тот же класс —
 * шаблон с повтором группы `(?:[A-Za-z0-9+/]{4})*`: на 20 МБ он даёт «RangeError: Maximum call stack size exceeded»
 * воспроизводимо (tests/bot-live-21-11-b.test.ts). Здесь — проверка байтов через Buffer и таблицу алфавита: не зависит ни
 * от стека, ни от движка регулярных выражений, ~40 мс на 20 МБ (символами в цикле — вдвое дольше; ревью #358).
 * Длину вызывающий ограничивает сам.
 */
const ALPHABET = (() => {
  const table = new Uint8Array(256);
  for (const ch of "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/") table[ch.charCodeAt(0)] = 1;
  return table;
})();

/** Алфавит A–Z a–z 0–9 + /, затем не больше двух «=» в самом конце. Возвращает число «=» или -1. */
function base64Padding(data: string): number {
  // Только ASCII: иначе копия latin1 спутала бы «Ł» (U+0141) с «A» (0x41).
  if (Buffer.byteLength(data, "utf8") !== data.length) return -1;
  const bytes = Buffer.from(data, "latin1");
  const length = bytes.length;
  let pad = 0;
  while (pad < 2 && pad < length && bytes[length - 1 - pad] === 61) pad++;
  for (let i = 0; i < length - pad; i++) if (!ALPHABET[bytes[i]!]) return -1;
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
