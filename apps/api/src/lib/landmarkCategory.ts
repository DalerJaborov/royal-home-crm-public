/**
 * КАТЕГОРИЯ И НАЗВАНИЕ ОРИЕНТИРА — ОДНО ПРАВИЛО ДЛЯ ВСЕХ (28.09.2026).
 *
 * Справочник ориентиров хранит категорию строкой как в источнике: «ВУЗ» (99
 * записей), «Торговый центр» (28), «Спортивное сооружение», «Храм». Таблицы
 * весов заведены как «Вуз», «ТЦ», «Стадион», «Церковь». Точное сравнение
 * промахивалось, и все вузы и торговые центры города шли с весом «по
 * умолчанию»: в строке места у точки на Рудаки аграрный университет в 200 м
 * проигрывал парку с латинским названием (владелец: «ориентиры настолько
 * далеко, что можно заблудиться»), а в поиске по карте ТЦ «Дарвоз» стоял
 * вровень с одноимённой улицей. Та же ошибка жила в двух таблицах — поэтому
 * правило вынесено сюда, и обе зовут его.
 */

const CATEGORY_SYNONYMS: Record<string, string> = {
  "торговый центр": "ТЦ",
  "спортивное сооружение": "Стадион",
  "академическое учебное заведение": "Вуз",
  "здание учебного заведения": "Вуз",
  сквер: "Парк",
  "здание гостиницы": "Гостиница",
  хостел: "Гостиница",
  чайная: "Кафе",
  храм: "Церковь",
  "джамаат-хана": "Мечеть",
  "здание библиотеки": "Библиотека",
};

/**
 * Ключ таблицы `table` для категории из справочника: сперва тот же ключ без
 * учёта регистра («ВУЗ» → «Вуз»), затем синоним источника («Торговый центр» →
 * «ТЦ»), иначе категория как есть (таблица ответит своим «по умолчанию»).
 */
export function landmarkCategoryKey(category: string, table: Readonly<Record<string, unknown>>): string {
  const lower = category.trim().toLowerCase();
  for (const key of Object.keys(table)) if (key.toLowerCase() === lower) return key;
  return CATEGORY_SYNONYMS[lower] ?? category;
}

/**
 * Все написания той же категории — для фильтра справочника: агент выбирает
 * «ТЦ», а 28 торговых центров из источника записаны «Торговый центр».
 */
export function landmarkCategorySpellings(category: string): string[] {
  const lower = category.trim().toLowerCase();
  const canonical = (CATEGORY_SYNONYMS[lower] ?? category.trim()).toLowerCase();
  const spellings = new Set([category.trim(), canonical]);
  for (const [synonym, key] of Object.entries(CATEGORY_SYNONYMS)) {
    if (key.toLowerCase() === canonical) spellings.add(synonym);
  }
  return [...spellings];
}

const CYRILLIC = /[а-яёӯӣҳқғҷ]/i;

/**
 * НАЗВАНИЕ, КОТОРОЕ ПРОЧТЁТ ЧЕЛОВЕК. 112 из 857 записей справочника пришли из
 * OpenStreetMap латиницей: «Vadanasos Park», «Sportkompleks», а под категорией
 * «Базар» — лавки «Sherali», «Amina», которых в городе никто не знает. Берём
 * кириллическое название из синонимов, если оно есть («Bozori Korvon» →
 * «Бозори Корвон»); `null` — у записи нет ни одного кириллического имени, и
 * называть её вслух (в строке места, в поле «Ориентир», в ответе бота) нельзя:
 * ориентир, который надо переводить, не ориентир.
 */
export function readableLandmarkName(name: string, aliases: readonly string[] | null | undefined): string | null {
  if (CYRILLIC.test(name)) return name;
  return (aliases ?? []).map((a) => a.trim()).find((a) => CYRILLIC.test(a)) ?? null;
}
