import { PROPERTY_DETAIL_LABELS, type PropertyDetailKey } from "@royal-home/shared";

/** Presentation only: the API and draft keep the original shared option values. */
export function detailFieldLabel(key: PropertyDetailKey): string {
  return key === "bathroom" ? "Туалет и ванна / душ" : key === "windows" ? "Тип окон" : PROPERTY_DETAIL_LABELS[key];
}

export function detailOptionLabel(key: PropertyDetailKey, value: string): string {
  if (key === "bathroom") return ({ "Раздельный": "Отдельно", "Совмещённый": "Вместе", "2+ санузла": "Два и больше" } as Record<string, string>)[value] ?? value;
  if (key === "balcony") return ({ "Лоджия": "Встроенный балкон (лоджия)", "Лоджия + балкон": "Балкон и лоджия", "2 лоджии": "Две лоджии", "Терасса": "Терраса" } as Record<string, string>)[value] ?? value;
  return value;
}
