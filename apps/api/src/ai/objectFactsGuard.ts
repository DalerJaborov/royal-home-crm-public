import { propertyFinishSummary, type MarketType, type PropertyCondition, type PropertyStage } from "@royal-home/shared";
import { keepSentences } from "./priceGuard.js";

/**
 * ФАКТЫ ОБЪЕКТА В ОТВЕТЕ СТАРОГО БОТА — ТОЛЬКО ИЗ КАРТОЧКИ (16.11.2026, аудит facts.md Ф2/Ф3).
 *
 * Живые случаи (Instagram Arvan, 15.11): «дар 82 мкр 91 квадрат бо ремонти нав ҳаст» — у этого
 * объекта в карточке коробка (stage=SHELL). Модель НЕ МОГЛА знать состояние: в строке подборки
 * (ai/leadQualifier.ts::searchMatchingProperties) его не было вовсе, только район, цена,
 * площадь и этаж. Лечится двумя рубежами, как всё дорогое в этом проекте:
 *  1. состояние карточки теперь стоит в строке подборки (`catalogConditionNote`);
 *  2. фраза «с ремонтом» про объект, у которого ремонта в карточке нет, вырезается кодом
 *     (`guardRenovationClaims`): промт — просьба, а не гарантия.
 */

/** «, состояние: коробка, черновые не сделаны» — для строки подборки; пусто, если не выбрано. */
export function catalogConditionNote(p: {
  type?: string | null;
  marketType?: string | null;
  stage?: string | null;
  condition?: string | null;
}): string {
  const summary = propertyFinishSummary({
    type: p.type,
    marketType: (p.marketType ?? null) as MarketType | null,
    stage: (p.stage ?? null) as PropertyStage | null,
    condition: (p.condition ?? null) as PropertyCondition | null,
  });
  return summary ? `, состояние: ${summary.toLowerCase()}` : "";
}

/** Состояние в строке подборки, при котором «с ремонтом» — правда. */
const RENOVATED_IN_CATALOG = /состояние:[^\n(—]*?(?:с ремонтом|хорошее состояние|отличное состояние)/iu;

/** Утверждение «с ремонтом» по-русски и по-таджикски. «Бе ремонт», «без ремонта» сюда не входят. */
const RENOVATION_CLAIM =
  /(?<![\p{L}])(?:со?\s+(?:евро)?ремонтом|евроремонт\p{L}*|отремонтирован\p{L}*|бо\s+(?:евро)?(?:ремонт|таъмир|тамир)(?:и\s+нав)?|(?:ремонти|таъмири|тамири)\s+нав|ремонташ\s+(?:нав|тайёр|тайер|хуб)|ремонт\s+(?:дорад|ҳаст|хаст))(?![\p{L}])/iu;

/**
 * Фраза говорит о существующем объекте: «ҳаст/дорем/аст/есть», площадь или цена рядом
 * («Квартира с ремонтом, 870 000 сомони»). Желание клиента и вопрос — не утверждение
 * («Ба Шумо хона бо ремонт лозим аст», «бо ремонт бошад ё каробка?»).
 */
const OBJECT_EXISTS = /(?<![\p{L}])(?:ҳаст|хаст|дорем|дорад|аст|есть|имеется|продаётся|продается|фурӯхта\s+мешавад)(?![\p{L}])/iu;
const CLIENT_WISH = /(?<![\p{L}])(?:лозим|мехоҳ\p{L}*|мехох\p{L}*|мекоб\p{L}*|даркор|бошад|бошанд|нужн\p{L}*|хотите|ищете|ищем)(?![\p{L}])/iu;
const PRICE_IN_TEXT = /\d[\d\s\u00a0]{2,}\s*(?:сомон|с\.|\$|долл)/iu;

const AREA_IN_TEXT = /(?<![\d.,])(\d{2,4}(?:[.,]\d{1,2})?)\s*(?:м²|м2|кв\.?\s*м|квм|квадрат\p{L}*|метр\p{L}*)/giu;

function areasOf(text: string): number[] {
  return [...text.matchAll(AREA_IN_TEXT)].map((m) => Number(m[1].replace(",", "."))).filter(Number.isFinite);
}

interface CatalogLine {
  area: number | null;
  renovated: boolean;
}

function catalogLines(propsBlock: string): CatalogLine[] {
  return propsBlock
    .split("\n")
    .filter((l) => /^-\s*№\d+/.test(l.trim()))
    .map((l) => ({ area: areasOf(l)[0] ?? null, renovated: RENOVATED_IN_CATALOG.test(l) }));
}

function claimAllowed(sentence: string, lines: CatalogLine[]): boolean {
  const areas = areasOf(sentence);
  if (areas.length > 0) {
    const same = lines.filter((l) => l.area !== null && areas.some((a) => Math.abs(a - l.area!) <= 1));
    // Объекта с такой площадью в подборке нет — состояние модели взять неоткуда.
    return same.some((l) => l.renovated);
  }
  return lines.some((l) => l.renovated);
}

export function guardRenovationClaims(bubbles: string[], propsBlock: string): { bubbles: string[]; removed: number } {
  const lines = catalogLines(propsBlock);
  // Подборки нет (разговор про присланный пост, рекламу) — сверять не с чем; молчание сторожа
  // лучше, чем вырезать правду из подписи нашей публикации (ревью #207, С3).
  if (lines.length === 0) return { bubbles, removed: 0 };
  let removed = 0;
  const out = bubbles
    .map((b) =>
      keepSentences(b, (sentence) => {
        if (/\?\s*$/.test(sentence)) return true;
        if (!RENOVATION_CLAIM.test(sentence)) return true;
        if (CLIENT_WISH.test(sentence)) return true;
        if (!OBJECT_EXISTS.test(sentence) && areasOf(sentence).length === 0 && !PRICE_IN_TEXT.test(sentence)) return true;
        if (claimAllowed(sentence, lines)) return true;
        removed += 1;
        return false;
      })
    )
    .filter((b) => b.trim().length > 0);
  return { bubbles: removed > 0 ? out : bubbles, removed };
}

/** Замена вырезанной выдумки про место: честно и на языке клиента. */
export function placeAskAgentReply(language: string): string {
  return language === "ru"
    ? "Точное расположение и состояние подскажет агент."
    : "Ҷои аниқ ва ҳолати хонаро агенти мо мегӯяд.";
}
