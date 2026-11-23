/**
 * Ряды, которые листаются вбок (вкладки, фильтры, миниатюры), и признак «дальше есть ещё» (аудит К20, 21.11.2026).
 *
 * Затухание у края делает CSS (theme-look-royal.css): где есть `animation-timeline` — по прокрутке самого ряда,
 * где нет (Safari до 26, WebKit в Playwright) — по атрибуту `data-strip-more`, который здесь считает хук
 * useScrollStripHints. Без этого «Таблица» и «Звонки» на iPhone были просто обрезаны краем.
 * Список классов — ровно тот, что в правиле `animation: ry-strip-more` (сверяет theme-look-royal.test.ts).
 */
export const STRIP_CLASSES = [
  "seg-ai", "stg", "cef-pills", "cef-main-tabs", "seg", "rh-filters-scroll", "hscroll", "rh-tabs-scroll",
  "ry-ctabs", "ry-chat-quick", "ry-deals-stages", "ry-set-tasks", "ry-gal-thumbs", "ry-agc-tabs",
] as const;
export const STRIP_SELECTOR = STRIP_CLASSES.map((c) => `.${c}`).join(",");

export type StripMore = "none" | "end" | "start" | "both";

/** Допуск в 4 px: дробные размеры и округление прокрутки не должны показывать «дальше есть» на ровном ряду. */
export function stripMore(m: { scrollLeft: number; scrollWidth: number; clientWidth: number }): StripMore {
  const max = m.scrollWidth - m.clientWidth;
  if (max <= 4) return "none";
  const left = Math.abs(m.scrollLeft); // в RTL прокрутка отрицательная
  const start = left > 4;
  const end = left < max - 4;
  return start && end ? "both" : end ? "end" : start ? "start" : "none";
}
