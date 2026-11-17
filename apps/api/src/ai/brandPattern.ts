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
// «Info» съедаем только в той же строке (любой пробел, кроме перевода строки), не из следующего абзаца.
const INLINE = String.raw`[^\S\r\n]+`;
const SOURCE =
  `${BEFORE}Royal\\s+Home(?:${INLINE}Info${AFTER})?${AFTER}` +
  // «RoyalHome» слитно — имя, кроме домена: сразу за ним «.» и затем буква (royalhome.tj).
  `|${BEFORE}RoyalHome(?![\\p{L}\\p{N}_-])(?!\\.\\p{L})` +
  // Роял, Ройал, Ройял, Рояль + Хоум в любом падеже (Хоума, Хоуме, Хоуму, Хоумом); «Хоумы» не трогаем.
  `|${BEFORE}Ро(?:яль?|й[ая]л)\\s*Хо[уо]м(?:[аеу]|ом)?(?:${INLINE}Инфо${AFTER})?${AFTER}`;
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

export const BRAND_NAME_MIN = 3;
export const BRAND_NAME_MAX = 20;

/** Имя аккаунта годится, если само не содержит прежнее: иначе журнал утечек шумел бы каждый ход. */
export function brandNameError(name: string | null | undefined): string | null {
  const t = name?.trim();
  if (!t) return null;
  // 3..20: короткое имя («Дом») делало бы своей любую подпись; а заголовок кнопки в
  // Instagram режется по 20 знакам (messengers/meta.ts), длиннее имя в нём не помещается.
  if (t.length < BRAND_NAME_MIN) return `Имя компании короче ${BRAND_NAME_MIN} знаков`;
  if (t.length > BRAND_NAME_MAX) return `Имя компании длиннее ${BRAND_NAME_MAX} знаков: в кнопке Instagram помещается не больше`;
  if (mentionsDefaultBrand(t)) return "Имя не должно содержать «Royal Home»: впишите имя второго бренда";
  return null;
}
