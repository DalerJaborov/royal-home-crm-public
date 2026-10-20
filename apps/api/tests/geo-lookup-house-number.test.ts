import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { prisma } from "../src/db.js";
import { lookupGeoPoint } from "../src/lib/geoLookup.js";
import { formatGeoAddressGuess } from "../src/routes/properties/crud.js";

/**
 * НОМЕР ДОМА ПО ТОЧКЕ (23.09.2026, владелец: «карта пишет только улицу, номер
 * дома не пишет»).
 *
 * 1. Дом, на контур которого нажали, обязан найтись и в плотном квартале. Раньше
 *    lookupGeoPoint брал 200 домов без порядка из прямоугольника ±500 м, а в
 *    центре там до 839 домов с контуром — нужный часто отрезался, и ответ уходил
 *    на «ближайший в 30 м», то есть соседний дом (жалоба 14.09).
 * 2. Дом без улицы (микрорайон) не теряет номер в адресе объекта.
 */

const runId = Date.now();
const prefix = `test-geo-house-${runId}`;
// Место вне настоящего справочника (южнее города), чтобы чужие дома не мешали.
const TARGET = { lat: 38.3, lng: 68.5 };
const M_LAT = 1 / 111_000;

function squareWkt(lat: number, lng: number, halfM: number): string {
  const dLat = halfM * M_LAT;
  const dLng = halfM / (111_000 * Math.cos((lat * Math.PI) / 180));
  const ring = [
    [lng - dLng, lat - dLat],
    [lng + dLng, lat - dLat],
    [lng + dLng, lat + dLat],
    [lng - dLng, lat + dLat],
    [lng - dLng, lat - dLat],
  ];
  return `POLYGON((${ring.map(([x, y]) => `${x} ${y}`).join(", ")}))`;
}

let districtId: string;

beforeAll(async () => {
  await prisma.building.deleteMany({ where: { sourceId: { startsWith: prefix } } });
  districtId = (await prisma.district.create({ data: { name: `Тест-район-дом-${runId}`, lat: TARGET.lat, lng: TARGET.lng } })).id;
  // 250 соседних домов южнее, в 350-450 м: прежний прямоугольник ±500 м их видел,
  // и они, вставленные первыми и лежащие южнее, занимали все 200 мест выборки.
  const decoys = Array.from({ length: 250 }, (_, i) => {
    const lat = TARGET.lat - (350 + (i % 10) * 10) * M_LAT;
    const lng = TARGET.lng + (Math.floor(i / 10) - 12) * 0.0002;
    return {
      sourceId: `${prefix}-decoy-${i}`,
      street: "улица Соседняя",
      houseNumber: String(i + 1),
      districtId,
      lat,
      lng,
      outline: squareWkt(lat, lng, 4),
    };
  });
  await prisma.building.createMany({ data: decoys });
  // Сам дом: точка нажатия внутри контура, но центр дома в 40 м — дальше 30 м,
  // так что «ближайший дом» его бы не нашёл, только контур.
  const centerLat = TARGET.lat + 40 * M_LAT;
  await prisma.building.create({
    data: {
      sourceId: `${prefix}-target`,
      street: "улица Нужная",
      houseNumber: "48",
      districtId,
      lat: centerLat,
      lng: TARGET.lng,
      outline: squareWkt(centerLat, TARGET.lng, 60),
    },
  });
});

afterAll(async () => {
  await prisma.building.deleteMany({ where: { sourceId: { startsWith: prefix } } });
  await prisma.district.deleteMany({ where: { id: districtId } });
});

describe("номер дома по точке", () => {
  it("точка внутри контура дома в плотном квартале — улица и номер этого дома", async () => {
    const r = await lookupGeoPoint(TARGET.lat, TARGET.lng);
    expect(r.confidence).toBe("contour");
    expect(r.street).toBe("улица Нужная");
    expect(r.houseNumber).toBe("48");
  });

  it("дом без улицы (микрорайон) — номер остаётся в адресе", () => {
    const base = {
      building: { id: "b" },
      street: null,
      houseNumber: "14",
      microdistrict: "82 мкр",
      livingArea: null,
      district: null,
      floors: null,
      entrances: null,
      confidence: "contour" as const,
    };
    expect(formatGeoAddressGuess(base)).toBe("82 мкр, 14");
    expect(formatGeoAddressGuess({ ...base, microdistrict: null, livingArea: "Испечак" })).toBe("Испечак, 14");
    expect(formatGeoAddressGuess({ ...base, street: "улица Айни" })).toBe("улица Айни, 14");
    expect(formatGeoAddressGuess({ ...base, houseNumber: null, building: null })).toBe("82 мкр");
  });
});
