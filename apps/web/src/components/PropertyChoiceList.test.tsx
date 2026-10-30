import { describe, it, expect, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import type { ComponentProps } from "react";
import { PropertyChoiceList } from "./PropertyChoiceList";

const property = { id: "test-property", shortId: 42, title: "Квартира у парка", price: "500000", currency: "TJS" as const, district: { id: "test-district", name: "Сино", city: "Душанбе" }, address: "Тестовый адрес", areaSqm: "60", rooms: 2, floor: 4, totalFloors: 9, status: "AVAILABLE" as const, photos: [] };
const render = (props: Partial<ComponentProps<typeof PropertyChoiceList>> = {}) => renderToStaticMarkup(<PropertyChoiceList items={[property]} value="" onChange={vi.fn()} {...props} />);

describe("property choice context", () => {
  it("identifies the object before selection using address, price, size and floor", () => {
    const html = render();
    for (const text of ["ОБ-000042", "Квартира у парка", "Сино", "Тестовый адрес", "60 м²", "2 комн.", "Этаж 4/9", "500 000 с."]) expect(html).toContain(text);
    expect(html).toContain('type="radio"');
    expect(html).not.toContain("<select");
  });
  it("makes selection explicit and preserves native keyboard radio semantics", () => {
    const html = render({ value: property.id });
    expect(html).toContain("· Выбран");
    expect(html).toContain('checked=""');
    expect(html).toContain('aria-label="Выбрать ОБ-000042: Квартира у парка"');
  });
  it("supports optional empty selection and disables all choices during a pending operation", () => {
    const html = render({ emptyLabel: "Без объекта", disabled: true });
    expect(html).toContain("Без объекта");
    expect(html).toMatch(/<fieldset[^>]+disabled/);
    expect(html).toContain('checked=""');
  });
  it("does not invent a photograph or a missing price/address", () => {
    const html = render({ items: [{ id: "missing", shortId: 1, title: "Без данных" }] });
    expect(html).toContain("Нет фото");
    expect(html).toContain("Цена не указана");
    expect(html).toContain("Адрес не указан");
    expect(html).not.toContain("<img");
  });
  it("uses an original photograph if the server supplies no thumbnail", () => {
    const photos = [{ url: "/test-original.jpg" }] as ComponentProps<typeof PropertyChoiceList>["items"][number]["photos"];
    expect(render({ items: [{ ...property, photos }] })).toContain('src="/test-original.jpg"');
  });
  it("distinguishes loading and failure from no matching objects", () => {
    expect(render({ items: [], loading: true })).toContain("Ищу объекты");
    const error = render({ items: [], error: true, onRetry: vi.fn() });
    expect(error).toContain('role="alert"');
    expect(error).toContain("Повторить");
    expect(error).not.toContain("Объекты не найдены");
    expect(render({ items: [] })).toContain("Объекты не найдены");
  });
});

