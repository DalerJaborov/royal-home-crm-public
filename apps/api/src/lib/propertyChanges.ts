import {
  MARKET_TYPE_LABELS,
  PROPERTY_CONDITION_LABELS,
  PROPERTY_STAGE_LABELS,
  PROPERTY_TYPE_LABELS,
} from "@royal-home/shared";

/**
 * ЧТО ИМЕННО ПОМЕНЯЛОСЬ В ОБЪЕКТЕ ОДНИМ PATCH (владелец 23.09.2026: «все
 * правки в хронологию»).
 *
 * Форма карточки шлёт объект ЦЕЛИКОМ, поэтому «поле пришло в запросе» ещё не
 * значит «поле поменяли». Здесь сравниваются значения, приведённые к одному
 * виду: Decimal из базы и число из формы, дата и строка ISO, массивы и JSON.
 * Этим же списком пользуются замок правки на монтаже (правили ли хоть что-то,
 * кроме статуса) и хронология объекта (что было и что стало).
 */

/** Поля, у которых своя запись в хронологии (PROPERTY_STATUS_CHANGED и т.п.) —
 *  в общий список «поля изменены» не дублируются. */
const OWN_AUDIT_FIELDS = new Set(["status", "assignedAgentId", "intakeAgentId"]);

/** Служебные поля, которые человек в форме не правит, — в хронологию не пишутся. */
const SILENT_FIELDS = new Set(["metaTitle", "metaDescription", "seoDesc", "listingAcceptedAt"]);

const FIELD_LABELS: Record<string, string> = {
  title: "Заголовок",
  type: "Вид",
  rooms: "Комнат",
  areaSqm: "Площадь, м²",
  landAreaSotka: "Участок, соток",
  floor: "Этаж",
  totalFloors: "Этажей в доме",
  windowCount: "Окон",
  price: "Цена",
  currency: "Валюта",
  soldPrice: "Цена продажи",
  districtId: "Район",
  address: "Адрес",
  condition: "Состояние",
  stage: "Стадия",
  marketType: "Рынок",
  amenities: "Удобства",
  description: "Описание",
  ownerContact: "Контакт владельца",
  clientId: "Продавец",
  instagramUrl: "Ссылка на видео-обзор",
  reelsCaption: "Подпись к ролику",
  documents: "Документы",
  lat: "Точка на карте",
  lng: "Точка на карте",
  urgent: "Срочно",
  details: "Характеристики",
};

function normalize(value: unknown): string | null {
  if (value === undefined || value === null || value === "") return null;
  if (value instanceof Date) return value.toISOString();
  if (typeof value === "object") {
    // Decimal из Prisma приводится к числу через toString.
    if ("toFixed" in (value as object) && typeof (value as { toString: () => string }).toString === "function") {
      return String(Number((value as { toString: () => string }).toString()));
    }
    return JSON.stringify(value);
  }
  if (typeof value === "number") return String(value);
  if (typeof value === "string") {
    // Дата из формы приходит строкой — сравниваем с датой из базы в одном виде.
    if (/^\d{4}-\d{2}-\d{2}T/.test(value)) {
      const t = Date.parse(value);
      if (!Number.isNaN(t)) return new Date(t).toISOString();
    }
    const n = Number(value);
    if (value.trim() !== "" && Number.isFinite(n) && /^-?\d+(\.\d+)?$/.test(value.trim())) return String(n);
    return value.trim();
  }
  return String(value);
}

/** Поля из запроса, значение которых действительно отличается от сохранённого. */
export function changedPropertyFields(data: Record<string, unknown>, existing: Record<string, unknown>): string[] {
  const out: string[] = [];
  for (const [key, value] of Object.entries(data)) {
    if (value === undefined) continue;
    if (normalize(value) !== normalize(existing[key])) out.push(key);
  }
  return out;
}

function display(field: string, value: unknown, districtNames: Map<string, string>): string {
  if (value === undefined || value === null || value === "") return "не указано";
  if (typeof value === "boolean") return value ? "да" : "нет";
  const s = normalize(value) ?? "";
  if (field === "type") return PROPERTY_TYPE_LABELS[s as keyof typeof PROPERTY_TYPE_LABELS] ?? s;
  if (field === "condition") return PROPERTY_CONDITION_LABELS[s as keyof typeof PROPERTY_CONDITION_LABELS] ?? s;
  if (field === "stage") return PROPERTY_STAGE_LABELS[s as keyof typeof PROPERTY_STAGE_LABELS] ?? s;
  if (field === "marketType") return MARKET_TYPE_LABELS[s as keyof typeof MARKET_TYPE_LABELS] ?? s;
  if (field === "districtId") return districtNames.get(s) ?? "другой район";
  if (field === "documents" || field === "details" || field === "amenities") return "изменены";
  return s.length > 80 ? `${s.slice(0, 77)}…` : s;
}

export type PropertyFieldChange = { field: string; label: string; was: string; becomes: string };

/** Чем подменяются номер «было» и «стало» в хронологии для того, кому контакт закрыт. */
export const OWNER_CONTACT_HIDDEN_TEXT = "скрыто";

/**
 * НОМЕР СОБСТВЕННИКА В ХРОНОЛОГИИ (ночная проверка 24.09.2026). describePropertyChanges
 * пишет в журнал «Контакт владельца: +992… → +992…» открытым текстом, и запись
 * читал каждый, кому открыта история объекта, — в том числе монтажёр
 * (properties.editForeign без properties.viewOwners), у которого на той же
 * карточке сам номер стоит как «скрыто». Достаточно было сохранить чужую
 * карточку: форма шлёт закрытый ownerContact пустым, и «было» уносило настоящий
 * номер. Само значение в журнале остаётся — руководителю нужна честная история;
 * прячется оно при ОТДАЧЕ (routes/auditLog.ts), потому что старые записи в базе
 * номера уже содержат. Строка `field` в записи есть с первого дня хронологии,
 * по ней и ищем.
 */
export function hideOwnerContactInChanges(meta: unknown): unknown {
  if (!meta || typeof meta !== "object" || Array.isArray(meta)) return meta;
  const changes = (meta as { changes?: unknown }).changes;
  if (!Array.isArray(changes)) return meta;
  const isOwnerContact = (c: unknown) =>
    !!c && typeof c === "object" && (c as { field?: unknown }).field === "ownerContact";
  if (!changes.some(isOwnerContact)) return meta;
  return {
    ...meta,
    changes: changes.map((c) =>
      isOwnerContact(c) ? { ...(c as object), was: OWNER_CONTACT_HIDDEN_TEXT, becomes: OWNER_CONTACT_HIDDEN_TEXT } : c
    ),
  };
}

/**
 * Строки для хронологии: «Площадь, м²: 60 → 65». Готовый текст пишется в журнал
 * сразу, чтобы карточка истории не держала второй словарь полей.
 * Широта и долгота сводятся в одну строку «Точка на карте».
 */
export function describePropertyChanges(
  fields: string[],
  data: Record<string, unknown>,
  existing: Record<string, unknown>,
  districtNames: Map<string, string> = new Map()
): PropertyFieldChange[] {
  const out: PropertyFieldChange[] = [];
  let pointDone = false;
  for (const field of fields) {
    if (OWN_AUDIT_FIELDS.has(field) || SILENT_FIELDS.has(field)) continue;
    if (field === "lat" || field === "lng") {
      if (pointDone) continue;
      pointDone = true;
      out.push({ field: "point", label: "Точка на карте", was: "прежняя", becomes: "передвинута" });
      continue;
    }
    out.push({
      field,
      label: FIELD_LABELS[field] ?? field,
      was: display(field, existing[field], districtNames),
      becomes: display(field, data[field], districtNames),
    });
  }
  return out;
}
