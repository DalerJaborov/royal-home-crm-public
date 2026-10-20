import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import bcrypt from "bcrypt";
import request from "supertest";

/**
 * «ОТКАТИТЬ» УДАЛЕНИЕ С САЙТА (глубокая проверка 02.10.2026, D4).
 *
 * Сайт удалил объявление → вебхук кладёт объект без сделок в Корзину и заводит
 * уведомление DELETED. Директор жмёт «Откатить: переслать версию CRM на сайт
 * заново» — а разбор первой же строкой видел deletedAt и закрывал уведомление
 * «успешно», ничего не сделав: объект оставался в Корзине и не возвращался на
 * сайт. Ветка восстановления была достижима только у объекта со сделкой,
 * который в Корзину и не уходил.
 *
 * И соседний случай того же механизма (D10, хвост): «Откатить» правку сайта
 * публиковал объект без взгляда на статус — снятый с продажи возвращался на
 * витрину.
 */

const API_KEY = `test-site-rollback-${Date.now()}`;
process.env.WEBSITE_LEAD_API_KEY = API_KEY;
vi.stubEnv("SITE_SYNC_URL", "https://site.example/api/v1/crm");
vi.stubEnv("SITE_SYNC_API_KEY", "test-key");
vi.stubEnv("CRM_PUBLIC_URL", "https://crm.example");

const sentToSite: { externalId: string; action: string }[] = [];
const realFetch = globalThis.fetch;
vi.stubGlobal("fetch", async (url: string | URL | Request, init?: RequestInit) => {
  if (String(url).startsWith("https://site.example/")) {
    const body = JSON.parse(String(init?.body)) as { items: { externalId: string; action: string }[] };
    sentToSite.push(...body.items.map((i) => ({ externalId: i.externalId, action: i.action })));
    return new Response(JSON.stringify({ results: body.items.map((i) => ({ externalId: i.externalId, ok: true })) }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  }
  return realFetch(url, init);
});

const { app } = await import("../src/app.js");
const { prisma } = await import("../src/db.js");

const runId = Date.now();
const tail = String(runId).slice(-7);
let directorId = "";
let directorToken = "";
let districtId = "";
const propertyIds: string[] = [];

async function liveSiteProperty() {
  const listingId = 890_000_000 + Math.floor(Math.random() * 9_000_000);
  const created = await request(app)
    .post("/api/v1/webhooks/site-listing-upserted")
    .set("X-Api-Key", API_KEY)
    .send({ siteListingId: listingId, action: "upserted", title: `Откат ${listingId}`, location: `Адрес ${listingId}`, price: 42000, area: 42 });
  expect(created.status, JSON.stringify(created.body)).toBe(201);
  const propertyId = created.body.propertyId as string;
  propertyIds.push(propertyId);
  // Объект прошёл модерацию и стоит на сайте в продаже.
  await prisma.siteEditNotification.updateMany({ where: { propertyId }, data: { resolvedAt: new Date(), resolution: "ACCEPTED" } });
  await prisma.property.update({ where: { id: propertyId }, data: { status: "AVAILABLE", publishedOnSite: true } });
  return { propertyId, listingId };
}

async function resolve(notificationId: string, resolution: "ACCEPTED" | "REJECTED") {
  return request(app)
    .post(`/api/v1/site-notifications/${notificationId}/resolve`)
    .set("Authorization", `Bearer ${directorToken}`)
    .send({ resolution });
}

beforeAll(async () => {
  // Вебхук без единого района в базе отвечает 503 «В CRM нет районов». На
  // новой пустой базе (ship --clean-db) районы есть, только пока их держит
  // соседний файл, — три падения 03.10 ровно этим. Свой район на время файла.
  districtId = (await prisma.district.create({ data: { name: `Откат-район-${runId}` } })).id;
  const passwordHash = await bcrypt.hash("testpass123", 10);
  directorId = (
    await prisma.agent.create({ data: { fullName: `Директор отката ${runId}`, phone: `+99294${tail}`, role: "DIRECTOR", passwordHash } })
  ).id;
  const login = await request(app).post("/api/v1/auth/login").send({ phone: `+99294${tail}`, password: "testpass123" });
  expect(login.status).toBe(200);
  directorToken = login.body.accessToken as string;
});

afterAll(async () => {
  delete process.env.WEBSITE_LEAD_API_KEY;
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  await prisma.siteEditNotification.deleteMany({ where: { propertyId: { in: propertyIds } } });
  await prisma.property.deleteMany({ where: { id: { in: propertyIds } } });
  await prisma.agent.deleteMany({ where: { id: directorId } });
  await prisma.district.deleteMany({ where: { id: districtId, properties: { none: {} } } });
});

describe("D4: «Откатить» удаление объявления сайтом", () => {
  it("объект возвращается из Корзины и снова публикуется на сайте", async () => {
    const { propertyId, listingId } = await liveSiteProperty();
    const del = await request(app)
      .post("/api/v1/webhooks/site-listing-upserted")
      .set("X-Api-Key", API_KEY)
      .send({ siteListingId: listingId, action: "deleted" });
    expect(del.status).toBe(200);
    expect((await prisma.property.findUniqueOrThrow({ where: { id: propertyId } })).deletedAt).not.toBeNull();

    const notification = await prisma.siteEditNotification.findFirstOrThrow({ where: { propertyId, action: "DELETED" } });
    sentToSite.length = 0;
    const res = await resolve(notification.id, "REJECTED");
    expect(res.status).toBe(200);

    const after = await prisma.property.findUniqueOrThrow({ where: { id: propertyId } });
    expect(after.deletedAt).toBeNull();
    expect(after.publishedOnSite).toBe(true);
    expect(sentToSite).toEqual([{ externalId: propertyId, action: "publish" }]);
    const resolved = await prisma.siteEditNotification.findUniqueOrThrow({ where: { id: notification.id } });
    expect(resolved.resolvedAt).not.toBeNull();
    expect(resolved.resolution).toBe("REJECTED");
  });

  it("объект, убранный в Корзину уже в CRM, старым уведомлением не воскрешается", async () => {
    const { propertyId } = await liveSiteProperty();
    const notification = await prisma.siteEditNotification.create({ data: { propertyId, action: "UPDATED", changes: { price: 43000 } } });
    await prisma.property.update({ where: { id: propertyId }, data: { deletedAt: new Date(), deletedById: directorId } });

    sentToSite.length = 0;
    const res = await resolve(notification.id, "REJECTED");
    expect(res.status).toBe(200);
    expect(res.body.propertyDeleted).toBe(true);
    expect((await prisma.property.findUniqueOrThrow({ where: { id: propertyId } })).deletedAt).not.toBeNull();
    expect(sentToSite).toEqual([]);
  });
});

describe("D10: «Откатить» правку сайта у снятого объекта", () => {
  it("снятый с продажи объект не публикуется заново — объявление снимается", async () => {
    const { propertyId } = await liveSiteProperty();
    await prisma.property.update({ where: { id: propertyId }, data: { status: "WITHDRAWN" } });
    const notification = await prisma.siteEditNotification.create({ data: { propertyId, action: "UPDATED", changes: { price: 43000 } } });

    sentToSite.length = 0;
    const res = await resolve(notification.id, "REJECTED");
    expect(res.status).toBe(200);
    expect(sentToSite).toEqual([{ externalId: propertyId, action: "unpublish" }]);
    expect((await prisma.property.findUniqueOrThrow({ where: { id: propertyId } })).publishedOnSite).toBe(false);
  });
});
