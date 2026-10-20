import { afterAll, beforeAll, describe, expect, it } from "vitest";
import request from "supertest";

/**
 * ПУСТОЙ imageUrls НЕ СТИРАЕТ ФОТО ОБЪЕКТА (аудит RISK-04, решение владельца 04.10.2026).
 *
 * `/site-listing-upserted` с `imageUrls: []` (как и без этого поля) не трогает ни фото
 * сайта, ни фото, загруженные в CRM: удалить фото можно только в самой CRM. Тест
 * фиксирует решение, чтобы будущая правка `writePhotos` не превратила [] в «очистить».
 */

const { app } = await import("../src/app.js");
const { prisma } = await import("../src/db.js");

const runId = Date.now();
const API_KEY = `test-empty-images-${runId}`;
let districtId = "";
const propertyIds: string[] = [];

async function makeListingWithPhotos() {
  const siteListingId = 920_000_000 + Math.floor(Math.random() * 9_000_000);
  const property = await prisma.property.create({
    data: {
      title: `Фото-объект ${siteListingId}`,
      type: "APARTMENT",
      rooms: 2,
      areaSqm: 50,
      floor: 3,
      totalFloors: 9,
      price: 50_000,
      currency: "TJS",
      districtId,
      address: `Адрес ${siteListingId}`,
      condition: "GOOD",
      status: "AVAILABLE",
      publishedOnSite: true,
      siteListingId,
    },
  });
  propertyIds.push(property.id);
  await prisma.propertyPhoto.createMany({
    data: [
      { propertyId: property.id, url: "https://royalhome.tj/site-a.jpg", thumbUrl: "https://royalhome.tj/site-a.jpg", order: 0 },
      { propertyId: property.id, url: "https://royalhome.tj/site-b.jpg", thumbUrl: "https://royalhome.tj/site-b.jpg", order: 1 },
      { propertyId: property.id, url: "/uploads/crm-own.jpg", thumbUrl: "/uploads/thumbs/crm-own.jpg", order: 2 },
    ],
  });
  return { siteListingId, property };
}

const urlsOf = async (propertyId: string) =>
  (await prisma.propertyPhoto.findMany({ where: { propertyId }, orderBy: { order: "asc" } })).map((p) => p.url);

beforeAll(async () => {
  process.env.WEBSITE_LEAD_API_KEY = API_KEY;
  districtId = (await prisma.district.create({ data: { name: `Пустые-фото-${runId}` } })).id;
});

afterAll(async () => {
  delete process.env.WEBSITE_LEAD_API_KEY;
  await prisma.siteEditNotification.deleteMany({ where: { propertyId: { in: propertyIds } } });
  await prisma.propertyPhoto.deleteMany({ where: { propertyId: { in: propertyIds } } });
  await prisma.property.deleteMany({ where: { id: { in: propertyIds } } });
  await prisma.district.deleteMany({ where: { id: districtId } });
});

function upsert(siteListingId: number, title: string, extra: Record<string, unknown>) {
  return request(app)
    .post("/api/v1/webhooks/site-listing-upserted")
    .set("X-Api-Key", API_KEY)
    .send({ siteListingId, action: "upserted", title, location: `Адрес ${siteListingId}`, price: 50_000, area: 50, ...extra });
}

describe("Пустой список фото с сайта не стирает фото объекта", () => {
  it("imageUrls: [] оставляет и фото сайта, и фото CRM", async () => {
    const { siteListingId, property } = await makeListingWithPhotos();
    const before = await urlsOf(property.id);

    const res = await upsert(siteListingId, property.title, { imageUrls: [] });

    expect(res.status).toBe(200);
    expect(await urlsOf(property.id)).toEqual(before);
  });

  it("без поля imageUrls фото тоже не трогаются", async () => {
    const { siteListingId, property } = await makeListingWithPhotos();
    const before = await urlsOf(property.id);

    const res = await upsert(siteListingId, property.title, {});

    expect(res.status).toBe(200);
    expect(await urlsOf(property.id)).toEqual(before);
  });
});
