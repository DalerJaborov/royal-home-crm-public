import { describe, expect, it } from "vitest";
import { propertyCreateSchema, propertyUpdateSchema } from "@royal-home/shared";

/**
 * Координаты объекта (ночная проверка 24.09.2026, №184): точку на карте нельзя
 * было очистить (null → 400), а одну широту без долготы — положить в базу.
 */
const base = {
  title: "Квартира у парка",
  type: "APARTMENT",
  price: 50000,
  currency: "USD",
  areaSqm: 64,
  rooms: 2,
  floor: 3,
  totalFloors: 9,
  windowCount: 4,
  condition: "GOOD",
  offSite: true,
  ownerContact: "+992 93 000 00 00",
};

describe("координаты объекта: обе или ни одной", () => {
  it("правка: одна широта без долготы не проходит", () => {
    expect(propertyUpdateSchema.safeParse({ lat: 38.5 }).success).toBe(false);
    expect(propertyUpdateSchema.safeParse({ lat: 38.5, lng: null }).success).toBe(false);
  });

  it("правка: обе координаты или очистка обеих проходят", () => {
    expect(propertyUpdateSchema.safeParse({ lat: 38.5, lng: 68.7 }).success).toBe(true);
    expect(propertyUpdateSchema.safeParse({ lat: null, lng: null }).success).toBe(true);
    expect(propertyUpdateSchema.safeParse({ title: "Без координат" }).success).toBe(true);
  });

  it("создание: одна долгота без широты не проходит", () => {
    const r = propertyCreateSchema.safeParse({ ...base, lng: 68.7 });
    expect(r.success).toBe(false);
    expect(propertyCreateSchema.safeParse({ ...base, lat: 38.5, lng: 68.7 }).success).toBe(true);
  });
});
