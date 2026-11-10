/**
 * ПОДБОР 2.0 — ОДНА МОДЕЛЬ «КЛИЕНТ ↔ ОБЪЕКТ» В ОБЕ СТОРОНЫ (владелец 10.11.2026:
 * «подходит клиентам — надо написать, что именно подходит… подбор сырой»).
 *
 * До этой правки отношение описывали ТРИ копии: «кому подходит объект» и счётчик
 * спроса (routes/matching.ts, база 40 + «горячему» 10, причины только район/
 * комнаты/бюджет), «какие объекты подходят клиенту» (эта функция) и автопуш
 * новым объектам (lib/propertyMatchFilter.ts). Расходились они и в фильтре:
 * ориентир без района у первой и третьей не ограничивал ничего.
 *
 * Теперь ОДНО правило в двух скоростях:
 *  - `clientPropertyEligible` — быстрый путь «да/нет» без единой строки: счётчик
 *    «ждут N», отчёты, автопуш. Пожелания клиента разбираются ОДИН раз на клиента
 *    (кэш на объект клиента, см. prepareBuyer), цена объекта в сомони — один раз
 *    на объект;
 *  - `matchClientProperty` — тот же ответ плюс уровень, причины, уступки, «не
 *    знаем» и «спросить», на языке собеседника (словарь MATCH_TEXT в shared).
 *    Зовётся только для прошедших быстрый путь.
 * `points` — шкала порога «свой объект — свой клиент» из Настроек, на экран не
 * попадает. Сторож — tests/matching-one-model.test.ts.
 */
import {
  MATCH_SCORE_WEIGHTS, MATCH_TEXT, matchTierRank, propertyFieldShown,
  type ClientPropertyMatchEvidence, type MatchEvidence, type MatchLang, type MatchWishKey,
} from "@royal-home/shared";
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

/**
 * Признаки объекта. Поля, которые решают «подходит/нет», ОБЯЗАТЕЛЬНЫ в типе
 * (null — «не знаем»): выборка, забывшая `type` или точку, не скомпилируется, а не
 * даст молча «никто не ищет» (problemReport, ревью 10.11.2026). Остальные —
 * только для причин: без них пожелание станет «уточнить», а не «нет».
 */
export interface MatchingPropertyFacts extends PropertyOwnerFields {
  id: string;
  type: string | null;
  districtId: string | null;
  price: unknown;
  currency: string | null;
  rooms: number | null;
  areaSqm: unknown;
  floor: number | null;
  totalFloors: number | null;
  lat: unknown;
  lng: unknown;
  condition?: string | null;
  marketType?: string | null;
  amenities?: string[] | null;
  details?: unknown;
  description?: string | null;
  /** Документы объекта (Договор, Техпаспорт…) — только для сотрудников. */
  documents?: string | null;
}

interface TextWish { key: MatchWishKey; wanted: boolean; label: string }

/** Deliberately narrow: only explicit wishes; negation is parsed before positive words. */
export function clientTextWishes(notes: string | null): TextWish[] {
  const text = (notes ?? "").toLocaleLowerCase("ru").replace(/ё/g, "е");
  const result: TextWish[] = [];
  if (!text) return result;
  const featureWords: Record<MatchWishKey, string> = {
    renovated: "ремонт", furniture: "мебел", parking: "парковк", lift: "лифт", balcony: "балкон", newBuild: "новостройк",
    documents: "документ",
  };
  const label = (key: MatchWishKey) => MATCH_TEXT.ru.wish[key];
  const optionalWords = "(?:не\\s+(?:нуж[а-я]*|важ[а-я]*|обязател[а-я]*|треб[а-я]*)|неваж[а-я]*|необязател[а-я]*)";
  const add = (key: MatchWishKey, positive: RegExp, negative: RegExp | null) => {
    const noun = `${featureWords[key]}[а-я]*`;
    // "Не нужен лифт" means no requirement, not a request for a building without one.
    // On ambiguous/contradictory notes prefer no automated claim for this feature.
    if (new RegExp(`(?:${noun}\\s+${optionalWords}|${optionalWords}\\s+${noun})`).test(text)) return;
    if (negative?.test(text)) result.push({ key, label: label(key), wanted: false });
    else if (positive.test(text)) result.push({ key, label: label(key), wanted: true });
  };
  add("renovated", /с\s+ремонт|готов[а-яa-z]*\s+к\s+проживан/, /без\s+ремонт|не\s+с\s+ремонт|под\s+ремонт|нуж[а-яa-z]*\s+ремонт|коробк/);
  add("furniture", /с\s+мебель|меблирован/, /без\s+мебел/);
  add("parking", /(?:нуж[а-яa-z]*|важ[а-яa-z]*|с)\s+парковк|парковка\s+(?:обязательна|нужна)/, /без\s+парковк/);
  add("lift", /(?:нуж[а-яa-z]*|важ[а-яa-z]*|с)\s+лифт|лифт\s+(?:обязателен|нужен)/, /без\s+лифт/);
  add("balcony", /с\s+балкон|балкон\s+(?:обязателен|нужен)/, /без\s+балкон/);
  add("newBuild", /новостройк/, /не\s+новостройк|вторичк|вторичн[а-яa-z]*\s+рын/);
  // Документы: «с документами», «техпаспорт», «кадастр», «под ипотеку». Отказа от
  // документов как пожелания не бывает — только просьба, чтобы они были.
  add("documents", /(?:с|нуж[а-я]*|важ[а-я]*)\s+документ|документ[а-я]*\s+(?:нуж|обязател|в\s+порядке|готов)|техпаспорт|кадастр|ипотек/, null);
  return result;
}

function detail(property: MatchingPropertyFacts, key: string): string {
  const details = property.details;
  if (!details || typeof details !== "object" || Array.isArray(details)) return "";
  const value = (details as Record<string, unknown>)[key];
  return typeof value === "string" ? value.toLocaleLowerCase("ru").trim() : "";
}

function factText(property: MatchingPropertyFacts, key: MatchWishKey): boolean | null {
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
  const patterns: Partial<Record<MatchWishKey, [RegExp, RegExp]>> = {
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

/**
 * «Не первый / не последний этаж» из заметок. Ловим, как раньше, любое «не / кроме
 * первого» и «последнего» (в том числе «этаж не первый», «не первый, не последний»,
 * «кроме первого и последнего», «не первый и последний этаж»), но НЕ когда за
 * словом идёт другое существительное: «не первый раз покупаю», «не первую
 * квартиру», «не последние деньги» — не про этаж, а правило исключает объект и
 * отнимает покупателя у счётчика спроса.
 */
const NOT_ABOUT_FLOOR = "(?![а-я]*\\s+(?:раз|год|день|месяц|недел|сделк|покупк|квартир|дом|объект|вариант|деньг|цен|машин|ребен))";
const NOT_FIRST = new RegExp(`(?:^|[^а-я])(?:не|кроме)\\s+(?:на\\s+)?перв${NOT_ABOUT_FLOOR}`);
const NOT_LAST = new RegExp(
  `(?:^|[^а-я])(?:не|кроме)\\s+(?:на\\s+)?последн${NOT_ABOUT_FLOOR}` +
  `|(?:^|[^а-я])(?:не|кроме)\\s+(?:на\\s+)?перв[а-я]*\\s*(?:,|и)\\s*(?:не\\s+)?последн${NOT_ABOUT_FLOOR}`
);
export function notesFloorWishes(notes: string | null | undefined): { notFirst: boolean; notLast: boolean } {
  const text = (notes ?? "").toLocaleLowerCase("ru").replace(/ё/g, "е");
  if (!text) return { notFirst: false, notLast: false };
  return { notFirst: NOT_FIRST.test(text), notLast: NOT_LAST.test(text) };
}

/** Жильё — где «просил N комнат» имеет смысл без названного типа. */
const RESIDENTIAL_TYPES = new Set(["APARTMENT", "HOUSE"]);

/** Разобранный один раз запрос клиента: суммы в сомони, пожелания из заметок. */
interface PreparedBuyer {
  money: MoneyContext;
  policy: MatchPolicy;
  places: DesiredPlacePoint[];
  minTjs: number | null;
  maxTjs: number | null;
  windowMin: number | null;
  windowMax: number | null;
  notFirst: boolean;
  notLast: boolean;
  wishes: TextWish[] | null;
}
/** Разобранный один раз объект: цена в сомони, какие поля есть у типа. */
interface PreparedProperty {
  money: MoneyContext;
  priceTjs: number;
  area: number | null;
  lat: number | null;
  lng: number | null;
  roomsApply: boolean;
  floorApplies: boolean;
}

/**
 * КЭШ НА ЗАПРОС: ключ — сам объект клиента/объекта из выборки. Счётчик спроса
 * сверяет тысячу клиентов с каждым объектом страницы, и разбор заметок
 * регулярками на каждую пару был основной ценой (ревью 10.11: 20–50 мкс на пару,
 * отчёты по 10–25 с). Объект из выборки не меняется, пока живёт запрос; запись
 * сверяется с курсом и политикой, на которых её посчитали.
 */
const buyerCache = new WeakMap<object, PreparedBuyer>();
const propertyCache = new WeakMap<object, PreparedProperty>();

function prepareBuyer(client: MatchingBuyerCriteria, money: MoneyContext, policy: MatchPolicy): PreparedBuyer {
  const hit = buyerCache.get(client);
  if (hit && hit.money === money && hit.policy === policy) return hit;
  const minTjs = client.budgetMin != null ? toTjs(client.budgetMin, client.currency, money) : null;
  const maxTjs = client.budgetMax != null ? toTjs(client.budgetMax, client.currency, money) : null;
  const window = budgetWindowTjs(minTjs, maxTjs, policy);
  const floors = notesFloorWishes(client.requirementsNotes);
  const prepared: PreparedBuyer = { money, policy, places: client.desiredPlaces ?? [], minTjs, maxTjs,
    windowMin: window.min, windowMax: window.max, notFirst: floors.notFirst, notLast: floors.notLast, wishes: null };
  buyerCache.set(client, prepared);
  return prepared;
}
function buyerWishes(client: MatchingBuyerCriteria, prepared: PreparedBuyer): TextWish[] {
  return (prepared.wishes ??= clientTextWishes(client.requirementsNotes ?? null));
}

function prepareProperty(property: MatchingPropertyFacts, money: MoneyContext): PreparedProperty {
  const hit = propertyCache.get(property);
  if (hit && hit.money === money) return hit;
  const type = property.type ?? "APARTMENT";
  const prepared: PreparedProperty = {
    money,
    priceTjs: toTjs(property.price, property.currency, money),
    area: property.areaSqm != null ? Number(property.areaSqm) : null,
    lat: property.lat != null && property.lng != null ? Number(property.lat) : null,
    lng: property.lat != null && property.lng != null ? Number(property.lng) : null,
    roomsApply: propertyFieldShown(type, "rooms"),
    floorApplies: propertyFieldShown(type, "floor"),
  };
  propertyCache.set(property, prepared);
  return prepared;
}

/** Проверка пары без единой строки текста. Тот же ответ, что `matchClientProperty(...) !== null`. */
function eligible(client: MatchingBuyerCriteria, property: MatchingPropertyFacts, b: PreparedBuyer, p: PreparedProperty): boolean {
  const desiredType = client.desiredType;
  // Тип: не выбран у клиента или у объекта — не участвует (propertyTypeRule.ts).
  if (desiredType && property.type && property.type !== desiredType) return false;
  // Просил комнаты, тип не назвал — значит ищет жильё: участок и коммерцию не
  // предлагаем (кадр подбора 10.11: участок стоял «точно подходит» у искавшей 3-комн).
  if (client.desiredRooms != null && client.desiredRooms > 0 && !desiredType && property.type && !RESIDENTIAL_TYPES.has(property.type)) return false;
  // Район ИЛИ радиус ориентира (D3). Объект без точки проходит только по району:
  // близость, которую нельзя проверить, не считается совпадением.
  if (client.desiredDistrictId || b.places.length) {
    const districtMatches = client.desiredDistrictId != null && property.districtId === client.desiredDistrictId;
    if (!districtMatches) {
      if (p.lat == null || !b.places.length) return false;
      if (!nearestDesiredPlace(p.lat, p.lng!, b.places)?.withinRadius) return false;
    }
  }
  if ((b.windowMin != null && p.priceTjs < b.windowMin) || (b.windowMax != null && p.priceTjs > b.windowMax)) return false;
  if (client.desiredRooms != null && p.roomsApply && property.rooms != null &&
    Math.abs(property.rooms - client.desiredRooms) > b.policy.roomsTolerance) return false;
  if (client.desiredAreaMin != null && p.area != null && p.area < client.desiredAreaMin * (1 - b.policy.areaToleranceRatio)) return false;
  const floor = property.floor;
  // Этаж — жёстко (спецификация владельца 31.07.2026): «не первый» не округляется.
  if (p.floorApplies && floor != null && (
    (client.desiredFloorMin != null && floor < client.desiredFloorMin) ||
    (client.desiredFloorMax != null && floor > client.desiredFloorMax) ||
    (b.notFirst && floor === 1) || (b.notLast && property.totalFloors != null && floor === property.totalFloors))) return false;
  if (client.desiredTotalFloors != null && property.totalFloors != null && property.totalFloors > client.desiredTotalFloors) return false;
  return true;
}

/** БЫСТРЫЙ ПУТЬ «ДА/НЕТ»: счётчик спроса, отчёты, автопуш. Текстов не строит. */
export function clientPropertyEligible(
  client: MatchingBuyerCriteria, property: MatchingPropertyFacts, money: MoneyContext, policy: MatchPolicy
): boolean {
  return eligible(client, property, prepareBuyer(client, money, policy), prepareProperty(property, money));
}

/** Пара прошла фильтр: уровень, причины и служебные числа для сортировки и порога. */
export interface ClientPropertyMatch extends MatchEvidence {
  /** Метры до ближайшего ориентира клиента; null — нет точки или ориентиров. */
  distanceM: number | null;
  /** Шкала порога «свой объект — свой клиент» (MATCH_SCORE_WEIGHTS), не процент и не на экран. */
  points: number;
}

/**
 * ОДНА ПРОВЕРКА ПАРЫ С ОБЪЯСНЕНИЕМ. null — объект клиенту не подходит (тот же
 * ответ, что у быстрого пути). Иначе — уровень и причины на языке `lang`.
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
  client: MatchingBuyerCriteria, property: MatchingPropertyFacts, money: MoneyContext, policy: MatchPolicy,
  lang: MatchLang = "ru"
): ClientPropertyMatch | null {
  const b = prepareBuyer(client, money, policy);
  const p = prepareProperty(property, money);
  if (!eligible(client, property, b, p)) return null;
  const t = MATCH_TEXT[lang];
  const reasons: string[] = [];
  const tradeoffs: string[] = [];
  const unknowns: string[] = [];
  const ask: string[] = [];
  const w = MATCH_SCORE_WEIGHTS;
  let points: number = w.base;

  if (client.desiredType && property.type) reasons.push(t.typeOk);

  const place = p.lat != null && b.places.length ? nearestDesiredPlace(p.lat, p.lng!, b.places) : null;
  if (client.desiredDistrictId || b.places.length) {
    if (client.desiredDistrictId != null && property.districtId === client.desiredDistrictId) { reasons.push(t.district); points += w.district; }
    if (place?.withinRadius) {
      const distance = formatDistance(place.distanceM);
      reasons.push(place.label ? t.nearPlace(place.label, distance) : t.toPlace(distance));
      points += w.distance;
    } else if (b.places.length && place == null) unknowns.push(t.placeUnknown);
  } else unknowns.push(t.noPlace);

  // Бюджет — в сомони по курсу (lib/money.ts), окно допуска — общей формулой.
  const price = p.priceTjs;
  const { minTjs: min, maxTjs: max } = b;
  if (min != null || max != null) {
    if (max != null && price > max) tradeoffs.push(t.overBudget(Math.max(1, Math.round(((price - max) / max) * 100)), price - max));
    else if (min != null && price < min) tradeoffs.push(t.underBudget(Math.max(1, Math.round(((min - price) / min) * 100))));
    else reasons.push(t.inBudget);
    // Шкала порога — как до 10.11.2026: «в бюджете» только при названном потолке.
    if (max != null && price <= max && (min == null || price >= min)) points += w.budget;
  } else unknowns.push(t.noBudget);

  if (client.desiredRooms != null && p.roomsApply) {
    if (property.rooms == null) unknowns.push(t.roomsUnknown);
    else if (property.rooms === client.desiredRooms) reasons.push(t.roomsOk(property.rooms));
    else tradeoffs.push(t.roomsDiff(property.rooms - client.desiredRooms, client.desiredRooms));
  } else if (p.roomsApply && property.rooms != null && client.desiredRooms == null) unknowns.push(t.noRooms);
  if (client.desiredRooms != null && property.rooms != null && client.desiredRooms === property.rooms) points += w.rooms;

  if (client.desiredAreaMin != null) {
    if (p.area == null) unknowns.push(t.areaUnknown);
    else if (p.area < client.desiredAreaMin) tradeoffs.push(t.areaLess(p.area, Math.round(client.desiredAreaMin - p.area)));
    else reasons.push(t.areaOk(p.area, client.desiredAreaMin));
  }

  const floor = property.floor;
  const totalFloors = property.totalFloors;
  const floorText = floor != null ? t.floorOf(floor, totalFloors) : "";
  if (p.floorApplies && (client.desiredFloorMin != null || client.desiredFloorMax != null || b.notFirst || b.notLast)) {
    if (floor == null) unknowns.push(t.floorUnknown);
    else if (b.notLast && totalFloors == null) unknowns.push(t.lastUnknown);
    else reasons.push(t.floorOk(floorText));
  } else if (p.floorApplies && floor != null) ask.push(t.askFloor(floorText));
  if (client.desiredTotalFloors != null) {
    if (totalFloors == null) unknowns.push(t.floorsUnknown);
    else reasons.push(t.floorsOk(client.desiredTotalFloors));
  }

  // Состояние, рынок, мебель, лифт, документы — только явные пожелания из заметок.
  const wishes = buyerWishes(client, b);
  for (const wish of wishes) {
    const label = t.wish[wish.key];
    const fact = factText(property, wish.key);
    if (fact == null) unknowns.push(t.wishUnknown(label));
    else if (fact === wish.wanted) {
      const value = wish.key === "newBuild" ? (fact ? t.wishValue.newBuild : t.wishValue.secondary)
        : wish.key === "renovated" ? (fact ? t.wishValue.ready : t.wishValue.needsRepair)
        : wish.key === "documents" ? (property.documents ?? "").trim() : (fact ? t.wishValue.yes : t.wishValue.no);
      reasons.push(`${label}: ${value}`);
    } else tradeoffs.push(t.wishMismatch(label));
  }
  if (property.condition === "NEEDS_REPAIR" && !wishes.some(wish => wish.key === "renovated")) ask.push(t.askRepair);
  // Свободный текст может держать то, чего модель не знает (школа, вид из окна).
  if (client.requirementsNotes?.trim()) ask.push(t.askNotes);

  if (!hasClientMatchingCriteria(client)) unknowns.splice(0, unknowns.length, t.noCriteria);
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
