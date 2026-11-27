/**
 * ПРОИЗНОШЕНИЕ В ГОЛОСЕ (27.11.2026, владелец). Синтез речи читает слово CRM по-американски («Си-Ар-Эм»);
 * одобрено на слух чтение «сиарэм» (русскими буквами, строчными, без ударения). Подмена идёт ТОЛЬКО в тексте,
 * который уходит в синтез (голос Шабнам и озвучка текста/объекта); письменный текст сообщения не меняется.
 * Один модуль на все голосовые пути: новое слово — строка в SPOKEN_WORDS, а не копия в каждом пути.
 *
 * Слово — отдельное: адрес и домен (crm.royalhome.tj, @crm, /crm/…) не трогаем. Точка в конце предложения
 * («Открой CRM.») слово не склеивает, точка перед буквой («crm.royalhome») — склеивает.
 */
// Без взгляда назад (Safari < 16.4, сторож noRegexLookbehind): предыдущий символ — группа 1, возвращается как есть.
const SPOKEN_WORDS: ReadonlyArray<readonly [RegExp, string]> = [
  [/(^|[^\p{L}\p{N}_@/.:-])CRM(?![\p{L}\p{N}_@/]|\.[\p{L}\p{N}]|:\/\/)/giu, "сиарэм"],
];

export function applySpokenPronunciation(text: string): string {
  let out = text;
  for (const [pattern, spoken] of SPOKEN_WORDS) out = out.replace(pattern, (_m, before: string) => `${before}${spoken}`);
  return out;
}
