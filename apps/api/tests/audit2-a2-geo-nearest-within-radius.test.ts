import { describe, expect, it } from "vitest";
import { haversineMeters, matchesAnyDesiredPlace, nearestDesiredPlace } from "../src/lib/geoDistance.js";

/**
 * CRM-GEO01 (аудит 04.10.2026): nearestDesiredPlace выбирал ближайшее место
 * независимо от его радиуса. Покупатель с А (радиус 100 м) и Б (радиус 1000 м):
 * объект в 222 м от А и 445 м от Б подходит по Б, но ближайшим считалось А, и
 * withinRadius=false отсекал объект.
 */
const prop = { lat: 38.56, lng: 68.78 };
const placeA = { lat: 38.56 + 0.001994, lng: 68.78, radiusM: 100, label: "А" };
const placeB = { lat: 38.56 - 0.004, lng: 68.78, radiusM: 1000, label: "Б" };

describe("nearestDesiredPlace: места со своими радиусами (CRM-GEO01)", () => {
  it("исходные расстояния соответствуют сценарию аудита", () => {
    expect(Math.round(haversineMeters(prop.lat, prop.lng, placeA.lat, placeA.lng))).toBeGreaterThan(200);
    expect(Math.round(haversineMeters(prop.lat, prop.lng, placeB.lat, placeB.lng))).toBeLessThan(500);
  });

  it("берёт ближайшее из мест, в чей радиус объект попал: Б, а не ближайшее А", () => {
    const m = nearestDesiredPlace(prop.lat, prop.lng, [placeA, placeB]);
    expect(m?.withinRadius).toBe(true);
    expect(m?.label).toBe("Б");
    expect(matchesAnyDesiredPlace(prop.lat, prop.lng, [placeA, placeB])?.label).toBe("Б");
  });

  it("ни в один радиус не попал: возвращает ближайшее с withinRadius=false", () => {
    const tight = { ...placeB, radiusM: 100 };
    const m = nearestDesiredPlace(prop.lat, prop.lng, [placeA, tight]);
    expect(m?.withinRadius).toBe(false);
    expect(m?.label).toBe("А");
    expect(matchesAnyDesiredPlace(prop.lat, prop.lng, [placeA, tight])).toBeNull();
  });

  it("попали в оба радиуса: ближайшее из двух", () => {
    const wideA = { ...placeA, radiusM: 500 };
    expect(nearestDesiredPlace(prop.lat, prop.lng, [placeB, wideA])?.label).toBe("А");
  });

  it("множитель адаптивного радиуса учитывается при выборе", () => {
    // А (радиус 100) при множителе 3 даёт 300 м и покрывает объект на ~222 м.
    const m = nearestDesiredPlace(prop.lat, prop.lng, [placeA, { ...placeB, radiusM: 100 }], 3);
    expect(m?.withinRadius).toBe(true);
    expect(m?.label).toBe("А");
  });

  it("пустой список мест: null", () => {
    expect(nearestDesiredPlace(prop.lat, prop.lng, [])).toBeNull();
  });
});
