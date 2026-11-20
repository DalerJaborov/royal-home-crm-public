import { describe, expect, it } from "vitest";
import { royalCatalogFilterCount } from "../royalCatalogFilters";

/** «Фильтры (n)»: считаются только условия, сужающие выдачу; порядок — нет (ревью #331). */
describe("число на кнопке «Фильтры» каталога", () => {
  it("сортировка не фильтр", () => {
    expect(royalCatalogFilterCount({ sort: "price_asc" }, false)).toBe(0);
    expect(royalCatalogFilterCount({ sort: "price_desc", priceMax: 500000 }, false)).toBe(1);
  });
  it("район, цена, стадия и «Мои» — по одному", () => {
    expect(royalCatalogFilterCount({ districtIds: ["d1", "d2"], priceMin: 1, priceMax: 2, inPrep: "1" }, true)).toBe(4);
  });
});
