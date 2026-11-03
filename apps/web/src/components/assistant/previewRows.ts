import type { AssistantActionPreview } from "@royal-home/shared";

/**
 * «БЫЛО → СТАНЕТ» ДЛЯ ЧЕЛОВЕКА (П4а). Превью собирают инструменты помощника на
 * сервере: часть ключей уже человеческие («Цена», «Время»), часть — машинные
 * имена полей (`agent`, `clientName`, поля карточки объекта в заявке на правку).
 * Машинные переводятся словарём, незнакомые выводятся как есть — новое поле
 * сервера не должно пропасть с карточки только потому, что словарь отстал.
 *
 * Значения — данные из базы: на выходе ВСЕГДА строка, которую разметка кладёт
 * текстом (React экранирует), никакого HTML.
 */
export const PREVIEW_FIELD_LABELS: Readonly<Record<string, string>> = {
  client: "Клиент",
  clientName: "Имя клиента",
  agent: "Агент",
  agentName: "Агент",
  accepted: "Принят агентом",
  property: "Объект",
  price: "Цена",
  currency: "Валюта",
  status: "Статус",
  title: "Название",
  address: "Адрес",
  district: "Район",
  districtName: "Район",
  rooms: "Комнат",
  areaSqm: "Площадь, м²",
  floor: "Этаж",
  totalFloors: "Этажей в доме",
  renovation: "Ремонт",
  description: "Описание",
  at: "Время",
  newAt: "Новое время",
  date: "Дата",
  reason: "Причина",
  comment: "Комментарий",
  note: "Заметка",
  text: "Текст",
  channels: "Каналы",
  removeFromSocial: "Снять из соцсетей",
};

/** Служебные ключи — ссылка и идентификаторы: человеку в «было/станет» не нужны. */
const HIDDEN_KEY = (key: string) => key === "href" || key === "id" || /Id$/.test(key);

export function fieldLabel(key: string): string {
  return PREVIEW_FIELD_LABELS[key] ?? key;
}

/** Значение превью в одну строку текста. */
export function formatPreviewValue(value: unknown): string {
  if (value === null || value === undefined || value === "") return "—";
  if (typeof value === "string") return value;
  if (typeof value === "number") return Number.isFinite(value) ? value.toLocaleString("ru-RU") : "—";
  if (typeof value === "boolean") return value ? "да" : "нет";
  if (Array.isArray(value)) {
    const parts = value.map(formatPreviewValue).filter((part) => part !== "—");
    return parts.length > 0 ? parts.join(", ") : "—";
  }
  try {
    return JSON.stringify(value);
  } catch {
    return "—";
  }
}

export interface PreviewRow {
  key: string;
  label: string;
  was: string;
  becomes: string;
  /** Поле меняется (подсвечивается). Ключ только в «было» — контекст, не меняется. */
  changed: boolean;
}

/**
 * Строки сравнения: сначала поля «было» в их порядке, затем новые из «станет».
 * Поле только в «было» (контекст: какой объект, где опубликован) показывается
 * одинаково в обеих колонках и не подсвечивается; только в «станет» — «—» → новое.
 */
export function previewRows(preview: Pick<AssistantActionPreview, "was" | "becomes">): PreviewRow[] {
  const keys: string[] = [];
  for (const key of [...Object.keys(preview.was), ...Object.keys(preview.becomes)]) {
    if (!HIDDEN_KEY(key) && !keys.includes(key)) keys.push(key);
  }
  return keys.map((key) => {
    const inWas = Object.prototype.hasOwnProperty.call(preview.was, key);
    const inBecomes = Object.prototype.hasOwnProperty.call(preview.becomes, key);
    const was = inWas ? formatPreviewValue(preview.was[key]) : "—";
    const becomes = inBecomes ? formatPreviewValue(preview.becomes[key]) : was;
    return { key, label: fieldLabel(key), was, becomes, changed: inBecomes && becomes !== was };
  });
}
