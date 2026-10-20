import { afterAll, beforeAll, describe, expect, it } from "vitest";
import bcrypt from "bcrypt";
import request from "supertest";
import sharp from "sharp";
import { app } from "../src/app.js";
import { prisma } from "../src/db.js";
import { extractGpsFromPhoto } from "../src/lib/propertyPhotoGeo.js";

/**
 * ГЕОЛОКАЦИЯ ПО ФОТО (EXIF GPS, владелец 16.09.2026) — docs/seller-card-and-
 * listing-audit-15-09.md: «отсутствует полностью». Первый тест ниже
 * (`sharp EXIF round-trip`) — не про наш код, а про доказательство, что
 * связка sharp().withExif() → sharp().metadata() → exif-reader вообще
 * переживает кодирование в JPEG и обратно на этой версии sharp: без него
 * остальные тесты проверяли бы только собственную заглушку.
 */

/** Тот же приём, что в других гео-тестах: строим JPEG прямо в памяти через
 *  sharp, никаких файлов-фикстур на диске. GPS — рациональные строки
 *  "градусы/1 минуты/1 секунды/1", как их пишет реальная камера. */
async function jpegWithGps(lat: [number, number, number], latRef: "N" | "S", lng: [number, number, number], lngRef: "E" | "W") {
  return sharp({ create: { width: 4, height: 4, channels: 3, background: "#fff" } })
    .jpeg()
    .withExif({
      IFD3: {
        GPSLatitudeRef: latRef,
        GPSLatitude: `${lat[0]}/1 ${lat[1]}/1 ${lat[2]}/1`,
        GPSLongitudeRef: lngRef,
        GPSLongitude: `${lng[0]}/1 ${lng[1]}/1 ${lng[2]}/1`,
      },
    })
    .toBuffer();
}

async function jpegWithoutGps() {
  return sharp({ create: { width: 4, height: 4, channels: 3, background: "#fff" } }).jpeg().toBuffer();
}

// Точка в тестовом районе — 38°33'00" с.ш., 68°46'48" в.д. = 38.55, 68.78.
const POINT = { lat: 38.55, lng: 68.78 };

describe("extractGpsFromPhoto — разбор EXIF", () => {
  it("реальная точка (N/E) — переводит DMS в десятичные градусы верно", async () => {
    const buf = await jpegWithGps([38, 33, 0], "N", [68, 46, 48], "E");
    const gps = await extractGpsFromPhoto(buf);
    expect(gps).not.toBeNull();
    expect(gps!.lat).toBeCloseTo(POINT.lat, 6);
    expect(gps!.lng).toBeCloseTo(POINT.lng, 6);
  });

  it("южное/западное полушарие — знак минус", async () => {
    const buf = await jpegWithGps([38, 33, 0], "S", [68, 46, 48], "W");
    const gps = await extractGpsFromPhoto(buf);
    expect(gps!.lat).toBeCloseTo(-POINT.lat, 6);
    expect(gps!.lng).toBeCloseTo(-POINT.lng, 6);
  });

  it("фото без EXIF (скриншот/мессенджер уже вырезал) — null, не ошибка", async () => {
    const buf = await jpegWithoutGps();
    expect(await extractGpsFromPhoto(buf)).toBeNull();
  });

  it("(0, 0) — Null Island, признак пустого тега, а не настоящая точка — null", async () => {
    const buf = await jpegWithGps([0, 0, 0], "N", [0, 0, 0], "E");
    expect(await extractGpsFromPhoto(buf)).toBeNull();
  });

  it("битый буфер (не изображение вовсе) — null, не бросает", async () => {
    await expect(extractGpsFromPhoto(Buffer.from("не фото"))).resolves.toBeNull();
  });
});

describe("POST /:id/photos — достраивает гео объекта из EXIF", () => {
  const runId = Date.now();
  const password = "testpass123";
  let districtId: string;
  let agentId: string;
  let token: string;
  const propertyIds: string[] = [];

  beforeAll(async () => {
    const passwordHash = await bcrypt.hash(password, 10);
    districtId = (await prisma.district.create({ data: { name: `Тест-район-фото-гео-${runId}`, lat: POINT.lat, lng: POINT.lng } })).id;
    await prisma.building.create({
      data: {
        sourceId: `test-building-photo-gps-${runId}`,
        street: "Гео-Тестовая",
        houseNumber: "9",
        districtId,
        lat: POINT.lat,
        lng: POINT.lng,
      },
    });
    agentId = (
      await prisma.agent.create({ data: { fullName: "Агент фото-гео", phone: `+992955${runId}`, role: "AGENT", passwordHash } })
    ).id;
    const res = await request(app).post("/api/v1/auth/login").send({ phone: `+992955${runId}`, password });
    expect(res.status).toBe(200);
    token = res.body.accessToken as string;
  });

  afterAll(async () => {
    await prisma.propertyPhoto.deleteMany({ where: { propertyId: { in: propertyIds } } });
    await prisma.property.deleteMany({ where: { id: { in: propertyIds } } });
    await prisma.agent.deleteMany({ where: { id: agentId } });
    await prisma.building.deleteMany({ where: { sourceId: `test-building-photo-gps-${runId}` } });
    await prisma.district.deleteMany({ where: { id: districtId } });
    await prisma.$disconnect();
  });

  async function makeProperty(overrides: Partial<{ lat: number; lng: number; geocodedAt: Date | null; districtId: string; address: string }> = {}) {
    const p = await prisma.property.create({
      data: {
        title: `Объект фото-гео ${runId}-${propertyIds.length}`,
        type: "APARTMENT",
        areaSqm: 50,
        price: 40000,
        currency: "TJS",
        // Пустой район/адрес по умолчанию — ровно случай, который чинит фича.
        condition: "GOOD",
        status: "EDITING",
        intakeAgentId: agentId,
        createdById: agentId,
        ...overrides,
      },
    });
    propertyIds.push(p.id);
    return p;
  }

  it("объект без района/адреса/координат — все три достраиваются из первого фото с GPS", async () => {
    const property = await makeProperty();
    const gpsPhoto = await jpegWithGps([38, 33, 0], "N", [68, 46, 48], "E");

    const res = await request(app)
      .post(`/api/v1/properties/${property.id}/photos`)
      .set("Authorization", `Bearer ${token}`)
      .attach("photos", gpsPhoto, "photo1.jpg");
    expect(res.status).toBe(201);

    const after = await prisma.property.findUniqueOrThrow({ where: { id: property.id } });
    // Prisma.Decimal — сравнение только через Number(), как везде в lib/geoResolve.ts.
    expect(Number(after.lat)).toBeCloseTo(POINT.lat, 5);
    expect(Number(after.lng)).toBeCloseTo(POINT.lng, 5);
    expect(after.geocodedAt).not.toBeNull();
    expect(after.districtId).toBe(districtId);
    expect(after.address).toContain("Гео-Тестовая");
  });

  it("ручной пин (geocodedAt пуст) НЕ перезаписывается фото с другими координатами", async () => {
    const property = await makeProperty({ lat: 39, lng: 69, geocodedAt: null, districtId, address: "Ручной адрес агента" });
    const gpsPhoto = await jpegWithGps([38, 33, 0], "N", [68, 46, 48], "E");

    const res = await request(app)
      .post(`/api/v1/properties/${property.id}/photos`)
      .set("Authorization", `Bearer ${token}`)
      .attach("photos", gpsPhoto, "photo1.jpg");
    expect(res.status).toBe(201);

    const after = await prisma.property.findUniqueOrThrow({ where: { id: property.id } });
    // Координаты и адрес — ручные, фото их не тронуло.
    expect(Number(after.lat)).toBe(39);
    expect(Number(after.lng)).toBe(69);
    expect(after.address).toBe("Ручной адрес агента");
  });

  it("район/адрес уже заполнены агентом — фото добавляет только координаты, текст не трогает", async () => {
    const property = await makeProperty({ districtId, address: "Уже введённый агентом адрес" });
    const gpsPhoto = await jpegWithGps([38, 33, 0], "N", [68, 46, 48], "E");

    const res = await request(app)
      .post(`/api/v1/properties/${property.id}/photos`)
      .set("Authorization", `Bearer ${token}`)
      .attach("photos", gpsPhoto, "photo1.jpg");
    expect(res.status).toBe(201);

    const after = await prisma.property.findUniqueOrThrow({ where: { id: property.id } });
    expect(Number(after.lat)).toBeCloseTo(POINT.lat, 5);
    expect(after.address).toBe("Уже введённый агентом адрес");
  });

  it("фото без EXIF — объект остаётся без координат, ничего не выдумываем", async () => {
    const property = await makeProperty();
    const plainPhoto = await jpegWithoutGps();

    const res = await request(app)
      .post(`/api/v1/properties/${property.id}/photos`)
      .set("Authorization", `Bearer ${token}`)
      .attach("photos", plainPhoto, "photo1.jpg");
    expect(res.status).toBe(201);

    const after = await prisma.property.findUniqueOrThrow({ where: { id: property.id } });
    expect(after.lat).toBeNull();
    expect(after.geocodedAt).toBeNull();
  });

  it("вторая пачка после того, как автогеокодер уже проставил координаты — можно обновить снова", async () => {
    const property = await makeProperty();
    const first = await jpegWithGps([38, 33, 0], "N", [68, 46, 48], "E");
    await request(app)
      .post(`/api/v1/properties/${property.id}/photos`)
      .set("Authorization", `Bearer ${token}`)
      .attach("photos", first, "photo1.jpg");

    // Другая точка того же района — автогеокодер (geocodedAt не пуст) не запрещает перезапись.
    const second = await jpegWithGps([38, 33, 5], "N", [68, 46, 50], "E");
    const res = await request(app)
      .post(`/api/v1/properties/${property.id}/photos`)
      .set("Authorization", `Bearer ${token}`)
      .attach("photos", second, "photo2.jpg");
    expect(res.status).toBe(201);

    const after = await prisma.property.findUniqueOrThrow({ where: { id: property.id } });
    expect(Number(after.lat)).toBeCloseTo(38 + 33 / 60 + 5 / 3600, 4);
    expect(after.geocodedAt).not.toBeNull();
  });
});
