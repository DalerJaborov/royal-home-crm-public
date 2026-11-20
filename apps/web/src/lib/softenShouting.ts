/**
 * ЗАМЕТКИ БЕЗ КРИКА (владелец 20.11.2026): «📞 ПРОСИТ ПЕРЕЗВОНИТЬ: Хочет продать. Слова клиента: «Салом» ❓ ТИП ОБРАЩЕНИЯ
 * НЕ ОПРЕДЕЛЁН —» — капс и значки в обычной заметке читаются как тревога. Эти метки пишет сервер (бот и звонки пишут их в
 * заметки и «Пожелания» много лет, старые записи лежат в базе), поэтому на экране их приводят к обычному виду.
 *
 * Ревью #338: правило обязано быть УЗКИМ. Приводятся только ИЗВЕСТНЫЕ шаблонные метки из списка ниже; любой другой текст
 * заглавными («ЖК ДИАМОНД», «ООО СОМОН ТРЕЙД», «ГУВД», имена и сокращения) остаётся как написан. Новая серверная метка
 * капсом — одна строка в список.
 */
export const KNOWN_SHOUTING_LABELS = ["ПРОСИТ ПЕРЕЗВОНИТЬ", "ТИП ОБРАЩЕНИЯ НЕ ОПРЕДЕЛЁН"] as const;

const SYMBOLS = String.raw`\p{Extended_Pictographic}️‍`;
const SOFT = KNOWN_SHOUTING_LABELS.map((label) => ({
  re: new RegExp(String.raw`(?:[${SYMBOLS}]+\s*)?${label}`, "gu"),
  text: label.charAt(0) + label.slice(1).toLowerCase(),
}));

export function softenShouting(text: string | null | undefined): string {
  if (!text) return "";
  let out = text;
  for (const { re, text: soft } of SOFT) out = out.replace(re, soft);
  return out;
}
