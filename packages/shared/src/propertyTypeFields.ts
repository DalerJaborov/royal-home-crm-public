import { PROPERTY_DETAIL_KEYS, type PropertyDetailKey, type PropertyType } from "./enums.js";
import { PROPERTY_TYPE_LABELS } from "./labels.js";

/**
 * КАКИЕ ПОЛЯ ЕСТЬ У КАКОГО ТИПА ОБЪЕКТА — ОДНА ТАБЛИЦА (владелец 08.10.2026).
 *
 * Было: у дома мастер спрашивал «Вторичка / Новостройка» и «Этаж», у участка —
 * состояние ремонта и тринадцать характеристик здания (лифт, балкон, потолки), у
 * коммерции требовал «комнаты». Правило «что спрашивать» жило в пяти местах —
 * мастер, форма правки, проверка сервера, подписи, карточка — и каждое решало
 * по-своему (`type !== "LAND"` в одном, ничего в другом).
 *
 * Теперь все они спрашивают эту таблицу. Поля базы не удаляются: скрытое поле
 * просто не показывается, не требуется и не принимается сервером для этого типа.
 *
 * Практика Таджикистана, по которой составлена таблица:
 *   — Квартира: этаж и этажность дома, новостройка/вторичка/котлован — всё есть.
 *   — Дом (ҳавлӣ): своего «этажа» у дома нет, есть только этажность; это не
 *     «новостройка» и не «вторичка» — эти слова про квартиры в многоэтажках.
 *     Лифта в частном доме нет. Сотки — да.
 *   — Коммерция: этаж и этажность здания есть, бывает в новостройке. «Комнат»
 *     у свободной планировки нет — поле необязательно.
 *   — Участок: только сотки. Ни комнат, ни этажей, ни окон, ни состояния ремонта,
 *     ни характеристик здания.
 */
export type PropertyFieldRule = "required" | "optional" | "hidden";

/** Числовые поля, которые зависят от типа. Площадь м² у участка не спрашивается —
 *  считается из соток (1 сотка = 100 м²), колонка в базе обязательная. */
export const PROPERTY_TYPE_NUMBER_FIELDS = ["rooms", "areaSqm", "landAreaSotka", "floor", "totalFloors", "windowCount"] as const;
export type PropertyTypeNumberField = (typeof PROPERTY_TYPE_NUMBER_FIELDS)[number];

export interface PropertyTypeFields {
  rooms: PropertyFieldRule;
  areaSqm: PropertyFieldRule;
  landAreaSotka: PropertyFieldRule;
  floor: PropertyFieldRule;
  totalFloors: PropertyFieldRule;
  windowCount: PropertyFieldRule;
  /** «Вторичка / Новостройка» вместе со стадией стройки (marketType + stage). */
  market: boolean;
  /** Состояние ремонта (condition). Колонка в базе обязательная, поэтому у
   *  участка значение хранится, но нигде не спрашивается и не показывается. */
  condition: boolean;
  /** Какие из 13 характеристик (details) имеют смысл. */
  details: readonly PropertyDetailKey[];
  /** Подписи, которые у разных типов звучат по-разному. */
  labels: { rooms: string; totalFloors: string };
}

const ALL_DETAILS = PROPERTY_DETAIL_KEYS;

export const PROPERTY_TYPE_FIELDS: Record<PropertyType, PropertyTypeFields> = {
  APARTMENT: {
    rooms: "required",
    areaSqm: "required",
    landAreaSotka: "hidden",
    floor: "required",
    totalFloors: "required",
    windowCount: "required",
    market: true,
    condition: true,
    details: ALL_DETAILS,
    labels: { rooms: "Комнат", totalFloors: "Этажей в доме" },
  },
  HOUSE: {
    rooms: "required",
    areaSqm: "required",
    landAreaSotka: "optional",
    floor: "hidden",
    totalFloors: "required",
    windowCount: "required",
    market: false,
    condition: true,
    details: ALL_DETAILS.filter((k) => k !== "elevator"),
    labels: { rooms: "Комнат", totalFloors: "Этажей в доме" },
  },
  COMMERCIAL: {
    rooms: "optional",
    areaSqm: "required",
    landAreaSotka: "hidden",
    floor: "required",
    totalFloors: "required",
    windowCount: "required",
    market: true,
    condition: true,
    details: ALL_DETAILS,
    labels: { rooms: "Комнат (помещений)", totalFloors: "Этажей в здании" },
  },
  LAND: {
    rooms: "hidden",
    areaSqm: "hidden",
    landAreaSotka: "required",
    floor: "hidden",
    totalFloors: "hidden",
    windowCount: "hidden",
    market: false,
    condition: false,
    details: [],
    labels: { rooms: "Комнат", totalFloors: "Этажей" },
  },
};

/** Тип неизвестен (старая строка, мусор) — ведём себя как раньше: всё показываем. */
function rulesOf(type: PropertyType | string | null | undefined): PropertyTypeFields {
  return PROPERTY_TYPE_FIELDS[type as PropertyType] ?? PROPERTY_TYPE_FIELDS.APARTMENT;
}

export function propertyTypeFields(type: PropertyType | string | null | undefined): PropertyTypeFields {
  return rulesOf(type);
}

/** Поле показывается (и принимается) у этого типа. */
export function propertyFieldShown(type: PropertyType | string | null | undefined, field: PropertyTypeNumberField): boolean {
  return rulesOf(type)[field] !== "hidden";
}

export function propertyFieldRequired(type: PropertyType | string | null | undefined, field: PropertyTypeNumberField): boolean {
  return rulesOf(type)[field] === "required";
}

/** Характеристика имеет смысл у этого типа. */
export function propertyDetailShown(type: PropertyType | string | null | undefined, key: string): boolean {
  return (rulesOf(type).details as readonly string[]).includes(key);
}

/** «Вторичка / Новостройка» и стадия стройки — у этого типа есть. */
export function propertyHasMarket(type: PropertyType | string | null | undefined): boolean {
  return rulesOf(type).market;
}

/** Состояние ремонта — у этого типа есть. */
export function propertyHasCondition(type: PropertyType | string | null | undefined): boolean {
  return rulesOf(type).condition;
}

/** Оставляет в характеристиках только те, что имеют смысл у типа. */
export function filterDetailsForType<T extends Record<string, unknown>>(
  type: PropertyType | string | null | undefined,
  details: T | null | undefined
): Partial<T> {
  if (!details || typeof details !== "object") return {};
  const allowed = rulesOf(type).details as readonly string[];
  return Object.fromEntries(Object.entries(details).filter(([k]) => allowed.includes(k))) as Partial<T>;
}

/**
 * Поля, которых у типа нет, — какими они уходят в базу. Для создания это
 * «не присылать» (undefined), для правки со сменой типа — «очистить» (null).
 * areaSqm сюда не входит: колонка обязательная, у участка она считается из соток.
 */
export function hiddenPropertyFields(type: PropertyType | string | null | undefined): Array<
  "rooms" | "landAreaSotka" | "floor" | "totalFloors" | "windowCount" | "marketType" | "stage"
> {
  const r = rulesOf(type);
  const out: Array<"rooms" | "landAreaSotka" | "floor" | "totalFloors" | "windowCount" | "marketType" | "stage"> = [];
  for (const f of ["rooms", "landAreaSotka", "floor", "totalFloors", "windowCount"] as const) {
    if (r[f] === "hidden") out.push(f);
  }
  if (!r.market) out.push("marketType", "stage");
  return out;
}

/**
 * Убирает из тела запроса поля, которых у типа нет (создание и правка).
 * Неизменяемо: возвращает копию. Характеристики фильтруются по типу.
 */
export function stripPropertyFieldsForType<T extends Record<string, unknown>>(
  type: PropertyType | string | null | undefined,
  data: T
): T {
  const out: Record<string, unknown> = { ...data };
  for (const f of hiddenPropertyFields(type)) delete out[f];
  if (out.details && typeof out.details === "object") out.details = filterDetailsForType(type, out.details as Record<string, unknown>);
  return out as T;
}

/**
 * ПРАВКА ОБЪЕКТА (PATCH) С УЧЁТОМ ТИПА. Возвращает новое тело запроса:
 *   — поля, которых у итогового типа нет, из запроса убраны;
 *   — если тип МЕНЯЕТСЯ, такие поля, заполненные в карточке, очищаются (null),
 *     а характеристики, не подходящие новому типу, отбрасываются.
 * Без смены типа уже сохранённые значения не трогаются: старая карточка дома с
 * этажом не меняется от правки цены, но новый этаж ей больше не записать.
 */
export function normalizePropertyPatchForType<T extends Record<string, unknown>>(
  patch: T,
  existing: { type: string; details?: unknown } & Partial<Record<string, unknown>>
): T {
  const targetType = (typeof patch.type === "string" ? patch.type : existing.type) as string;
  const out = stripPropertyFieldsForType(targetType, patch) as Record<string, unknown>;
  if (typeof patch.type === "string" && patch.type !== existing.type) {
    for (const f of hiddenPropertyFields(targetType)) {
      if (existing[f] !== null && existing[f] !== undefined) out[f] = null;
    }
    if (out.details === undefined && existing.details && typeof existing.details === "object") {
      const before = existing.details as Record<string, unknown>;
      const after = filterDetailsForType(targetType, before);
      if (Object.keys(after).length !== Object.keys(before).length) out.details = after;
    }
  }
  return out as T;
}

/**
 * ФАКТЫ ОБЪЕКТА ДЛЯ ПОКАЗА ЛЮДЯМ (карточка, подписи к роликам, бот, обложки,
 * реклама, подбор). Поля, которых у типа нет, возвращаются пустыми (null), а
 * характеристики — только подходящие типу. Нужно потому, что старые карточки
 * домов заведены с «этажом» и «новостройкой» (раньше сервер требовал этаж у
 * дома), и базу мы не чистим — просто не показываем.
 *
 * Состояние (condition) не трогается: колонка обязательная, и пустое значение
 * там, где его не ждут, уронило бы подписи. Где его нужно спрятать у участка —
 * propertyHasCondition.
 */
export function visiblePropertyFacts<T extends { type: string }>(p: T): T {
  const out: Record<string, unknown> = { ...p };
  for (const f of hiddenPropertyFields(p.type)) {
    if (f in out) out[f] = null;
  }
  if ("details" in out && out.details && typeof out.details === "object" && !Array.isArray(out.details)) {
    out.details = filterDetailsForType(p.type, out.details as Record<string, unknown>);
  }
  return out as T;
}

function floorsWord(n: number): string {
  const m10 = n % 10;
  const m100 = n % 100;
  if (m10 === 1 && m100 !== 11) return "этаж";
  if (m10 >= 2 && m10 <= 4 && (m100 < 12 || m100 > 14)) return "этажа";
  return "этажей";
}

/**
 * Этаж словами по типу: у квартиры и коммерции «5 из 9», у дома — «2 этажа»
 * (своего этажа у дома нет), у участка — null. `label` — подпись плитки.
 */
export function propertyFloorsLabel(p: {
  type: string;
  floor?: number | null;
  totalFloors?: number | null;
}): { label: string; value: string } | null {
  if (propertyFieldShown(p.type, "floor")) {
    if (p.floor == null) return null;
    return { label: "Этаж", value: p.totalFloors ? `${p.floor} из ${p.totalFloors}` : String(p.floor) };
  }
  if (propertyFieldShown(p.type, "totalFloors")) {
    if (!p.totalFloors) return null;
    return { label: "Этажность", value: `${p.totalFloors} ${floorsWord(p.totalFloors)}` };
  }
  return null;
}

/**
 * Короткое имя объекта для списков бота: «2-комн» у квартиры, «Дом, 4-комн» у
 * дома, «Коммерческое» и «Участок» без комнат. Раньше любой объект с комнатами
 * назывался «N-комн», и дом читался клиенту как квартира.
 */
export function propertyHeadline(p: { type: string; rooms?: number | null }): string {
  const label = PROPERTY_TYPE_LABELS[p.type as PropertyType] ?? p.type;
  const rooms = propertyFieldShown(p.type, "rooms") && p.rooms ? p.rooms : null;
  if (p.type === "APARTMENT") return rooms ? `${rooms}-комн` : label;
  if (p.type === "HOUSE") return rooms ? `${label}, ${rooms}-комн` : label;
  return label;
}


/** Типы, у которых поля нет (для фильтров базы: «этаж не важен у дома»). */
export function propertyTypesWithoutField(field: PropertyTypeNumberField): PropertyType[] {
  return (Object.keys(PROPERTY_TYPE_FIELDS) as PropertyType[]).filter((t) => PROPERTY_TYPE_FIELDS[t][field] === "hidden");
}
