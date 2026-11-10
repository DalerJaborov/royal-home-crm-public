/**
 * ПОДБОР 2.0 — ОДНА МОДЕЛЬ «КЛИЕНТ ↔ ОБЪЕКТ» В ОБЕ СТОРОНЫ (владелец 10.11.2026:
 * «подходит клиентам — надо написать, что именно подходит… подбор сырой»).
 *
 * До этой правки отношение описывали ДВЕ модели: «кому подходит объект» и счётчик
 * спроса считали routes/matching.ts::clientMatchesProperty + scoreClientProperty
 * (база 40 любому прошедшему фильтр, +10 «горячему», причины только район/комнаты/
 * бюджет, площадь/этаж/тип фильтровались молча), а «какие объекты подходят
 * клиенту» — эта функция, с уровнями и честными уступками. Расходились они и в
 * фильтре: ориентир без района у первой не ограничивал ничего.
 *
 * Теперь ОДНА функция `matchClientProperty`: null — пара не проходит, иначе
 * уровень (exact/alternative/needs_verification), причины по всем полям, уступки,
 * «не знаем» и что спросить. Через неё идут: фильтр clientMatchesProperty (а
 * значит счётчик «ждут N покупателей», «Кому подходит», распределение заявок,
 * лист ожидания по цене), каталог под клиента и помощница в Telegram.
 * `points` — только шкала порога «свой объект — свой клиент» из Настроек, на экран
 * не попадает. Сторож — tests/matching-one-model.test.ts.
 */
import { MATCH_SCORE_WEIGHTS, matchTierRank, propertyFieldShown, type ClientPropertyMatchEvidence, type MatchEvidence } from "@royal-home/shared";
import { formatDistance, nearestDesiredPlace, type DesiredPlacePoint } from "./geoDistance.js";
import { toTjs, type MoneyContext } from "./money.js";
import { budgetWindowTjs, type MatchPolicy } from "./matchPolicy.js";
import { propertyOwnerAgentId, type PropertyOwnerFields } from "./propertyOwner.js";

export interface MatchingBuyerCriteria {
  /** Валюта бюджета клиента; не задана — сомони. */
  currency?: string | null;
  budgetMin: unknown;
  budgetMax: unknown;
  desiredDistrictId: string | null;
  desiredType?: string | null;
  desiredRooms: number | null;
  desiredAreaMin?: number | null;
  desiredFloorMin?: number | null;
  desiredFloorMax?: number | null;
  desiredTotalFloors?: number | null;
  desiredPlaces?: DesiredPlacePoint[] | null;
  requirementsNotes?: string | null;
}

/** The shared form columns may still hold the previous seller's expected sale price. */
export function currentBuyerMatchingCriteria<T extends MatchingBuyerCriteria & { requirementsFieldsKind?: string | null }>(client: T): T {
  if (client.requirementsFieldsKind == null || client.requirementsFieldsKind === "BUYER") return client;
  return { ...client, budgetMin: null, budgetMax: null, desiredDistrictId: null, desiredType: null,
    desiredRooms: null, desiredAreaMin: null, desiredFloorMin: null, desiredFloorMax: null,
    desiredTotalFloors: null, desiredPlaces: [], requirementsNotes: null };
}

/** Признаки объекта. Необязательные поля не знаем — пожелание по ним станет «уточнить», а не «нет». */
export interface MatchingPropertyFacts extends PropertyOwnerFields {
  id: string;
  type?: string | null;
  districtId: string | null;
  price: unknown;
  currency?: string | null;
  rooms: number | null;
  areaSqm?: unknown;
  floor?: number | null;
  totalFloors?: number | null;
  lat?: unknown;
  lng?: unknown;
  condition?: string | null;
  marketType?: string | null;
  amenities?: string[] | null;
  details?: unknown;
  description?: string | null;
  /** Документы объекта (Договор, Техпаспорт…) — только для сотрудников. */
  documents?: string | null;
}

type WishKey = "renovated" | "furniture" | "parking" | "lift" | "balcony" | "newBuild" | "documents";
interface TextWish { key: WishKey; wanted: boolean; label: string }

/** Deliberately narrow: only explicit wishes; negation is parsed before positive words. */
export function clientTextWishes(notes: string | null): TextWish[] {
  const text = (notes ?? "").toLocaleLowerCase("ru").replace(/ё/g, "е");
  const result: TextWish[] = [];
  const featureWords: Record<WishKey, string> = {
    renovated: "ремонт", furniture: "мебел", parking: "парковк", lift: "лифт", balcony: "балкон", newBuild: "новостройк",
    documents: "документ",
  };
  const optionalWords = "(?:не\\s+(?:нуж[а-я]*|важ[а-я]*|обязател[а-я]*|треб[а-я]*)|неваж[а-я]*|необязател[а-я]*)";
  const add = (key: WishKey, label: string, positive: RegExp, negative: RegExp | null) => {
    const noun = `${featureWords[key]}[а-я]*`;
    // "Не нужен лифт" means no requirement, not a request for a building without one.
    // On ambiguous/contradictory notes prefer no automated claim for this feature.
    if (new RegExp(`(?:${noun}\\s+${optionalWords}|${optionalWords}\\s+${noun})`).test(text)) return;
    if (negative?.test(text)) result.push({ key, label, wanted: false });
    else if (positive.test(text)) result.push({ key, label, wanted: true });
  };
  add("renovated", "Ремонт", /с\s+ремонт|готов[а-яa-z]*\s+к\s+проживан/, /без\s+ремонт|не\s+с\s+ремонт|под\s+ремонт|нуж[а-яa-z]*\s+ремонт|коробк/);
  add("furniture", "Мебель", /с\s+мебель|меблирован/, /без\s+мебел/);
  add("parking", "Парковка", /(?:нуж[а-яa-z]*|важ[а-яa-z]*|с)\s+парковк|парковка\s+(?:обязательна|нужна)/, /без\s+парковк/);
  add("lift", "Лифт", /(?:нуж[а-яa-z]*|важ[а-яa-z]*|с)\s+лифт|лифт\s+(?:обязателен|нужен)/, /без\s+лифт/);
  add("balcony", "Балкон", /с\s+балкон|балкон\s+(?:обязателен|нужен)/, /без\s+балкон/);
  add("newBuild", "Новостройка", /новостройк/, /не\s+новостройк|вторичк|вторичн[а-яa-z]*\s+рын/);
  // Документы: «с документами», «техпаспорт», «кадастр», «под ипотеку». Отказа от
  // документов как пожелания не бывает — только просьба, чтобы они были.
  add("documents", "Документы", /(?:с|нуж[а-я]*|важ[а-я]*)\s+документ|документ[а-я]*\s+(?:нуж|обязател|в\s+порядке|готов)|техпаспорт|кадастр|ипотек/, null);
  return result;
}

function detail(property: MatchingPropertyFacts, key: string): string {
  const details = property.details;
  if (!details || typeof details !== "object" || Array.isArray(details)) return "";
  const value = (details as Record<string, unknown>)[key];
  return typeof value === "string" ? value.toLocaleLowerCase("ru").trim() : "";
}

function factText(property: MatchingPropertyFacts, key: WishKey): boolean | null {
  // Документы записаны — есть; пусто — не знаем (а не «нет»).
  if (key === "documents") return property.documents?.trim() ? true : null;
  if (key === "renovated") {
    if (property.condition && ["GOOD", "EXCELLENT"].includes(property.condition)) return true;
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
  const text = [(property.amenities ?? []).join(". "), property.description ?? ""].join(". ").toLocaleLowerCase("ru");
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
    client.desiredPlaces?.length || client.requirementsNotes?.trim());
}

/** Пара прошла фильтр: уровень, причины и служебные числа для сортировки и порога. */
export interface ClientPropertyMatch extends MatchEvidence {
  /** Метры до ближайшего ориентира клиента; null — нет точки или ориентиров. */
  distanceM: number | null;
  /** Шкала порога «свой объект — свой клиент» (MATCH_SCORE_WEIGHTS), не процент и не на экран. */
  points: number;
}

function roomsWord(n: number): string {
  const mod10 = n % 10;
  const mod100 = n % 100;
  if (mod10 === 1 && mod100 !== 11) return "комната";
  if (mod10 >= 2 && mod10 <= 4 && (mod100 < 12 || mod100 > 14)) return "комнаты";
  return "комнат";
}
/** «на 1 комнату», «на 2 комнаты», «на 5 комнат». */
function roomsDiff(n: number): string {
  const mod10 = n % 10;
  const mod100 = n % 100;
  if (mod10 === 1 && mod100 !== 11) return `${n} комнату`;
  return `${n} ${roomsWord(n)}`;
}
// Обычный пробел вместо неразрывного из toLocaleString: одинаково в CRM, Telegram и тестах.
const tjs = (value: number) => `${Math.round(value).toLocaleString("ru-RU").replace(/ /g, " ")} сомони`;

/**
 * «Не первый и не последний этаж» из заметок. Только со словом «этаж» или
 * связкой «не первый и не последний»: «не первый раз покупаю» — не про этаж, а
 * правило исключает объект и отнимает покупателя у счётчика спроса.
 */
const NOT_FIRST = /не\s+(?:на\s+)?перв[а-я]*\s+(?:и\s+не\s+(?:на\s+)?последн[а-я]*\s+)?этаж|не\s+перв[а-я]*\s+и\s+не\s+последн|кроме\s+перв[а-я]*\s+(?:и\s+последн[а-я]*\s+)?этаж/;
const NOT_LAST = /не\s+(?:на\s+)?последн[а-я]*\s+этаж|не\s+перв[а-я]*\s+и\s+не\s+последн|кроме\s+(?:перв[а-я]*\s+и\s+)?последн[а-я]*\s+этаж/;

/**
 * ОДНА ПРОВЕРКА ПАРЫ. null — объект клиенту не подходит (вне бюджета с допуском,
 * не тот тип, не тот район и не в радиусе ориентира, комнат больше допуска,
 * площадь меньше допуска, этаж/этажность вне просьбы). Иначе — уровень и причины.
 *
 * Уровень:
 *  - есть уступка → «можно предложить»;
 *  - уступок нет, но не знаем факта по просьбе клиента или клиент не назвал
 *    главное (бюджет, район/ориентир, комнаты) → «уточнить»;
 *  - иначе → «точно подходит».
 * «Спросить» (ask) уровень не снижает: клиент не говорил про этаж — не повод
 * прятать подходящий объект, но повод спросить.
 */
export function matchClientProperty(
  client: MatchingBuyerCriteria, property: MatchingPropertyFacts, money: MoneyContext, policy: MatchPolicy
): ClientPropertyMatch | null {
  const reasons: string[] = [];
  const tradeoffs: string[] = [];
  const unknowns: string[] = [];
  const ask: string[] = [];
  const places = client.desiredPlaces ?? [];
  const w = MATCH_SCORE_WEIGHTS;
  let points: number = w.base;

  // Тип: не выбран у клиента или у объекта — не участвует (propertyTypeRule.ts).
  if (client.desiredType && property.type && property.type !== client.desiredType) return null;
  if (client.desiredType && property.type) reasons.push("Тип объекта подходит");

  // Район ИЛИ радиус ориентира (D3). Объект без точки проходит только по району:
  // близость, которую нельзя проверить, не считается совпадением (иначе ориентир
  // без района раздувал бы счётчик «ждут N покупателей» на каждом объекте).
  const place = property.lat != null && property.lng != null && places.length
    ? nearestDesiredPlace(Number(property.lat), Number(property.lng), places) : null;
  const districtMatches = client.desiredDistrictId != null && property.districtId === client.desiredDistrictId;
  if (client.desiredDistrictId || places.length) {
    if (!districtMatches && !place?.withinRadius) return null;
    if (districtMatches) { reasons.push("Нужный район"); points += w.district; }
    if (place?.withinRadius) {
      reasons.push(place.label ? `Рядом с «${place.label}»: ${formatDistance(place.distanceM)}` : `До ориентира ${formatDistance(place.distanceM)}`);
      points += w.distance;
    } else if (places.length && place == null) unknowns.push("Расстояние до ориентира не проверено");
  } else unknowns.push("Клиент не назвал район или ориентир");

  // Бюджет — в сомони по курсу (lib/money.ts), окно допуска — общей формулой.
  const price = toTjs(property.price, property.currency, money);
  const min = client.budgetMin != null ? toTjs(client.budgetMin, client.currency, money) : null;
  const max = client.budgetMax != null ? toTjs(client.budgetMax, client.currency, money) : null;
  const window = budgetWindowTjs(min, max, policy);
  if ((window.min != null && price < window.min) || (window.max != null && price > window.max)) return null;
  if (min != null || max != null) {
    if (max != null && price > max) {
      const pct = Math.max(1, Math.round(((price - max) / max) * 100));
      tradeoffs.push(`На ${pct}% дороже бюджета (+${tjs(price - max)})`);
    } else if (min != null && price < min) {
      const pct = Math.max(1, Math.round(((min - price) / min) * 100));
      tradeoffs.push(`На ${pct}% дешевле, чем искал клиент`);
    } else reasons.push("В бюджете");
    // Шкала порога — как до 10.11.2026: «в бюджете» только при названном потолке.
    if (max != null && price <= max && (min == null || price >= min)) points += w.budget;
  } else unknowns.push("Клиент не назвал бюджет");

  // Комнаты — только у типов, где они есть (у участка и коммерции их нет).
  const roomsApply = propertyFieldShown(property.type ?? "APARTMENT", "rooms");
  if (client.desiredRooms != null && roomsApply) {
    if (property.rooms == null) unknowns.push("Комнаты у объекта не указаны");
    else if (Math.abs(property.rooms - client.desiredRooms) > policy.roomsTolerance) return null;
    else if (property.rooms === client.desiredRooms) reasons.push(`${property.rooms} ${roomsWord(property.rooms)}, как просил`);
    else {
      const diff = property.rooms - client.desiredRooms;
      tradeoffs.push(`На ${roomsDiff(Math.abs(diff))} ${diff < 0 ? "меньше" : "больше"} (просил ${client.desiredRooms})`);
    }
  } else if (roomsApply && property.rooms != null && client.desiredRooms == null) unknowns.push("Клиент не назвал число комнат");
  if (client.desiredRooms != null && property.rooms != null && client.desiredRooms === property.rooms) points += w.rooms;

  if (client.desiredAreaMin != null) {
    const area = property.areaSqm != null ? Number(property.areaSqm) : null;
    if (area == null) unknowns.push("Площадь объекта не указана");
    else if (area < client.desiredAreaMin * (1 - policy.areaToleranceRatio)) return null;
    else if (area < client.desiredAreaMin) tradeoffs.push(`Площадь ${area} м², на ${Math.round(client.desiredAreaMin - area)} м² меньше желаемой`);
    else reasons.push(`Площадь ${area} м² (просил от ${client.desiredAreaMin})`);
  }

  const notes = (client.requirementsNotes ?? "").toLocaleLowerCase("ru").replace(/ё/g, "е");
  const notFirst = NOT_FIRST.test(notes);
  const notLast = NOT_LAST.test(notes);
  const floorApplies = propertyFieldShown(property.type ?? "APARTMENT", "floor");
  const floor = property.floor ?? null;
  const totalFloors = property.totalFloors ?? null;
  const floorText = floor != null ? `${floor}${totalFloors ? ` из ${totalFloors}` : ""}` : "";
  if (floorApplies && (client.desiredFloorMin != null || client.desiredFloorMax != null || notFirst || notLast)) {
    if (floor == null) unknowns.push("Этаж объекта не указан");
    else {
      // Этаж — жёстко (спецификация владельца 31.07.2026): «не первый» не округляется.
      if ((client.desiredFloorMin != null && floor < client.desiredFloorMin) ||
        (client.desiredFloorMax != null && floor > client.desiredFloorMax) || (notFirst && floor === 1) ||
        (notLast && totalFloors != null && floor === totalFloors)) return null;
      if (notLast && totalFloors == null) unknowns.push("Неизвестно, последний ли этаж");
      else reasons.push(`Этаж ${floorText} подходит`);
    }
  } else if (floorApplies && floor != null) ask.push(`Клиент не говорил про этаж (здесь ${floorText}) — спросите`);
  if (client.desiredTotalFloors != null) {
    if (totalFloors == null) unknowns.push("Этажность дома не указана");
    else if (totalFloors > client.desiredTotalFloors) return null;
    else reasons.push(`Дом не выше ${client.desiredTotalFloors} этажей`);
  }

  // Состояние, рынок, мебель, лифт, документы — только явные пожелания из заметок.
  const wishes = clientTextWishes(client.requirementsNotes ?? null);
  for (const wish of wishes) {
    const fact = factText(property, wish.key);
    if (fact == null) unknowns.push(`${wish.label}: нужно уточнить`);
    else if (fact === wish.wanted) {
      const value = wish.key === "newBuild" ? (fact ? "новое жильё" : "вторичное жильё")
        : wish.key === "renovated" ? (fact ? "готовый" : "требуется")
        : wish.key === "documents" ? (property.documents ?? "").trim() : (fact ? "есть" : "отсутствует");
      reasons.push(`${wish.label}: ${value}`);
    } else tradeoffs.push(`${wish.label}: не соответствует пожеланию`);
  }
  if (property.condition === "NEEDS_REPAIR" && !wishes.some(wish => wish.key === "renovated")) {
    ask.push("Объекту нужен ремонт, клиент про ремонт не говорил — спросите");
  }
  // Свободный текст может держать то, чего модель не знает (школа, вид из окна).
  if (client.requirementsNotes?.trim()) ask.push("Остальное из заметок клиента проверьте перед отправкой");

  if (!hasClientMatchingCriteria(client)) unknowns.splice(0, unknowns.length, "Сначала уточните пожелания покупателя");
  const tier = tradeoffs.length ? "alternative" : unknowns.length ? "needs_verification" : "exact";
  return { tier, reasons, tradeoffs, unknowns, ask, distanceM: place ? Math.round(place.distanceM) : null, points: Math.min(100, points) };
}

type Comparable = Pick<ClientPropertyMatch, "tier" | "tradeoffs" | "unknowns" | "reasons" | "points" | "distanceM">;

/** Порядок внутри списка: уровень → меньше уступок → меньше «не знаем» → больше совпавшего. */
export function compareMatches(a: Comparable, b: Comparable): number {
  return matchTierRank(a.tier) - matchTierRank(b.tier) ||
    a.tradeoffs.length - b.tradeoffs.length || a.unknowns.length - b.unknowns.length ||
    b.reasons.length - a.reasons.length || b.points - a.points ||
    (a.distanceM ?? Infinity) - (b.distanceM ?? Infinity);
}

export interface EvaluatedClientProperty {
  id: string;
  shortId: number;
  distanceM: number | null;
  points: number;
  match: ClientPropertyMatchEvidence;
}

/** Каталог под клиента: та же проверка пары плюс «мой ли это объект». */
export function evaluateClientProperty(
  client: MatchingBuyerCriteria, property: MatchingPropertyFacts & { shortId: number }, money: MoneyContext,
  policy: MatchPolicy, viewerId: string
): EvaluatedClientProperty | null {
  const found = matchClientProperty(client, property, money, policy);
  if (!found) return null;
  const { distanceM, points, ...evidence } = found;
  return { id: property.id, shortId: property.shortId, distanceM, points,
    match: { ...evidence, isMine: propertyOwnerAgentId(property) === viewerId, lastSentAt: null, sentCount: 0 } };
}

export function compareClientProperties(a: EvaluatedClientProperty, b: EvaluatedClientProperty): number {
  return compareMatches({ ...a.match, distanceM: a.distanceM, points: a.points }, { ...b.match, distanceM: b.distanceM, points: b.points }) ||
    Number(b.match.isMine) - Number(a.match.isMine) || b.shortId - a.shortId;
}
