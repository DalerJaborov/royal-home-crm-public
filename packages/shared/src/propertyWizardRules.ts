import { floorRuleError } from "./propertyFinish.js";
import { propertyDetailShown, propertyFieldRequired, propertyFieldShown, propertyHasMarket } from "./propertyTypeFields.js";
import { PROPERTY_DETAIL_LABELS } from "./labels.js";
import { PROPERTY_DETAIL_KEYS, type PropertyDetailKey, type PropertyType } from "./enums.js";
import { DETAIL_NOT_SET, type PropertyWizardDraftValues } from "./propertyWizardDraft.js";

/**
 * ПРАВИЛА МАСТЕРА ОБЪЕКТА — ОДНО МЕСТО ДЛЯ CRM И TELEGRAM (10.11.2026).
 *
 * Владелец 10.11.2026: мастер в Telegram у помощницы должен уметь всё, «прямо
 * как мастер по добавлению объектов». До этого обязательность полей жила в
 * `apps/web/src/components/property-wizard/types.ts` (validateStep), а у бота —
 * своя, другая (бот требовал фото и геоточку, которых мастер не требует, и не
 * знал про «цену слишком маленькую»). Теперь обе стороны зовут функции отсюда.
 *
 * Значения — строки черновика (`PropertyWizardDraftValues`): у бота поля могут
 * отсутствовать вовсе, у вкладки они всегда есть, но пустые. Отсутствующее
 * поле здесь равно пустому.
 */

/** Готовые варианты «Документов» — те же, что в PropertyFormModal.tsx. */
export const PROPERTY_DOCUMENT_PRESETS = ["Договор", "Техпаспорт", "Договор + техпаспорт", "Нет документов"] as const;

export type PropertyWizardStepKey = "seller" | "media" | "main" | "place" | "review";

export interface PropertyWizardRuleOptions {
  /** Руководитель обязан указать, кто принял объект (право properties.editForeign). */
  requireIntakeAgent?: boolean;
}

/**
 * Планка неправдоподобности цены — страховка от потерянного разделителя тысяч
 * («1,200» → 1.2). Ниже сотни единиц любой валюты недвижимости не бывает.
 */
export const PROPERTY_MIN_PLAUSIBLE_PRICE = 100;

const str = (value: string | undefined | null) => value ?? "";

/**
 * Ошибки шага мастера. Пустой объект — шаг пройден. Проверки повторяют
 * серверные (propertyCreateSchema), чтобы агент не получил 400 в конце мастера.
 */
export function propertyWizardStepErrors(
  step: PropertyWizardStepKey,
  v: PropertyWizardDraftValues,
  options: PropertyWizardRuleOptions = {}
): Record<string, string> {
  const errors: Record<string, string> = {};
  const positive = (raw: string) => {
    const n = Number(raw);
    return raw.trim() !== "" && Number.isFinite(n) && n > 0;
  };
  const type = v.type;

  if (step === "main") {
    // Закрытый объект: обязательны цена и площадь (владелец 15.09.2026).
    const price = str(v.price);
    if (!positive(price)) errors.price = "Укажите цену";
    else if (Number(price) < PROPERTY_MIN_PLAUSIBLE_PRICE) errors.price = "Проверьте цену — сумма выглядит слишком маленькой";
    if (type === "LAND") {
      if (!positive(str(v.landAreaSotka))) errors.landAreaSotka = "Укажите площадь участка в сотках";
    } else if (!positive(str(v.areaSqm))) {
      errors.areaSqm = "Укажите площадь";
    }
    const floorRaw = str(v.floor).trim();
    const totalRaw = str(v.totalFloors).trim();
    const floorError = floorRuleError(floorRaw === "" ? null : Number(floorRaw), totalRaw === "" ? null : Number(totalRaw));
    if (floorError && propertyFieldShown(type, "floor")) errors.floor = floorError;
    for (const field of ["rooms", "floor", "totalFloors", "windowCount"] as const) {
      const raw = str(v[field]).trim();
      if (!propertyFieldShown(type, field) || !raw) continue;
      const number = Number(raw);
      if (!Number.isInteger(number)) errors[field] = "Введите целое число";
      else if ((field === "rooms" || field === "totalFloors") && number <= 0) errors[field] = "Введите число больше нуля";
      else if (field === "windowCount" && (number < 0 || number > 100)) errors[field] = "Введите число от 0 до 100";
    }
    if (v.offSite) return errors;
    if (propertyFieldRequired(type, "rooms") && !errors.rooms && !positive(str(v.rooms))) errors.rooms = "Укажите комнаты";
    if (propertyFieldRequired(type, "floor") && !errors.floor && (floorRaw === "" || !Number.isFinite(Number(floorRaw)))) {
      errors.floor = "Укажите этаж";
    }
    if (propertyFieldRequired(type, "totalFloors") && !errors.totalFloors && !positive(totalRaw)) errors.totalFloors = "Укажите этажность";
    if (propertyFieldRequired(type, "windowCount") && !errors.windowCount) {
      const raw = str(v.windowCount).trim();
      const windows = Number(raw);
      if (raw === "" || !Number.isInteger(windows) || windows < 0 || windows > 100) {
        errors.windowCount = "Укажите количество окон";
      }
    }
  }

  if (step === "place" && !v.offSite) {
    if (!v.districtId) errors.districtId = "Выберите район";
    if (str(v.address).trim().length < 2) errors.address = "Укажите адрес";
  }

  if (step === "seller") {
    if (options.requireIntakeAgent && !v.intakeAgentId) errors.intakeAgentId = "Укажите, кто принял объект";
    if (!v.sellerClientId) {
      if (!str(v.sellerName).trim()) errors.sellerName = "Укажите имя продавца";
      if (str(v.sellerPhone).replace(/\D/g, "").length < 9) errors.sellerPhone = "Укажите телефон продавца";
    }
  }

  return errors;
}

/** Все шаги разом — то, что блокирует «Сохранить». */
export function propertyWizardErrors(v: PropertyWizardDraftValues, options: PropertyWizardRuleOptions = {}): Record<string, string> {
  return {
    ...propertyWizardStepErrors("main", v, options),
    ...propertyWizardStepErrors("place", v, options),
    ...propertyWizardStepErrors("seller", v, options),
  };
}

/** Подпись характеристики так, как её видит агент в мастере. */
export function propertyDetailFieldLabel(key: PropertyDetailKey): string {
  return key === "bathroom" ? "Туалет и ванна / душ" : key === "windows" ? "Тип окон" : PROPERTY_DETAIL_LABELS[key];
}

/** Подпись варианта характеристики так, как её видит агент в мастере. */
export function propertyDetailOptionLabel(key: PropertyDetailKey, value: string): string {
  if (key === "bathroom") return ({ "Раздельный": "Отдельно", "Совмещённый": "Вместе", "2+ санузла": "Два и больше" } as Record<string, string>)[value] ?? value;
  if (key === "balcony") return ({ "Лоджия": "Встроенный балкон (лоджия)", "Лоджия + балкон": "Балкон и лоджия", "2 лоджии": "Две лоджии", "Терасса": "Терраса" } as Record<string, string>)[value] ?? value;
  return value;
}

/**
 * СМЕНА ТИПА В МАСТЕРЕ (владелец 08.10.2026): поля, которых у нового типа нет,
 * очищаются сразу — иначе этаж квартиры, набранный до переключения на «Дом»,
 * молча уезжал бы на сервер, а «Новостройка» оставалась у участка. Возвращает
 * правку поверх текущих значений.
 */
export function propertyWizardTypeChange<V extends PropertyWizardDraftValues>(v: V, type: PropertyType): Partial<V> {
  const patch: Record<string, unknown> = { type };
  for (const f of ["rooms", "areaSqm", "landAreaSotka", "floor", "totalFloors", "windowCount"] as const) {
    if (!propertyFieldShown(type, f)) patch[f] = "";
  }
  if (!propertyHasMarket(type)) {
    patch.marketType = "";
    patch.stage = "";
    if (v.condition === "NEW_BUILDING") patch.condition = "GOOD";
  }
  const details: Record<string, string> = { ...(v.details ?? {}) };
  let detailsChanged = false;
  for (const k of PROPERTY_DETAIL_KEYS) {
    if (!propertyDetailShown(type, k) && details[k] !== undefined && details[k] !== DETAIL_NOT_SET) {
      details[k] = DETAIL_NOT_SET;
      detailsChanged = true;
    }
  }
  if (detailsChanged) patch.details = details;
  return patch as Partial<V>;
}
