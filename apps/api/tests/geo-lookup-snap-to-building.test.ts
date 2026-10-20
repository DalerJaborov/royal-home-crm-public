import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { prisma } from "../src/db.js";
import { lookupGeoPoint, snapToBuilding } from "../src/lib/geoLookup.js";
import { isPointInPolygon, parseWktPolygonRing } from "../src/lib/geo.js";

/**
 * ТОЧКА ПО ФОТО — НА ДОМ (28.09.2026, владелец: «по EXIF на пару метров в
 * дорогу ввёл, и не выходит номер дома, потому что метка не на доме»).
 *
 * 1. «Ближайший дом» меряется до СТЕНЫ, а не до центра: точка на дороге в 15 м
 *    от длинного дома (центр в 45 м) раньше не находила дом вовсе.
 * 2. `snapToBuilding` переносит такую точку внутрь дома; точку в доме и точку
 *    вдали от домов не трогает.
 */

const runId = Date.now();
const prefix = `test-geo-snap-${runId}`;
// Вне настоящего справочника и в стороне от точки geo-lookup-house-number (38.3/68.5).
const HOUSE = { lat: 38.31, lng: 68.52 };
const M_LAT = 1 / 111_000;
const M_LNG = 1 / (111_000 * Math.cos((HOUSE.lat * Math.PI) / 180));

// Длинный дом: 120 м вдоль долготы, 20 м в глубину.
function rectWkt(lat: number, lng: number, halfNorthM: number, halfEastM: number): string {
  const ring = [
    [lng - halfEastM * M_LNG, lat - halfNorthM * M_LAT],
    [lng + halfEastM * M_LNG, lat - halfNorthM * M_LAT],
    [lng + halfEastM * M_LNG, lat + halfNorthM * M_LAT],
    [lng - halfEastM * M_LNG, lat + halfNorthM * M_LAT],
    [lng - halfEastM * M_LNG, lat - halfNorthM * M_LAT],
  ];
  return `POLYGON((${ring.map(([x, y]) => `${x} ${y}`).join(", ")}))`;
}

const OUTLINE = rectWkt(HOUSE.lat, HOUSE.lng, 10, 60);
let districtId = "";

beforeAll(async () => {
  await prisma.building.deleteMany({ where: { sourceId: { startsWith: prefix } } });
  districtId = (await prisma.district.create({ data: { name: `Тест-район-снап-${runId}`, lat: HOUSE.lat, lng: HOUSE.lng } })).id;
  await prisma.building.create({
    data: {
      sourceId: `${prefix}-long`,
      street: "проспект Тестовый",
      houseNumber: "181",
      districtId,
      lat: HOUSE.lat,
      lng: HOUSE.lng,
      outline: OUTLINE,
    },
  });
});

afterAll(async () => {
  await prisma.building.deleteMany({ where: { sourceId: { startsWith: prefix } } });
  await prisma.district.deleteMany({ where: { id: districtId } });
});

describe("lookupGeoPoint — ближайший дом до стены", () => {
  it("точка на дороге в 15 м от стены (45 м от центра) — дом рядом, номер есть", async () => {
    const onRoad = { lat: HOUSE.lat - 25 * M_LAT, lng: HOUSE.lng + 40 * M_LNG };
    const geo = await lookupGeoPoint(onRoad.lat, onRoad.lng);
    expect(geo.confidence).toBe("nearby");
    expect(geo.houseNumber).toBe("181");
    expect(geo.building?.distanceM).toBe(15);
  });

  it("точка в доме — контур, расстояние 0", async () => {
    const geo = await lookupGeoPoint(HOUSE.lat + 5 * M_LAT, HOUSE.lng - 50 * M_LNG);
    expect(geo.confidence).toBe("contour");
    expect(geo.building?.distanceM).toBe(0);
  });

  it("в 45 м от стены — не «рядом»", async () => {
    const geo = await lookupGeoPoint(HOUSE.lat - 55 * M_LAT, HOUSE.lng);
    expect(geo.building).toBeNull();
  });
});

describe("snapToBuilding — точку по фото переносим в дом", () => {
  it("точка рядом с домом встаёт внутрь контура", async () => {
    const onRoad = { lat: HOUSE.lat - 25 * M_LAT, lng: HOUSE.lng + 40 * M_LNG };
    const geo = await lookupGeoPoint(onRoad.lat, onRoad.lng);
    const snapped = snapToBuilding(onRoad, geo);
    const ring = parseWktPolygonRing(OUTLINE)!;
    expect(isPointInPolygon(snapped.lng, snapped.lat, ring)).toBe(true);
    const again = await lookupGeoPoint(snapped.lat, snapped.lng);
    expect(again.confidence).toBe("contour");
  });

  it("точку в доме и точку вдали не трогает", async () => {
    const inside = { lat: HOUSE.lat, lng: HOUSE.lng - 30 * M_LNG };
    expect(snapToBuilding(inside, await lookupGeoPoint(inside.lat, inside.lng))).toEqual(inside);
    const far = { lat: HOUSE.lat - 200 * M_LAT, lng: HOUSE.lng };
    expect(snapToBuilding(far, await lookupGeoPoint(far.lat, far.lng))).toEqual(far);
  });
});

// Общий контур у двух домов (секции одного здания) — отдаётся тот, чей центр
// ближе к точке, а не «первый попавшийся» (аудит 02.10.2026: 3 460 из 13 501
// домов справочника делят контур с соседом).
describe("lookupGeoPoint — два дома с одним контуром", () => {
  const CENTER = { lat: 38.33, lng: 68.52 };
  const SHARED = rectWkt(CENTER.lat, CENTER.lng, 10, 60);
  let district2 = "";

  beforeAll(async () => {
    district2 = (await prisma.district.create({ data: { name: `Тест-район-общий-${runId}`, lat: CENTER.lat, lng: CENTER.lng } })).id;
    // Заведены в «неудобном» порядке: правый раньше левого.
    for (const [suffix, number, dLng] of [["b", "12Б", 30], ["a", "12А", -30]] as const) {
      await prisma.building.create({
        data: {
          sourceId: `${prefix}-shared-${suffix}`,
          street: "проспект Тестовый",
          houseNumber: number,
          districtId: district2,
          lat: CENTER.lat,
          lng: CENTER.lng + dLng * M_LNG,
          outline: SHARED,
        },
      });
    }
  });

  afterAll(async () => {
    await prisma.building.deleteMany({ where: { sourceId: { startsWith: `${prefix}-shared` } } });
    await prisma.district.deleteMany({ where: { id: district2 } });
  });

  it("точка у левой секции — «12А», у правой — «12Б»", async () => {
    const left = await lookupGeoPoint(CENTER.lat, CENTER.lng - 40 * M_LNG);
    const right = await lookupGeoPoint(CENTER.lat, CENTER.lng + 40 * M_LNG);
    expect(left.houseNumber).toBe("12А");
    expect(right.houseNumber).toBe("12Б");
  });
});
