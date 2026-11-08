/**
 * Чистая часть подмены имени компании (без базы и журнала): шаблон, проверка и
 * сама подмена. Отдельным файлом, чтобы messengers/accounts.ts мог проверить имя
 * при сохранении, не создавая цикла с ai/brandName.ts (там чтение из базы).
 *
 * ЧТО СЧИТАЕТСЯ ИМЕНЕМ ПО УМОЛЧАНИЮ: «Royal Home» (любой регистр, любой пробел,
 * включая перенос строки и неразрывные), «Royal Home Info» целиком, «RoyalHome»,
 * кириллицей «Роял/Ройал/Рояль Хоум». ЧЕГО НЕ СЧИТАЕТСЯ: сайт royalhome.tj, ники
 * (@royal.home.tj), ссылки и пути — перед именем там `/ @ . -`, а слово,
 * продолженное буквой («Royal Homes», «Royal Home Information»), имя не целиком.
 */
const L = String.raw`[\p{L}\p{N}_]`;
const BEFORE = String.raw`(?<![\p{L}\p{N}_@./-])`;
const AFTER = String.raw`(?!${L})`;
const SOURCE =
  `${BEFORE}Royal\\s+Home(?:\\s+Info${AFTER})?${AFTER}` +
  `|${BEFORE}RoyalHome(?![\\p{L}\\p{N}_.-])` +
  `|${BEFORE}Ро(?:яль?|йал)\\s*Хо[уо]м(?:\\s+Инфо${AFTER})?${AFTER}`;
const FLAGS = "giu";

/** Есть ли в тексте имя по умолчанию. */
export function mentionsDefaultBrand(text: string): boolean {
  return new RegExp(SOURCE, FLAGS).test(text);
}

/**
 * Подставить имя компании. Пустое имя — текст как есть. Чистая функция: подмена
 * идёт функцией, поэтому «$» в имени не ломает результат.
 */
export function brandize(text: string, brand: string | null | undefined): string {
  const name = brand?.trim();
  if (!name || !text) return text;
  return text.replace(new RegExp(SOURCE, FLAGS), () => name);
}

/** Имя аккаунта годится, если само не содержит прежнее: иначе журнал утечек шумел бы каждый ход. */
export function brandNameError(name: string | null | undefined): string | null {
  const t = name?.trim();
  if (!t) return null;
  if (t.length > 60) return "Имя компании длиннее 60 знаков";
  if (mentionsDefaultBrand(t)) return "Имя не должно содержать «Royal Home»: впишите имя второго бренда";
  return null;
}
