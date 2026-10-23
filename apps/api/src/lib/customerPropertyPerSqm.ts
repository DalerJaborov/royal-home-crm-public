import type { CustomerPropertyFacts } from "@royal-home/shared";
import { BW, EW, TAIL } from "../ai/wordBoundary.js";

/** Price-per-square-metre wording (ru/tg). The source is shared with the fact
 * classifier so the fast path consumes exactly what the renderer answers. */
export const PER_SQM_SOURCE = `(?:за\\s+)?(?:(?:один|1|каждый|кажд${TAIL})\\s+)?(?:кв\\.?\\s*м(?:етр${TAIL})?|квадрат${TAIL}(?:\\s+метр${TAIL})?|м2|метр${TAIL}\\s+квадратн${TAIL})|(?:барои\\s+як|нархи\\s+як|ҳар)\\s+(?:метр|кв)${TAIL}(?:\\s+мураббаъ)?|(?:як\\s+)?метр(?:и)?\\s+мураббаъ`;
const PER_SQM = new RegExp(`${BW}(?:${PER_SQM_SOURCE})${EW}`, "iu");

export function customerAsksPricePerSqm(text: string): boolean {
  return PER_SQM.test(text.replace(/²/gu, "2").replace(/ /gu, " "));
}

/** Server arithmetic over the two confirmed facts only; never a model figure.
 * Whole units, marked approximate, and an honest line when the area is absent. */
export function pricePerSqmLine(f: Pick<CustomerPropertyFacts, "price" | "currency" | "characteristics">, language: "ru" | "tg"): string {
  const tg = language === "tg";
  const price = f.price === null ? NaN : Number(f.price);
  const area = Number(f.characteristics?.areaSqm ?? NaN);
  if (!Number.isFinite(price) || price <= 0) return tg ? "Нархи як метри мураббаъро бе нархи тасдиқшуда ҳисоб карда наметавонам." : "Цену за квадратный метр не могу посчитать без подтверждённой цены.";
  if (!Number.isFinite(area) || area <= 0) return tg ? "Масоҳат нишон дода нашудааст, барои ҳамин нархи як метри мураббаъро ҳисоб карда наметавонам." : "Площадь не указана, поэтому цену за квадратный метр посчитать не могу.";
  const amount = Math.round(price / area).toString().replace(/\B(?=(\d{3})+(?!\d))/g, " ");
  const money = `${amount} ${f.currency === "USD" ? "USD" : tg ? "сомонӣ" : "сомони"}`;
  return tg ? `Нархи тақрибан барои як метри мураббаъ: ≈ ${money}.` : `Цена за квадратный метр: ≈ ${money}.`;
}
