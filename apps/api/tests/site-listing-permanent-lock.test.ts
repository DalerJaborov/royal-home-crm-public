import { afterAll, beforeAll, describe, expect, it } from "vitest";
import request from "supertest";
import { app } from "../src/app.js";
import { prisma } from "../src/db.js";

/**
 * ИДЕМПОТЕНТНОСТЬ /site-listing-changed и /site-listing-upserted (ветка deleted)
 * — замок сделан постоянным (CLAUDE.md, пункт 6 разведки 22.09.2026).
 *
 * До правки замок был окном в 30 секунд, прикрывавшим только строку
 * `SiteEditNotification`. Повтор ПОЗЖЕ окна заводил в ленте «Изменения на сайте»
 * второе одинаковое событие — директор видел одну и ту же правку дважды. Тест
 * эмулирует «позже окна» прямой правкой `createdAt` замка в `ProcessedMessage`.
 */

const runId = Date.now().toString(36);
const API_KEY = `test-listing-lock-${runId}`;

let districtId: string;
let propertyId: string;
const cleanupPropertyIds: string[] = [];

beforeAll(async () => {
  process.env.WEBSITE_LEAD_API_KEY = API_KEY;
  districtId = (await prisma.district.create({ data: { name: `Замок-район-${runId}` } })).id;
  propertyId = (
    await prisma.property.create({
      data: {
        title: `Замок-объект ${runId}`,
        type: "APARTMENT",
        areaSqm: 55,
        price: 50000,
        currency: "USD",
        districtId,
        address: `Замок ${runId}`,
        condition: "GOOD",
        status: "AVAILABLE",
        publishedOnSite: true,
      },
    })
  ).id;
  cleanupPropertyIds.push(propertyId);
});

afterAll(async () => {
  delete process.env.WEBSITE_LEAD_API_KEY;
  await prisma.siteEditNotification.deleteMany({ where: { propertyId: { in: cleanupPropertyIds } } });
  await prisma.property.deleteMany({ where: { id: { in: cleanupPropertyIds } } });
  await prisma.district.delete({ where: { id: districtId } }).catch(() => {});
  await prisma.processedMessage.deleteMany({ where: { channel: { in: ["SITE_LISTING_CHANGED", "SITE_LISTING_DELETED"] } } });
});

describe("POST /site-listing-changed — замок держится дольше 30 секунд", () => {
  it("повтор ПОЗЖЕ старого окна не заводит вторую запись в ленте правок", async () => {
    const payload = { externalId: propertyId, action: "updated", changes: { price: 61000 }, editedBy: "admin-lock" };

    const first = await request(app).post("/api/v1/webhooks/site-listing-changed").set("X-Api-Key", API_KEY).send(payload);
    expect(first.status).toBe(201);

    await prisma.processedMessage.updateMany({
      where: { channel: "SITE_LISTING_CHANGED" },
      data: { createdAt: new Date(Date.now() - 60_000) },
    });

    const second = await request(app).post("/api/v1/webhooks/site-listing-changed").set("X-Api-Key", API_KEY).send(payload);
    expect(second.status).toBe(201);
    expect(second.body.duplicate).toBe(true);

    const count = await prisma.siteEditNotification.count({ where: { propertyId, action: "UPDATED" } });
    // Главная проверка: одно и то же событие не задвоилось в ленте.
    expect(count).toBe(1);
  });

  it("настоящая другая правка того же объекта по-прежнему заводит новое событие", async () => {
    const before = await prisma.siteEditNotification.count({ where: { propertyId } });
    const res = await request(app)
      .post("/api/v1/webhooks/site-listing-changed")
      .set("X-Api-Key", API_KEY)
      .send({ externalId: propertyId, action: "updated", changes: { price: 72000 }, editedBy: "admin-lock" });
    expect(res.status).toBe(201);
    const after = await prisma.siteEditNotification.count({ where: { propertyId } });
    expect(after).toBe(before + 1);
  });
});

describe("POST /site-listing-upserted (deleted) — замок держится дольше 30 секунд", () => {
  it("повтор ПОЗЖЕ старого окна не заводит второе событие DELETED", async () => {
    const listingId = 810_000_000 + Math.floor(Math.random() * 9_000_000);

    const created = await request(app)
      .post("/api/v1/webhooks/site-listing-upserted")
      .set("X-Api-Key", API_KEY)
      .send({
        siteListingId: listingId,
        action: "upserted",
        title: `Замок-удаление ${listingId}`,
        location: `Замок-адрес ${listingId}`,
        price: 42000,
        area: 42,
      });
    expect(created.status).toBe(201);
    const deletePropertyId = created.body.propertyId as string;
    cleanupPropertyIds.push(deletePropertyId);

    const first = await request(app)
      .post("/api/v1/webhooks/site-listing-upserted")
      .set("X-Api-Key", API_KEY)
      .send({ siteListingId: listingId, action: "deleted" });
    expect(first.status).toBe(200);

    await prisma.processedMessage.updateMany({
      where: { channel: "SITE_LISTING_DELETED" },
      data: { createdAt: new Date(Date.now() - 60_000) },
    });

    const second = await request(app)
      .post("/api/v1/webhooks/site-listing-upserted")
      .set("X-Api-Key", API_KEY)
      .send({ siteListingId: listingId, action: "deleted" });
    expect(second.status).toBe(200);

    const count = await prisma.siteEditNotification.count({ where: { propertyId: deletePropertyId, action: "DELETED" } });
    expect(count).toBe(1);
  });

  it("удаление → восстановление → новое удаление того же объекта не блокируется старым замком", async () => {
    const listingId = 850_000_000 + Math.floor(Math.random() * 9_000_000);

    const created = await request(app)
      .post("/api/v1/webhooks/site-listing-upserted")
      .set("X-Api-Key", API_KEY)
      .send({
        siteListingId: listingId,
        action: "upserted",
        title: `Замок-цикл ${listingId}`,
        location: `Замок-адрес ${listingId}`,
        price: 38000,
        area: 38,
      });
    expect(created.status).toBe(201);
    const cyclePropertyId = created.body.propertyId as string;
    cleanupPropertyIds.push(cyclePropertyId);

    const firstDelete = await request(app)
      .post("/api/v1/webhooks/site-listing-upserted")
      .set("X-Api-Key", API_KEY)
      .send({ siteListingId: listingId, action: "deleted" });
    expect(firstDelete.status).toBe(200);

    // Агент восстанавливает объект из Корзины в CRM — это меняет updatedAt и
    // снимает deletedAt, законный новый цикл.
    await prisma.property.update({ where: { id: cyclePropertyId }, data: { deletedAt: null } });

    // Второе, самостоятельное удаление с сайта — НЕ повтор доставки, а новая
    // команда. Ключ замка обязан отличаться от первого удаления.
    const secondDelete = await request(app)
      .post("/api/v1/webhooks/site-listing-upserted")
      .set("X-Api-Key", API_KEY)
      .send({ siteListingId: listingId, action: "deleted" });
    expect(secondDelete.status).toBe(200);
    expect(secondDelete.body.deleted).toBe(true);

    const property = await prisma.property.findUnique({ where: { id: cyclePropertyId } });
    expect(property?.deletedAt).not.toBeNull();

    const count = await prisma.siteEditNotification.count({ where: { propertyId: cyclePropertyId, action: "DELETED" } });
    expect(count).toBe(2);
  });
});
