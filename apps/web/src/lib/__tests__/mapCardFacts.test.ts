import { describe, expect, it } from "vitest";
import { emptyMapClickAction, mapCardFacts, nearbySummary } from "../mapCardFacts";

describe("mapCardFacts — строки карточки объекта на карте", () => {
  it("цена целиком, комнаты и цена за метр в сомони", () => {
    const f = mapCardFacts({ price: 1452000, currency: "TJS", rooms: 4, pricePerSqmTjs: 12100.4, placeDescription: " Сино, 400 м от ЦУМа " });
    expect(f.price).toBe(formatted(1452000, "с."));
    expect(f.details).toBe(`4-комн. · ${formatted(12100, "с.")} за м²`);
    expect(f.place).toBe("Сино, 400 м от ЦУМа");
  });

  it("доллары остаются долларами, метр — в сомони", () => {
    const f = mapCardFacts({ price: 85000, currency: "USD", rooms: null, pricePerSqmTjs: 9000, placeDescription: "" });
    expect(f.price.startsWith("$")).toBe(true);
    expect(f.details).toBe(`${formatted(9000, "с.")} за м²`);
    expect(f.place).toBe("");
  });

  it("нечего добавить — пустая строка, а не «·»", () => {
    const f = mapCardFacts({ price: 100, currency: "TJS", rooms: null, pricePerSqmTjs: null, placeDescription: "" });
    expect(f.details).toBe("");
  });
});

describe("emptyMapClickAction — нажатие мимо объекта", () => {
  it("карточка открыта — закрыть её, адрес не показывать", () => {
    expect(emptyMapClickAction(true)).toBe("close-card");
  });
  it("карточки нет — показать адрес точки", () => {
    expect(emptyMapClickAction(false)).toBe("show-address");
  });
});

describe("nearbySummary — что рядом с нажатой точкой", () => {
  const here = { lat: 38.56, lng: 68.78 };
  const at = (dLatM: number, price: number, currency = "TJS") => ({ lat: here.lat + dLatM / 111_320, lng: here.lng, price, currency });

  it("считает только объекты в радиусе и берёт самую низкую цену", () => {
    const text = nearbySummary(here.lat, here.lng, [at(100, 500_000), at(250, 420_000), at(900, 100_000)]);
    expect(text).toBe("Рядом в продаже: 2 объекта, от 420 т. с.");
  });

  it("без точки и вдали — ничего", () => {
    expect(nearbySummary(here.lat, here.lng, [{ lat: null, lng: null, price: 1, currency: "TJS" }, at(2000, 5)])).toBeNull();
  });

  it("разные валюты — без «от …»", () => {
    expect(nearbySummary(here.lat, here.lng, [at(10, 500_000), at(20, 60_000, "USD")])).toBe("Рядом в продаже: 2 объекта");
  });

  it("один объект — «объект», пять — «объектов»", () => {
    expect(nearbySummary(here.lat, here.lng, [at(10, 5000)])).toBe("Рядом в продаже: 1 объект, от 5 т. с.");
    expect(nearbySummary(here.lat, here.lng, [1, 2, 3, 4, 5].map((i) => at(i * 10, 5000)))).toMatch(/^Рядом в продаже: 5 объектов/);
  });
});

function formatted(n: number, suffix: string): string {
  return `${new Intl.NumberFormat("ru-RU").format(n)} ${suffix}`;
}
