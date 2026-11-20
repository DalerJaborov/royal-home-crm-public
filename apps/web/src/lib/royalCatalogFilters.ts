import type { PropertyFilters } from "../hooks/useProperties";

/**
 * Число на кнопке «Фильтры (n)» каталога «Нового вида» (пачка D1, ревью PR 331): сколько
 * условий СУЖАЮТ выдачу. Порядок списка («Сначала дешёвые») ничего не прячет — не считается.
 * Стадии и «Мои объекты» живут в той же шторке — считаются.
 */
export function royalCatalogFilterCount(filters: PropertyFilters, isMine: boolean): number {
  return [
    filters.type,
    filters.districtIds?.length ? "1" : undefined,
    filters.areaMin != null || filters.areaMax != null ? "1" : undefined,
    filters.priceMin != null || filters.priceMax != null ? "1" : undefined,
    filters.noVideo,
    filters.overdue,
    filters.status || filters.inPrep ? "1" : undefined,
    isMine ? "1" : undefined,
  ].filter(Boolean).length;
}
