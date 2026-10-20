import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { prisma } from "../src/db.js";
import { geocodeAddress } from "../src/lib/geocode.js";

/**
 * АДРЕС ОБЪЕКТА СПЕРВА ИЩЕТСЯ В НАШЕМ СПРАВОЧНИКЕ ДОМОВ (24.09.2026, «16
 * известных поломок карты»).
 *
 * В `Building` больше двадцати тысяч домов Душанбе с улицей и номером, а
 * геокодер отправлял адрес только в Nominatim — и получал либо центр улицы,
 * либо ничего. Теперь дом из справочника отвечает первым, Nominatim — запасной.
 *
 * Улица и дом — выдуманные, с меткой прогона в названии: совпасть с чужими
 * записями общей базы им не с чем.
 */

const runId = Date.now();
const tag = `тестдомов${runId}`;
const STREET_NAME = `улица ${tag}`;
const HOUSE = { lat: 38.5777, lng: 68.7999 };
const streetSourceId = `test-geocode-dir-street-${runId}`;
const buildingSourceId = `test-geocode-dir-house-${runId}`;
let districtId: string;
let streetId: string;

const nominatimQueries: string[] = [];
const realFetch = globalThis.fetch;

beforeAll(async () => {
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    if (!url.includes("nominatim.openstreetmap.org")) return realFetch(input, init);
    nominatimQueries.push(new URL(url).searchParams.get("q") ?? "");
    return new Response("[]", { status: 200, headers: { "Content-Type": "application/json" } });
  });
  districtId = (await prisma.district.create({ data: { name: `Тест-район-справочник-${runId}` } })).id;
  streetId = (
    await prisma.street.create({
      data: { sourceId: streetSourceId, name: STREET_NAME, kind: "улица", districtId, lat: 38.57, lng: 68.79 },
    })
  ).id;
  // Словарь синонимов улицы — как его собирает импорт (prisma/scripts/import-geo.ts).
  await prisma.geoAlias.createMany({
    data: [STREET_NAME, `ул ${tag}`, tag].map((text) => ({
      text,
      normalized: text,
      targetType: "street",
      targetId: streetId,
      source: "agent",
    })),
  });
  await prisma.building.create({
    data: { sourceId: buildingSourceId, street: STREET_NAME, houseNumber: "7", districtId, lat: HOUSE.lat, lng: HOUSE.lng },
  });
});

afterEach(() => {
  nominatimQueries.length = 0;
});

afterAll(async () => {
  vi.restoreAllMocks();
  await prisma.building.deleteMany({ where: { sourceId: buildingSourceId } });
  await prisma.geoAlias.deleteMany({ where: { targetId: streetId } });
  await prisma.street.deleteMany({ where: { id: streetId } });
  await prisma.district.deleteMany({ where: { id: districtId } });
});

describe("Геокодер адреса объекта: справочник домов, потом Nominatim", () => {
  it("«улица + номер» — точка дома из справочника, Nominatim не спрашиваем", async () => {
    const result = await geocodeAddress(`${STREET_NAME}, 7`, "Сино");
    expect(result).not.toBeNull();
    expect(result!.lat).toBeCloseTo(HOUSE.lat, 4);
    expect(result!.lng).toBeCloseTo(HOUSE.lng, 4);
    expect(nominatimQueries).toHaveLength(0);
  });

  it("живое написание: район спереди, «ул.» и квартира сзади", async () => {
    const result = await geocodeAddress(`Сино, ул. ${tag} 7, кв. 12`, "Сино");
    expect(result).not.toBeNull();
    expect(result!.lat).toBeCloseTo(HOUSE.lat, 4);
    expect(nominatimQueries).toHaveLength(0);
  });

  it("номера нет в справочнике — идём в Nominatim", async () => {
    const result = await geocodeAddress(`${STREET_NAME}, 999`, "Сино");
    expect(result).toBeNull();
    expect(nominatimQueries).toHaveLength(1);
  });
});
