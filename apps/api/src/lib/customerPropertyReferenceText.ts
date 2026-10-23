import { BW, EW } from "../ai/wordBoundary.js";

/** Link written without a scheme ("instagram.com/p/…", "www.royalhome.tj/…").
 * Only our own and the two social hosts we can read; the character before the
 * host must not continue a word, a path or an e-mail/user (so a scheme-ful URL
 * is never matched twice). */
const SCHEMELESS_PROPERTY_URL = /(?<![\p{L}\p{N}/@.:_-])((?:www\.|m\.|web\.)?(?:royalhome\.tj|instagram\.com|facebook\.com)\/[^\s<>"'«»]*)/giu;

export function schemelessPropertyUrls(text: string): string[] {
  return [...text.matchAll(SCHEMELESS_PROPERTY_URL)].map(match => `https://${match[1].replace(/[),.;!?]+$/u, "")}`);
}
export function stripSchemelessPropertyUrls(text: string): string {
  return text.replace(SCHEMELESS_PROPERTY_URL, " ");
}

/** "объект №12" / "№12": the strong, long-standing public-selector forms. */
export const STRONG_PROPERTY_NUMBER_SOURCE = `${BW}(?:(?:объект[а-яё]*|объекти?)\\s*[№#]?\\s*|[№#]\\s*)(\\d{1,9})(?!\\d)`;
/** "номер 12", "рақами объект 12", "id 12": a short object number, never a phone
 * — at most six digits and not the head of a longer digit group ("номер 98 765 4321"). */
export const WEAK_PROPERTY_NUMBER_SOURCE =
  `${BW}(?:номер(?:а|у|ом)?|рақам(?:и)?(?:\\s+объект\\p{L}*)?|id|ид|айди)\\s*[:№#]?\\s*([1-9]\\d{0,5})(?!\\d|[ \\-]\\d)${EW}`;
export function propertyNumberSelectors(text: string): string[] {
  const numbers = new Set<string>();
  for (const source of [STRONG_PROPERTY_NUMBER_SOURCE, WEAK_PROPERTY_NUMBER_SOURCE]) {
    for (const match of text.matchAll(new RegExp(source, "giu"))) numbers.add(match[1]);
  }
  return [...numbers].filter(value => Number(value) > 0);
}
