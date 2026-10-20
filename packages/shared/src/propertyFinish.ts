import type { MarketType, PropertyCondition, PropertyStage } from "./enums.js";
import { propertyHasCondition, propertyHasMarket } from "./propertyTypeFields.js";

/**
 * «ВТОРИЧКА ИЛИ НОВОСТРОЙКА, И В КАКОМ ОНА ВИДЕ» — ОДИН ВОПРОС ВМЕСТО ТРЁХ
 * (владелец 23.09.2026, скриншот мастера с телефона).
 *
 * Было три независимых ряда кнопок: «Состояние» (с «Новостройкой» внутри),
 * «Новостройка / вторичка / котлован» и «Стадия строительства» (снова с
 * котлованом). «Новостройка» стояла в двух рядах, «Котлован» — в двух, «Коробка
 * (без отделки)» по смыслу и была «черновые не сделаны», а «черновые сделаны»
 * выбрать было нельзя вовсе. Агент мог нажать «Требует ремонта» + «Новостройки»
 * + «Построен» — три ответа, которые друг другу противоречат.
 *
 * Теперь: сначала «Вторичка / Новостройка». У вторички — состояние ремонта.
 * У новостройки — одна фаза, которая сама раскладывается в три поля базы
 * (marketType, stage, condition). Поля базы не менялись: подбор, бот, подписи и
 * сайт читают их как раньше. Эта таблица — единственное место правила: мастер и
 * форма правки зовут её отсюда.
 */
export type PropertyMarketSide = "SECONDARY" | "NEW";

export const NEW_BUILD_PHASES = [
  { key: "FOUNDATION_PIT", label: "Котлован", marketType: "FOUNDATION_PIT", stage: "FOUNDATION", condition: "NEW_BUILDING" },
  { key: "UNDER_CONSTRUCTION", label: "Строится", marketType: "NEW_BUILD", stage: "UNDER_CONSTRUCTION", condition: "NEW_BUILDING" },
  { key: "SHELL", label: "Коробка, черновые не сделаны", marketType: "NEW_BUILD", stage: "SHELL", condition: "NEW_BUILDING" },
  { key: "ROUGH_FINISH", label: "Черновые работы сделаны", marketType: "NEW_BUILD", stage: "ROUGH_FINISH", condition: "NEW_BUILDING" },
  { key: "RENOVATED", label: "Сдан, с ремонтом", marketType: "NEW_BUILD", stage: "BUILT", condition: "EXCELLENT" },
] as const satisfies readonly {
  key: string;
  label: string;
  marketType: MarketType;
  stage: PropertyStage;
  condition: PropertyCondition;
}[];

export type NewBuildPhase = (typeof NEW_BUILD_PHASES)[number]["key"];

/** Состояние у вторички. «Новостройка» сюда не входит — это уже другой ответ. */
export const SECONDARY_CONDITIONS = ["NEEDS_REPAIR", "GOOD", "EXCELLENT"] as const satisfies readonly PropertyCondition[];

/** Сторона рынка по сохранённым полям. Старые объекты без marketType, но с
 *  состоянием «Новостройка», читаются как новостройка. */
export function marketSideOf(p: { marketType?: MarketType | "" | null; condition?: PropertyCondition | null }): PropertyMarketSide | null {
  if (p.marketType === "SECONDARY") return "SECONDARY";
  if (p.marketType === "NEW_BUILD" || p.marketType === "FOUNDATION_PIT") return "NEW";
  if (p.condition === "NEW_BUILDING") return "NEW";
  return null;
}

/** Фаза новостройки по сохранённым полям; null — ещё не выбрана. */
export function newBuildPhaseOf(p: {
  marketType?: MarketType | "" | null;
  stage?: PropertyStage | "" | null;
  condition?: PropertyCondition | null;
}): NewBuildPhase | null {
  if (p.marketType === "FOUNDATION_PIT" || p.stage === "FOUNDATION") return "FOUNDATION_PIT";
  if (p.stage === "UNDER_CONSTRUCTION") return "UNDER_CONSTRUCTION";
  if (p.stage === "SHELL") return "SHELL";
  if (p.stage === "ROUGH_FINISH") return "ROUGH_FINISH";
  if (p.stage === "BUILT") return p.condition === "NEW_BUILDING" ? "SHELL" : "RENOVATED";
  return null;
}

/** Три поля базы для выбранной фазы новостройки. */
export function fieldsForNewBuildPhase(phase: NewBuildPhase): {
  marketType: MarketType;
  stage: PropertyStage;
  condition: PropertyCondition;
} {
  const p = NEW_BUILD_PHASES.find((x) => x.key === phase)!;
  return { marketType: p.marketType, stage: p.stage, condition: p.condition };
}

/**
 * ЭТАЖ НЕ ВЫШЕ ЭТАЖНОСТИ (23.09.2026: на скриншоте мастера «этаж 5» при «2 этажа
 * в доме» сохранялось). Одна проверка на мастер, форму правки и сервер. Этаж 0 и
 * ниже — цоколь и подвал, их не трогаем.
 */
export function floorRuleError(floor: number | null | undefined, totalFloors: number | null | undefined): string | null {
  if (floor == null || totalFloors == null) return null;
  if (!Number.isFinite(floor) || !Number.isFinite(totalFloors)) return null;
  if (totalFloors > 0 && floor > totalFloors) return "Этаж не может быть выше этажности дома";
  return null;
}

const SECONDARY_CONDITION_WORDS: Record<(typeof SECONDARY_CONDITIONS)[number], string> = {
  NEEDS_REPAIR: "требует ремонта",
  GOOD: "хорошее состояние",
  EXCELLENT: "отличное состояние",
};

/** Одна строка для карточки и проверки мастера: «Вторичка, хорошее состояние»,
 *  «Новостройка, черновые работы сделаны». null — ничего не выбрано.
 *  С типом: у дома — только состояние (без «вторички/новостройки»), у участка —
 *  ничего (propertyTypeFields.ts, владелец 08.10.2026). */
export function propertyFinishSummary(p: {
  type?: string | null;
  marketType?: MarketType | "" | null;
  stage?: PropertyStage | "" | null;
  condition?: PropertyCondition | null;
}): string | null {
  if (p.type && !propertyHasCondition(p.type)) return null;
  if (p.type && !propertyHasMarket(p.type)) {
    const only = p.condition && p.condition !== "NEW_BUILDING" ? SECONDARY_CONDITION_WORDS[p.condition] : null;
    return only ? only.charAt(0).toUpperCase() + only.slice(1) : null;
  }
  const side = marketSideOf(p);
  if (side === "NEW") {
    const phase = newBuildPhaseOf(p);
    const label = phase ? NEW_BUILD_PHASES.find((x) => x.key === phase)!.label : null;
    return label ? `Новостройка, ${label.charAt(0).toLowerCase()}${label.slice(1)}` : "Новостройка";
  }
  const cond = p.condition && p.condition !== "NEW_BUILDING" ? SECONDARY_CONDITION_WORDS[p.condition] : null;
  if (side === "SECONDARY") return cond ? `Вторичка, ${cond}` : "Вторичка";
  return cond ? cond.charAt(0).toUpperCase() + cond.slice(1) : null;
}
