import { describe, expect, it, vi } from "vitest";
import { toForm } from "../PropertyFormModal";
import { coordsPayload, instagramUrlPayload, versionForSave } from "../../lib/propertyFormPayload";
import type { Property } from "../../types";

// Карта тянет leaflet, которому нужен window; для логики формы она не нужна.
vi.mock("../LocationPicker", () => ({ LocationPicker: () => null }));

/** Аудит 04.10.2026: FORMS02 (версия), FORMS04 (очистка), FORMS07 (этаж 0). */
const saved = (patch: Partial<Property>) => ({ id: "p1", ...patch }) as unknown as Property;

describe("toForm: нулевой этаж (FORMS07)", () => {
  it("этаж 0 остаётся «0», а не пустой строкой", () => {
    expect(toForm(saved({ floor: 0 })).floor).toBe("0");
  });
  it("нет этажа: пусто", () => {
    expect(toForm(saved({ floor: null })).floor).toBe("");
  });
  it("этаж 0 из заявки продавца тоже сохраняется", () => {
    expect(toForm(undefined, undefined, { floor: 0 }).floor).toBe("0");
  });
});

describe("versionForSave (FORMS02)", () => {
  it("берётся версия открытия, а не живая из обновлённого запроса", () => {
    expect(versionForSave(1, 2)).toBe(1);
  });
  it("версии при открытии нет: живая", () => {
    expect(versionForSave(undefined, 5)).toBe(5);
  });
});

describe("instagramUrlPayload (FORMS04)", () => {
  it("стёртая ссылка при правке уходит как null", () => {
    expect(instagramUrlPayload(true, "  ", "https://instagram.com/reel/x")).toEqual({ instagramUrl: null });
  });
  it("ссылки не было и нет: ключа нет", () => {
    expect(instagramUrlPayload(true, "", null)).toEqual({});
  });
  it("при создании пустую не шлём", () => {
    expect(instagramUrlPayload(false, "", undefined)).toEqual({});
  });
  it("непустая уходит как есть", () => {
    expect(instagramUrlPayload(true, "https://instagram.com/reel/y", null)).toEqual({
      instagramUrl: "https://instagram.com/reel/y",
    });
  });
});

describe("coordsPayload (FORMS04)", () => {
  const pt = { lat: "38.5", lng: "68.7" };
  it("сброс сохранённой точки: lat и lng как null парой", () => {
    expect(coordsPayload(true, null, pt)).toEqual({ lat: null, lng: null });
  });
  it("точки не было и нет: ключей нет", () => {
    expect(coordsPayload(true, null, { lat: null, lng: null })).toEqual({});
  });
  it("неизменённая точка не шлётся", () => {
    expect(coordsPayload(true, { lat: 38.5, lng: 68.7 }, pt)).toEqual({});
  });
  it("сдвинутая и новая шлются", () => {
    expect(coordsPayload(true, { lat: 38.6, lng: 68.7 }, pt)).toEqual({ lat: 38.6, lng: 68.7 });
    expect(coordsPayload(false, { lat: 1, lng: 2 }, undefined)).toEqual({ lat: 1, lng: 2 });
  });
});
