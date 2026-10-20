import { propertyFieldShown, propertyFinishSummary, propertyFloorsLabel, propertyHasCondition } from "@royal-home/shared";
import { PROPERTY_CONDITION_LABELS, PROPERTY_TYPE_LABELS, pluralizeRu, formatArea } from "./format";
import type { Property } from "../types";
import { formatLandSotka, hasLandArea } from "./propertyLandArea";

/**
 * Параметры объекта одним списком на все раскладки карточки (24.09.2026).
 *
 * До этого плитки и поля «Параметры» были набраны четыре раза, и наборы
 * разошлись. На телефоне в просмотре стояла «Цена за м²», хотя она уже есть
 * под ценой, а в правке вместо неё был «Район». Этаж писался то «5 из 9», то
 * «5/9», а отделка называлась то «Состояние», то «Ремонт». Человек нажимал
 * «Изменить» и видел другие плитки. Цена за м² живёт только под ценой.
 */
export function propertyParams(
  p: Pick<Property, "type" | "condition" | "areaSqm" | "landAreaSotka" | "rooms" | "floor" | "totalFloors" | "district"> &
    Parameters<typeof propertyFinishSummary>[0],
): { label: string; value: string }[] {
  // Что показывать у типа — packages/shared/src/propertyTypeFields.ts (08.10.2026):
  // у дома вместо «Этажа» этажность, у участка нет комнат, этажей и состояния.
  const floors = propertyFloorsLabel(p);
  return [
    ...(propertyFieldShown(p.type, "areaSqm") ? [{ label: "Площадь", value: `${formatArea(p.areaSqm)} м²` }] : []),
    // Участок — только у дома и земли (находка №183).
    ...(hasLandArea(p.type) ? [{ label: "Участок", value: formatLandSotka(p.landAreaSotka) }] : []),
    ...(propertyFieldShown(p.type, "rooms") ? [{ label: "Комнаты", value: p.rooms ? String(p.rooms) : "не указано" }] : []),
    ...(propertyFieldShown(p.type, "totalFloors")
      ? [floors ?? { label: propertyFieldShown(p.type, "floor") ? "Этаж" : "Этажность", value: "не указано" }]
      : []),
    { label: "Район", value: p.district?.name ?? "не указан" },
    { label: "Тип", value: PROPERTY_TYPE_LABELS[p.type] },
    ...(propertyHasCondition(p.type)
      ? [{ label: "Состояние", value: propertyFinishSummary(p) ?? PROPERTY_CONDITION_LABELS[p.condition] }]
      : []),
  ];
}

/**
 * ПАРАМЕТРЫ ЧИПАМИ ДЛЯ КАРТОЧКИ-ОБЪЯВЛЕНИЯ (контракт 06.10.2026, раздел 6):
 * «82 м² · 4 из 9 · 3 комнаты · хорошее». Один раз на экран.
 *
 * Из `propertyParams` берутся те же значения, своих не добавляется. Выпадают:
 * «Район» (он стоит строкой под ценой, «$793 за м² · Сино») и всё, что сервер
 * не заполнил («не указано»): чип «не указано» это шум, а не параметр. Комнаты
 * без слова («3») читались бы голой цифрой, поэтому дописывается слово.
 */
export function propertyParamChips(p: Parameters<typeof propertyParams>[0]): string[] {
  const out: string[] = [];
  for (const { label, value } of propertyParams(p)) {
    if (label === "Район" || /^не указан/i.test(value)) continue;
    if (label === "Комнаты") {
      const n = Number(value);
      out.push(Number.isFinite(n) ? `${n} ${pluralizeRu(n, ["комната", "комнаты", "комнат"])}` : value);
    } else {
      out.push(value);
    }
  }
  return out;
}
