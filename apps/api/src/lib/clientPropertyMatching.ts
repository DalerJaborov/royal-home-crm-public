import { propertyFieldShown, type ClientPropertyMatchEvidence } from "@royal-home/shared";
import { nearestDesiredPlace, type DesiredPlacePoint } from "./geoDistance.js";
import { toTjs, type MoneyContext } from "./money.js";
import { budgetWindowTjs, type MatchPolicy } from "./matchPolicy.js";
import { propertyOwnerAgentId, type PropertyOwnerFields } from "./propertyOwner.js";

export interface MatchingBuyerCriteria {
  currency: string;
  budgetMin: unknown;
  budgetMax: unknown;
  desiredDistrictId: string | null;
  desiredType: string | null;
  desiredRooms: number | null;
  desiredAreaMin?: number | null;
  desiredFloorMin?: number | null;
  desiredFloorMax?: number | null;
  desiredTotalFloors?: number | null;
  desiredPlaces: DesiredPlacePoint[];
  requirementsNotes: string | null;
}

/** The shared form columns may still hold the previous seller's expected sale price. */
export function currentBuyerMatchingCriteria(client: MatchingBuyerCriteria & { requirementsFieldsKind?: string | null }): MatchingBuyerCriteria {
  if (client.requirementsFieldsKind == null || client.requirementsFieldsKind === "BUYER") return client;
  return { ...client, budgetMin: null, budgetMax: null, desiredDistrictId: null, desiredType: null,
    desiredRooms: null, desiredAreaMin: null, desiredFloorMin: null, desiredFloorMax: null,
    desiredTotalFloors: null, desiredPlaces: [], requirementsNotes: null };
}

export interface MatchingPropertyFacts extends PropertyOwnerFields {
  id: string;
  shortId: number;
  type: string;
  districtId: string | null;
  price: unknown;
  currency: string;
  rooms: number | null;
  areaSqm: unknown;
  floor: number | null;
  totalFloors: number | null;
  lat: unknown;
  lng: unknown;
  condition: string;
  marketType: string | null;
  amenities: string[];
  details: unknown;
  description: string | null;
}

type WishKey = "renovated" | "furniture" | "parking" | "lift" | "balcony" | "newBuild";
interface TextWish { key: WishKey; wanted: boolean; label: string }

/** Deliberately narrow: only explicit wishes; negation is parsed before positive words. */
export function clientTextWishes(notes: string | null): TextWish[] {
  const text = (notes ?? "").toLocaleLowerCase("ru").replace(/ё/g, "е");
  const result: TextWish[] = [];
  const featureWords: Record<WishKey, string> = {
    renovated: "ремонт", furniture: "мебел", parking: "парковк", lift: "лифт", balcony: "балкон", newBuild: "новостройк",
  };
  const optionalWords = "(?:не\\s+(?:нуж[а-я]*|важ[а-я]*|обязател[а-я]*|треб[а-я]*)|неваж[а-я]*|необязател[а-я]*)";
  const add = (key: WishKey, label: string, positive: RegExp, negative: RegExp) => {
    const noun = `${featureWords[key]}[а-я]*`;
    // "Не нужен лифт" means no requirement, not a request for a building without one.
    // On ambiguous/contradictory notes prefer no automated claim for this feature.
    if (new RegExp(`(?:${noun}\\s+${optionalWords}|${optionalWords}\\s+${noun})`).test(text)) return;
    if (negative.test(text)) result.push({ key, label, wanted: false });
    else if (positive.test(text)) result.push({ key, label, wanted: true });
  };
  add("renovated", "Ремонт", /с\s+ремонт|готов[а-яa-z]*\s+к\s+проживан/, /без\s+ремонт|не\s+с\s+ремонт|под\s+ремонт|нуж[а-яa-z]*\s+ремонт|коробк/);
  add("furniture", "Мебель", /с\s+мебель|меблирован/, /без\s+мебел/);
  add("parking", "Парковка", /(?:нуж[а-яa-z]*|важ[а-яa-z]*|с)\s+парковк|парковка\s+(?:обязательна|нужна)/, /без\s+парковк/);
  add("lift", "Лифт", /(?:нуж[а-яa-z]*|важ[а-яa-z]*|с)\s+лифт|лифт\s+(?:обязателен|нужен)/, /без\s+лифт/);
  add("balcony", "Балкон", /с\s+балкон|балкон\s+(?:обязателен|нужен)/, /без\s+балкон/);
  add("newBuild", "Новостройка", /новостройк/, /не\s+новостройк|вторичк|вторичн[а-яa-z]*\s+рын/);
  return result;
}

function detail(property: MatchingPropertyFacts, key: string): string {
  const details = property.details;
  if (!details || typeof details !== "object" || Array.isArray(details)) return "";
  const value = (details as Record<string, unknown>)[key];
  return typeof value === "string" ? value.toLocaleLowerCase("ru").trim() : "";
}

function factText(property: MatchingPropertyFacts, key: WishKey): boolean | null {
  if (key === "renovated") {
    if (["GOOD", "EXCELLENT"].includes(property.condition)) return true;
    if (property.condition === "NEEDS_REPAIR") return false;
  }
  if (key === "newBuild") {
    if (property.marketType === "NEW_BUILD") return true;
    if (property.marketType === "SECONDARY") return false;
  }
  const field = key === "lift" ? "elevator" : key;
  const value = detail(property, field) || (key === "lift" ? detail(property, "lift") : "");
  if (value) {
    if (value === "неизвестно" || value === "не указано") return null;
    if (/^(нет|без\s|отсутств|не\s)/.test(value)) return false;
    return true;
  }
  // These are recorded statements, not inferred proximity or visual attributes.
  const text = [property.amenities.join(". "), property.description ?? ""].join(". ").toLocaleLowerCase("ru");
  const patterns: Partial<Record<WishKey, [RegExp, RegExp]>> = {
    lift: [/(?:есть|имеется)\s+лифт|(?:^|[.;,]\s*)лифт(?:$|[.;,])/, /без\s+лифт|лифта\s+нет|лифт\s+не\s+работ/],
    parking: [/(?:есть|имеется)\s+парковк|(?:^|[.;,]\s*)парковка(?:$|[.;,])/, /без\s+парковк|парковки\s+нет/],
    furniture: [/с\s+мебель|меблирован/, /без\s+мебел|мебели\s+нет/],
    balcony: [/с\s+балкон|(?:есть|имеется)\s+балкон|(?:^|[.;,]\s*)балкон(?:$|[.;,])/, /без\s+балкон|балкона\s+нет/],
  };
  const pattern = patterns[key];
  if (pattern?.[1].test(text)) return false;
  if (pattern?.[0].test(text)) return true;
  return null;
}

export function hasClientMatchingCriteria(client: MatchingBuyerCriteria): boolean {
  const numericCriteria = [client.budgetMin, client.budgetMax, client.desiredRooms, client.desiredAreaMin,
    client.desiredFloorMin, client.desiredFloorMax, client.desiredTotalFloors];
  return numericCriteria.some(value => value != null) || Boolean(client.desiredDistrictId || client.desiredType ||
    client.desiredPlaces.length || client.requirementsNotes?.trim());
}

export interface EvaluatedClientProperty {
  id: string;
  shortId: number;
  distanceM: number | null;
  /** Internal ordering only, not a probability or a customer-facing percentage. */
  quality: number;
  match: ClientPropertyMatchEvidence;
}

/** Pure comparison over known facts; null means outside the eligible set. */
export function evaluateClientProperty(
  client: MatchingBuyerCriteria, property: MatchingPropertyFacts, money: MoneyContext,
  policy: MatchPolicy, viewerId: string
): EvaluatedClientProperty | null {
  const reasons: string[] = [];
  const tradeoffs: string[] = [];
  const unknowns: string[] = [];
  let quality = 0;
  if (client.desiredType && property.type !== client.desiredType) return null;
  if (client.desiredType) { reasons.push("Тип объекта подходит"); quality += 3; }
  const place = property.lat != null && property.lng != null
    ? nearestDesiredPlace(Number(property.lat), Number(property.lng), client.desiredPlaces) : null;
  const districtMatches = client.desiredDistrictId != null && property.districtId === client.desiredDistrictId;
  if (client.desiredDistrictId || client.desiredPlaces.length) {
    if (!districtMatches && !place?.withinRadius) return null;
    if (districtMatches) { reasons.push("Нужный район"); quality += 4; }
    if (place?.withinRadius) { reasons.push(`До ориентира ${Math.round(place.distanceM)} м`); quality += 3; }
    else if (client.desiredPlaces.length && property.lat == null) unknowns.push("Расстояние до ориентира не проверено");
  }
  const price = toTjs(property.price, property.currency, money);
  const min = client.budgetMin != null ? toTjs(client.budgetMin, client.currency, money) : null;
  const max = client.budgetMax != null ? toTjs(client.budgetMax, client.currency, money) : null;
  const window = budgetWindowTjs(min, max, policy);
  if ((window.min != null && price < window.min) || (window.max != null && price > window.max)) return null;
  if (min != null || max != null) {
    if (max != null && price > max) tradeoffs.push(`Дороже бюджета на ${Math.round(price - max).toLocaleString("ru-RU")} сомони`);
    else if (min != null && price < min) tradeoffs.push("Цена ниже указанного диапазона");
    else { reasons.push("В бюджете"); quality += 5; }
  }
  if (client.desiredRooms != null && propertyFieldShown(property.type, "rooms")) {
    if (property.rooms == null) unknowns.push("Комнаты не указаны");
    else if (Math.abs(property.rooms - client.desiredRooms) > policy.roomsTolerance) return null;
    else if (property.rooms === client.desiredRooms) { reasons.push(`${property.rooms} комнаты — как в запросе`); quality += 5; }
    else tradeoffs.push(`${property.rooms} комнаты вместо ${client.desiredRooms}`);
  }
  if (client.desiredAreaMin != null) {
    if (property.areaSqm == null) unknowns.push("Площадь не указана");
    else if (Number(property.areaSqm) < client.desiredAreaMin * (1 - policy.areaToleranceRatio)) return null;
    else if (Number(property.areaSqm) < client.desiredAreaMin) tradeoffs.push(`Площадь ${Number(property.areaSqm)} м² вместо ${client.desiredAreaMin} м²`);
    else { reasons.push(`Площадь от ${client.desiredAreaMin} м²`); quality += 3; }
  }
  const text = (client.requirementsNotes ?? "").toLocaleLowerCase("ru").replace(/ё/g, "е");
  const notFirst = /не\s+перв[а-яa-z]*|кроме\s+перв[а-яa-z]*/.test(text);
  const notLast = /не\s+последн[а-яa-z]*|кроме\s+последн[а-яa-z]*/.test(text);
  if (propertyFieldShown(property.type, "floor") && (client.desiredFloorMin != null || client.desiredFloorMax != null || notFirst || notLast)) {
    if (property.floor == null) unknowns.push("Этаж не указан");
    else {
      if ((client.desiredFloorMin != null && property.floor < client.desiredFloorMin) ||
        (client.desiredFloorMax != null && property.floor > client.desiredFloorMax) || (notFirst && property.floor === 1) ||
        (notLast && property.totalFloors != null && property.floor === property.totalFloors)) return null;
      if (notLast && property.totalFloors == null) unknowns.push("Неизвестно, последний ли этаж");
      else { reasons.push(`Этаж ${property.floor} подходит`); quality += 3; }
    }
  }
  if (client.desiredTotalFloors != null) {
    if (property.totalFloors == null) unknowns.push("Этажность дома не указана");
    else if (property.totalFloors > client.desiredTotalFloors) return null;
    else { reasons.push(`Дом не выше ${client.desiredTotalFloors} этажей`); quality += 2; }
  }
  const wishes = clientTextWishes(client.requirementsNotes);
  for (const wish of wishes) {
    const fact = factText(property, wish.key);
    if (fact == null) unknowns.push(`${wish.label}: нужно уточнить`);
    else if (fact === wish.wanted) {
      const value = wish.key === "newBuild" ? (fact ? "новое жильё" : "вторичное жильё")
        : wish.key === "renovated" ? (fact ? "готовый" : "требуется") : (fact ? "есть" : "отсутствует");
      reasons.push(`${wish.label}: ${value}`); quality += 3;
    }
    else tradeoffs.push(`${wish.label}: не соответствует пожеланию`);
  }
  // Free text can contain unmodelled conditions (documents, schools, a specific view).
  // Never turn a few recognised words into a claim that every written wish was checked.
  if (client.requirementsNotes?.trim()) unknowns.push("Остальные условия из заметок проверьте перед отправкой");
  if (!hasClientMatchingCriteria(client)) unknowns.push("Сначала уточните пожелания покупателя");
  const tier = tradeoffs.length ? "alternative" : unknowns.length ? "needs_verification" : "exact";
  return { id: property.id, shortId: property.shortId, distanceM: place ? Math.round(place.distanceM) : null, quality,
    match: { tier, reasons, tradeoffs, unknowns, isMine: propertyOwnerAgentId(property) === viewerId, lastSentAt: null, sentCount: 0 } };
}

export function compareClientProperties(a: EvaluatedClientProperty, b: EvaluatedClientProperty): number {
  const tierRank = { exact: 0, needs_verification: 1, alternative: 2 };
  return tierRank[a.match.tier] - tierRank[b.match.tier] ||
    a.match.tradeoffs.length - b.match.tradeoffs.length || a.match.unknowns.length - b.match.unknowns.length ||
    b.quality - a.quality || (a.distanceM ?? Infinity) - (b.distanceM ?? Infinity) ||
    Number(b.match.isMine) - Number(a.match.isMine) || b.shortId - a.shortId;
}
