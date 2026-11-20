/**
 * ЗАМЕТКИ БЕЗ КРИКА (владелец 20.11.2026): «📞 ПРОСИТ ПЕРЕЗВОНИТЬ: Хочет продать. Слова клиента: «Салом» ❓ ТИП ОБРАЩЕНИЯ
 * НЕ ОПРЕДЕЛЁН —» — капс и значки в обычной заметке читаются как тревога. Эти строки пишет сервер (бот и звонки пишут их
 * в заметки и «Пожелания» много лет, старые записи лежат в базе), поэтому на экране их приводят к обычному виду: значки
 * в начале строки убираются, слова из заглавных букв пишутся строчными, первая буква предложения — заглавная.
 * Короткие сокращения (ИИ, СМС, ОП, ГК) не трогаются: правило касается только слов от четырёх букв.
 */
const SHOUT = /[А-ЯЁ]{2,}(?:[ \t]+[А-ЯЁ]{2,})*/gu;
const hasLongWord = (run: string) => /[А-ЯЁ]{4,}/u.test(run);
const LEADING_SYMBOLS = /^[\s\p{Extended_Pictographic}\u200d\ufe0f]+/u;
const INLINE_SYMBOLS = /[\p{Extended_Pictographic}\u200d\ufe0f]+\s*/gu;

export function softenShouting(text: string | null | undefined): string {
  if (!text) return "";
  return text
    .split("\n")
    .map((line) => {
      let hadShout = false;
      let out = line.replace(INLINE_SYMBOLS, (m, offset: number) => (offset === 0 || /^\s*$/.test(line.slice(0, offset)) ? "" : " ")).replace(LEADING_SYMBOLS, "");
      out = out.replace(SHOUT, (run) => { if (!hasLongWord(run)) return run; hadShout = true; return run.toLowerCase(); });
      if (hadShout) out = out.replace(/(^|[.!?»]\s+|:\s+)([а-яё])/gu, (_m, pre: string, ch: string) => `${pre}${ch.toUpperCase()}`);
      return out.replace(/[ \t]{2,}/g, " ").trim();
    })
    .join("\n");
}
