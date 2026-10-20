import { afterAll, beforeAll, describe, expect, it } from "vitest";
import request from "supertest";

/**
 * ОБНОВЛЕНИЕ УЖЕ ЗАВЕДЁННОГО НА САЙТЕ ОБЪЕКТА НЕ ДОЛЖНО ПЕРЕТИРАТЬ CRM
 * (ночная проверка 24.09.2026, №127).
 *
 * `/site-listing-upserted` присылает форму сайта ЦЕЛИКОМ, а не диф: раньше
 * отсутствующее в конкретной доставке поле (комнаты, этажность, описание)
 * писалось как значение по умолчанию и стирало то, что поправили в CRM руками;
 * цена в сомони ложилась в объект, переведённый в доллары, как есть; ВСЕ фото
 * объекта (включая загруженные/улучшенные прямо в CRM) стирались и заводились
 * заново только из присланного списка; уведомления о правке не было вовсе;
 * объект, лежащий в Корзине (`deletedAt`), правился наравне с обычным.
 */

const { app } = await import("../src/app.js");
const { prisma } = await import("../src/db.js");
const { fromTjs, loadMoneyContext, roundMoney } = await import("../src/lib/money.js");

const runId = Date.now();
const API_KEY = `test-site-existing-${runId}`;
let districtId = "";
const propertyIds: string[] = [];

async function makeListing(overrides: Partial<{
  currency: "TJS" | "USD";
  rooms: number | null;
  floor: number | null;
  totalFloors: number | null;
  description: string | null;
  deletedAt: Date | null;
}> = {}) {
  const siteListingId = 910_000_000 + Math.floor(Math.random() * 9_000_000);
  const property = await prisma.property.create({
    data: {
      title: `Объект с сайта ${siteListingId}`,
      type: "APARTMENT",
      rooms: overrides.rooms ?? 3,
      areaSqm: 60,
      floor: overrides.floor ?? 5,
      totalFloors: overrides.totalFloors ?? 9,
      price: 60_000,
      currency: overrides.currency ?? "USD",
      districtId,
      address: `Адрес ${siteListingId}`,
      condition: "GOOD",
      description: overrides.description ?? "Описание из CRM, руками поправленное",
      status: "AVAILABLE",
      publishedOnSite: true,
      siteListingId,
      deletedAt: overrides.deletedAt ?? null,
    },
  });
  propertyIds.push(property.id);
  await prisma.propertyPhoto.create({
    data: {
      propertyId: property.id,
      url: "/uploads/crm-enhanced.jpg",
      thumbUrl: "/uploads/thumbs/crm-enhanced.jpg",
      order: 0,
    },
  });
  return { siteListingId, property };
}

beforeAll(async () => {
  process.env.WEBSITE_LEAD_API_KEY = API_KEY;
  districtId = (await prisma.district.create({ data: { name: `Сайт-обновление-${runId}` } })).id;
});

afterAll(async () => {
  delete process.env.WEBSITE_LEAD_API_KEY;
  await prisma.siteEditNotification.deleteMany({ where: { propertyId: { in: propertyIds } } });
  await prisma.propertyPhoto.deleteMany({ where: { propertyId: { in: propertyIds } } });
  await prisma.property.deleteMany({ where: { id: { in: propertyIds } } });
  await prisma.district.deleteMany({ where: { id: districtId } });
});

describe("Правка объекта, заведённого на сайте, не перетирает CRM (/site-listing-upserted)", () => {
  it("не присланное поле не обнуляется, цена в USD-объекте не портится, фото CRM остаются, уведомление заводится", async () => {
    const { siteListingId, property } = await makeListing({ currency: "USD" });

    const priceFromSiteTjs = 66_000;
    const res = await request(app)
      .post("/api/v1/webhooks/site-listing-upserted")
      .set("X-Api-Key", API_KEY)
      .send({
        siteListingId,
        action: "upserted",
        title: property.title,
        location: `Адрес ${siteListingId}`,
        price: priceFromSiteTjs,
        area: 60,
        // rooms/floor/totalFloors/description сознательно не присланы —
        // форма сайта могла их не заполнить, но это не значит "очистить".
        imageUrls: ["https://royalhome.tj/site-photo-1.jpg"],
      });
    expect(res.status).toBe(200);
    expect(res.body.created).toBe(false);

    const after = await prisma.property.findUniqueOrThrow({ where: { id: property.id } });
    // Не присланные поля остались как были.
    expect(after.rooms).toBe(3);
    expect(after.floor).toBe(5);
    expect(after.totalFloors).toBe(9);
    expect(after.description).toBe("Описание из CRM, руками поправленное");

    // Цена с сайта всегда в сомони — для USD-объекта она переведена по курсу,
    // а не записана как сомони поверх долларовой цены.
    expect(after.currency).toBe("USD");
    const ctx = await loadMoneyContext();
    const expectedPrice = roundMoney(fromTjs(priceFromSiteTjs, "USD", ctx));
    expect(Number(after.price)).toBeCloseTo(expectedPrice, 6);

    // Фото, загруженное/улучшенное в CRM, никуда не делось; фото с сайта добавлено.
    const photos = await prisma.propertyPhoto.findMany({ where: { propertyId: property.id } });
    expect(photos.map((p) => p.url).sort()).toEqual(
      ["/uploads/crm-enhanced.jpg", "https://royalhome.tj/site-photo-1.jpg"].sort()
    );

    // Уведомление о правке теперь заводится.
    const notification = await prisma.siteEditNotification.findFirst({
      where: { propertyId: property.id, action: "UPDATED" },
    });
    expect(notification).not.toBeNull();
  });

  it("объект в Корзине правку с сайта не принимает", async () => {
    const { siteListingId, property } = await makeListing({ currency: "TJS", rooms: 2, deletedAt: new Date() });

    const res = await request(app)
      .post("/api/v1/webhooks/site-listing-upserted")
      .set("X-Api-Key", API_KEY)
      .send({
        siteListingId,
        action: "upserted",
        title: "Новое название с сайта",
        location: `Адрес ${siteListingId}`,
        price: 99_000,
        area: 60,
        rooms: 7,
      });
    expect(res.status).toBe(200);
    expect(res.body.trashed).toBe(true);

    const after = await prisma.property.findUniqueOrThrow({ where: { id: property.id } });
    expect(after.deletedAt).not.toBeNull();
    expect(after.rooms).toBe(2);
    expect(Number(after.price)).toBe(60_000);
    expect(after.title).toBe(property.title);

    const notification = await prisma.siteEditNotification.findFirst({
      where: { propertyId: property.id, action: "UPDATED" },
    });
    expect(notification).toBeNull();
  });
});
