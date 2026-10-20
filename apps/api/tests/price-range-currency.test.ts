import { describe, expect, it } from "vitest";
import { priceRangeBranches, fromTjs } from "../src/lib/money.js";

/**
 * Фильтр «цена от/до» в списке объектов.
 *
 * Цены объектов лежат каждая в своей валюте (Property.price + Property.currency),
 * а границы фильтра приходят в одной. Сравнение с колонкой price напрямую
 * смешивало доллары с сомони: «до 50 000» отдавало и квартиру за 50 000 сомони,
 * и за 50 000 долларов — разница на порядок.
 */

const ctx = { usdToTjs: 11 };

function branch(branches: ReturnType<typeof priceRangeBranches>, currency: "USD" | "TJS") {
  const found = branches.find((b) => b.currency === currency);
  expect(found).toBeDefined();
  return found!;
}

describe("Границы фильтра пересчитываются в валюту хранения", () => {
  it("верхняя граница в сомони превращается в долларовую по курсу", () => {
    const branches = priceRangeBranches({ max: 550_000, currency: "TJS" }, ctx);
    expect(branch(branches, "TJS").price.lte).toBe(550_000);
    // 550 000 сомони по курсу 11 — это 50 000 долларов, а не 550 000.
    expect(branch(branches, "USD").price.lte).toBe(50_000);
  });

  it("границы в долларах пересчитываются в сомони", () => {
    const branches = priceRangeBranches({ min: 40_000, max: 50_000, currency: "USD" }, ctx);
    expect(branch(branches, "USD").price).toEqual({ gte: 40_000, lte: 50_000 });
    expect(branch(branches, "TJS").price).toEqual({ gte: 440_000, lte: 550_000 });
  });

  it("ветка есть на каждую валюту хранения — иначе часть объектов выпала бы из выдачи", () => {
    const branches = priceRangeBranches({ min: 1, currency: "TJS" }, ctx);
    expect(branches.map((b) => b.currency).sort()).toEqual(["TJS", "USD"]);
  });

  it("задана только одна граница — вторая не появляется", () => {
    const branches = priceRangeBranches({ max: 100, currency: "TJS" }, ctx);
    expect(branch(branches, "TJS").price).toEqual({ lte: 100 });
  });

  it("fromTjs обратно к toTjs: сумма возвращается к себе же", () => {
    expect(fromTjs(550_000, "USD", ctx)).toBe(50_000);
    expect(fromTjs(550_000, "TJS", ctx)).toBe(550_000);
  });
});
