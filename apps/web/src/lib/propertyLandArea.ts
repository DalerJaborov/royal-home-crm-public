import type { PropertyType } from "@royal-home/shared";

/**
 * Площадь участка в сотках (находка №183). Мастер её собирает с 21.09.2026, но в
 * карточке она нигде не показывалась и в форме правки не менялась — ошибочную
 * цифру исправить было нечем. У дома и земли это главная цифра, м² строения её
 * не заменяет, у квартиры и коммерции поля нет.
 */
export function hasLandArea(type: PropertyType): boolean {
  return type === "HOUSE" || type === "LAND";
}

/** «6 соток» из десятичной строки базы («6.00» → «6»). */
export function formatLandSotka(value: string | number | null | undefined): string {
  const n = value == null || value === "" ? NaN : Number(value);
  if (!Number.isFinite(n) || n <= 0) return "не указано";
  return `${Number.parseFloat(n.toFixed(2))} сот.`;
}

/** Значение поля формы: число без хвостовых нулей или пустая строка. */
export function landAreaFormValue(value: string | number | null | undefined): string {
  const n = value == null || value === "" ? NaN : Number(value);
  return Number.isFinite(n) && n > 0 ? String(Number.parseFloat(n.toFixed(2))) : "";
}

/**
 * Что отправить на сервер. Схема создания принимает только число (null отвергает),
 * схема правки — и null, чтобы очистить поле. Для квартиры и коммерции поле не
 * трогаем вовсе: оно скрыто, и стирать нечего.
 */
export function landAreaPayload(
  type: PropertyType,
  formValue: string,
  isEdit: boolean
): { landAreaSotka?: number | null } {
  if (!hasLandArea(type)) return {};
  const n = Number(formValue.replace(",", "."));
  if (formValue.trim() !== "" && Number.isFinite(n) && n > 0) return { landAreaSotka: n };
  return isEdit ? { landAreaSotka: null } : {};
}
