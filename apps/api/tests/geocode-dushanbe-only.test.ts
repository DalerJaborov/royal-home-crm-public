import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import bcrypt from "bcrypt";
import request from "supertest";
import sharp from "sharp";
import { app } from "../src/app.js";
import { prisma } from "../src/db.js";
import { geocodeAddress } from "../src/lib/geocode.js";
import { resolveBuildingByText } from "../src/lib/geoResolve.js";

/**
 * ТОЧКА ОБЪЕКТА — ТОЛЬКО В ДУШАНБЕ (24.09.2026, «16 известных поломок карты»).
 *
 * 1. Nominatim спрашивали без страны и рамки города: «улица Рудаки, 5» охотно
 *    находилась в Худжанде, и объект уезжал на карте в другой город молча.
 *    Теперь запрос ограничен countrycodes=tj и рамкой Душанбе (bounded=1), а
 *    ответ вне рамки отбрасывается и сам по себе.
 * 2. Геометка фото из другого города (галерея с поездки, пересланный снимок)
 *    так же молча переносила объект — теперь такой кадр пропускается.
 *
 * resolveBuildingByText импортирован ради подмены справочника: тест про
 * Nominatim не должен зависеть от того, какие дома лежат в общей базе.
 */

vi.mock("../src/lib/geoResolve.js", async (importOriginal) => {
  const original = await importOriginal<typeof import("../src/lib/geoResolve.js")>();
  return { ...original, resolveBuildingByText: vi.fn(async () => null) };
});

const runId = Date.now();
const password = "testpass123";
const KHUJAND = { lat: 40.2826, lng: 69.6222 };
const DUSHANBE = { lat: 38.5601, lng: 68.7739 };

const nominatimUrls: URL[] = [];
let nominatimAnswer: { lat: string; lon: string }[] = [];
const realFetch = globalThis.fetch;

beforeAll(() => {
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    if (!url.includes("nominatim.openstreetmap.org")) return realFetch(input, init);
    nominatimUrls.push(new URL(url));
    return new Response(JSON.stringify(nominatimAnswer), { status: 200, headers: { "Content-Type": "application/json" } });
  });
});

afterEach(() => {
  nominatimUrls.length = 0;
  nominatimAnswer = [];
});

afterAll(() => {
  vi.restoreAllMocks();
});

describe("Nominatim ограничен Душанбе", () => {
  it("запрос несёт страну и рамку города, bounded=1", async () => {
    nominatimAnswer = [{ lat: String(DUSHANBE.lat), lon: String(DUSHANBE.lng) }];
    const result = await geocodeAddress(`Рамочная ${runId}, 5`, "Сино");
    expect(vi.mocked(resolveBuildingByText)).toHaveBeenCalled();
    expect(result).toEqual(DUSHANBE);
    expect(nominatimUrls).toHaveLength(1);
    const params = nominatimUrls[0].searchParams;
    expect(params.get("countrycodes")).toBe("tj");
    expect(params.get("bounded")).toBe("1");
    const [left, top, right, bottom] = (params.get("viewbox") ?? "").split(",").map(Number);
    expect(left).toBeLessThan(DUSHANBE.lng);
    expect(right).toBeGreaterThan(DUSHANBE.lng);
    expect(bottom).toBeLessThan(DUSHANBE.lat);
    expect(top).toBeGreaterThan(DUSHANBE.lat);
  });

  it("ответ из другого города — «не нашлось», а не точка в Худжанде", async () => {
    nominatimAnswer = [{ lat: String(KHUJAND.lat), lon: String(KHUJAND.lng) }];
    expect(await geocodeAddress(`улица Рудаки ${runId}, 5`, "")).toBeNull();
  });
});

async function jpegWithGps(lat: number, lng: number) {
  const dms = (v: number) => {
    const deg = Math.floor(v);
    const minFloat = (v - deg) * 60;
    const min = Math.floor(minFloat);
    const sec = Math.round((minFloat - min) * 60);
    return `${deg}/1 ${min}/1 ${sec}/1`;
  };
  return sharp({ create: { width: 4, height: 4, channels: 3, background: "#fff" } })
    .jpeg()
    .withExif({ IFD3: { GPSLatitudeRef: "N", GPSLatitude: dms(lat), GPSLongitudeRef: "E", GPSLongitude: dms(lng) } })
    .toBuffer();
}

describe("Геометка фото вне Душанбе объект не переносит", () => {
  let agentId: string;
  let token: string;
  const phone = `+992962${runId.toString().slice(-6)}`;
  const propertyIds: string[] = [];

  beforeAll(async () => {
    agentId = (
      await prisma.agent.create({
        data: { fullName: "Агент фото-город", phone, role: "AGENT", passwordHash: await bcrypt.hash(password, 10) },
      })
    ).id;
    const res = await request(app).post("/api/v1/auth/login").send({ phone, password });
    token = res.body.accessToken as string;
  });

  afterAll(async () => {
    await prisma.propertyPhoto.deleteMany({ where: { propertyId: { in: propertyIds } } });
    await prisma.property.deleteMany({ where: { id: { in: propertyIds } } });
    await prisma.agent.deleteMany({ where: { id: agentId } });
  });

  async function makeProperty() {
    const p = await prisma.property.create({
      data: {
        title: `Объект фото-город ${runId}-${propertyIds.length}`,
        type: "APARTMENT",
        areaSqm: 50,
        price: 40000,
        currency: "TJS",
        condition: "GOOD",
        status: "EDITING",
        address: `Фотоадрес ${runId}`,
        intakeAgentId: agentId,
        createdById: agentId,
      },
    });
    propertyIds.push(p.id);
    return p;
  }

  it("снимок из Худжанда — координаты остаются пустыми", async () => {
    const property = await makeProperty();
    const res = await request(app)
      .post(`/api/v1/properties/${property.id}/photos`)
      .set("Authorization", `Bearer ${token}`)
      .attach("photos", await jpegWithGps(KHUJAND.lat, KHUJAND.lng), "far.jpg");
    expect(res.status).toBe(201);
    const after = await prisma.property.findUniqueOrThrow({ where: { id: property.id } });
    expect(after.lat).toBeNull();
    expect(after.geocodedAt).toBeNull();
  });

  it("первый кадр из Худжанда, второй из Душанбе — берётся душанбинский", async () => {
    const property = await makeProperty();
    const res = await request(app)
      .post(`/api/v1/properties/${property.id}/photos`)
      .set("Authorization", `Bearer ${token}`)
      .attach("photos", await jpegWithGps(KHUJAND.lat, KHUJAND.lng), "far.jpg")
      .attach("photos", await jpegWithGps(DUSHANBE.lat, DUSHANBE.lng), "near.jpg");
    expect(res.status).toBe(201);
    const after = await prisma.property.findUniqueOrThrow({ where: { id: property.id } });
    expect(Number(after.lat)).toBeCloseTo(DUSHANBE.lat, 2);
    expect(Number(after.lng)).toBeCloseTo(DUSHANBE.lng, 2);
  });
});
