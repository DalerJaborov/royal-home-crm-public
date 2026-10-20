/**
 * Общие помощники для текста внутри SVG-оверлеев, которые sharp растеризует
 * через librsvg/pango (карточка-история `storyCard.ts` и обложка-постер
 * `coverPoster.ts`). Вынесены сюда 21.09.2026 при добавлении второго
 * SVG-рендера, чтобы не заводить вторую копию переноса строк и подбора
 * кегля — то же правило, что и у форматирования данных объекта.
 */

export function escapeXml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

/** Ширина текста в px — у нас нет реальных метрик шрифта на этапе сборки SVG
 *  (шрифт резолвит fontconfig внутри sharp), коэффициент подобран с запасом
 *  (переоценка безопаснее недооценки: лучше перенести строку раньше срока,
 *  чем дать ей вылезти за поле). Кириллица шире латиницы, коэффициент
 *  считался по ней — тот же принцип для любого использующего шрифта. */
export function approxCharWidth(fontSize: number, bold: boolean): number {
  return fontSize * (bold ? 0.62 : 0.56);
}

export function textWidth(text: string, fontSize: number, bold: boolean): number {
  return text.length * approxCharWidth(fontSize, bold);
}

/** Перенос по словам, если строка не влезает в maxWidth. Слово длиннее
 *  maxWidth само по себе не разбивается по буквам — для таких случаев
 *  вызывающий код сначала уменьшает кегль через fitFontSize. */
export function wrapText(text: string, fontSize: number, bold: boolean, maxWidth: number): string[] {
  const words = text.split(/\s+/).filter(Boolean);
  if (!words.length) return [];
  const lines: string[] = [];
  let current = words[0];
  for (const word of words.slice(1)) {
    const candidate = `${current} ${word}`;
    if (textWidth(candidate, fontSize, bold) <= maxWidth) {
      current = candidate;
    } else {
      lines.push(current);
      current = word;
    }
  }
  lines.push(current);
  return lines;
}

/** Уменьшает кегль (шаг 2px), пока строка целиком не влезет в maxWidth или
 *  пока не упрётся в minFontSize. Используется для однострочных элементов,
 *  которым перенос на две строки портит вид карточки сильнее, чем
 *  уменьшенный кегль (цена, номер объекта и т.п.). */
export function fitFontSize(text: string, maxFontSize: number, minFontSize: number, bold: boolean, maxWidth: number): number {
  let size = maxFontSize;
  while (size > minFontSize && textWidth(text, size, bold) > maxWidth) {
    size -= 2;
  }
  return size;
}
