import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router-dom";
import type { MarketOverpricedItem, MarketOverpricedResponse } from "@royal-home/shared";
import { MarketOverpricedView } from "./MarketOverpriced";

const item = (i: number, over: Partial<MarketOverpricedItem> = {}): MarketOverpricedItem => ({
  propertyId: `id-${i}`, shortId: 100 + i, title: `Квартира ${i}`, districtName: "Сино", rooms: 2, areaSqm: 60, askingPriceTjs: 900000,
  estimatedPriceTjs: 627000, diffPercent: 43, sampleSize: 12, basis: "Сино, 2-комнатные", ...over,
});
const data = (items: MarketOverpricedItem[], over: Partial<MarketOverpricedResponse> = {}): MarketOverpricedResponse => ({
  minSample: 8, thresholdPercent: 10, checked: 20, withoutData: 4, truncated: false, items, ...over,
});
const render = (d: MarketOverpricedResponse, shown?: number) =>
  renderToStaticMarkup(<MemoryRouter><MarketOverpricedView data={d} shown={shown} onMore={() => {}} /></MemoryRouter>);

describe("MarketOverpricedView (наши объекты дороже рынка)", () => {
  it("строка: ссылка на карточку, район, комнаты, отклонение, цена и ориентир рынка", () => {
    const html = render(data([item(1)]));
    expect(html).toContain('href="/properties/101"');
    expect(html).toContain("Сино · 2 комн.");
    expect(html).toContain("+43%");
    expect(html).toMatch(/900[\s  ]000/);
    expect(html).toMatch(/рынок около 627[\s  ]000/);
    expect(html).toContain("по 12 объявл.");
  });

  it("подпись честно говорит про прикидку и что цены объявлений не цены сделок; «—» нет", () => {
    const html = render(data([item(1)]));
    expect(html).toContain("Это прикидка");
    expect(html).toContain("не цены сделок");
    expect(html).toContain("больше чем на 10% выше");
    expect(html).not.toContain("—");
  });

  it("порция «Показать ещё» и пометка о пределе выборки", () => {
    const many = Array.from({ length: 12 }, (_, i) => item(i));
    expect(render(data(many), 10)).toContain("Показать ещё · 2");
    expect((render(data(many), 10).match(/market-overpriced-row/g) ?? []).length).toBe(10);
    expect(render(data(many, { truncated: true }), 20)).toContain("проверены самые свежие");
  });

  it("пусто: «таких объектов нет» и сколько сравнили; без объектов для сравнения — своя подпись", () => {
    expect(render(data([]))).toContain("Сравнили 16 из 20 объектов");
    expect(render(data([], { checked: 0, withoutData: 0 }))).toContain("нет квартир с ценой и площадью");
  });
});
