import { afterAll, beforeAll, describe, expect, it } from "vitest";
import bcrypt from "bcrypt";
import request from "supertest";

/**
 * УДАЛЕНИЕ ОБЪЕКТА С САЙТА — ПО ТЕМ ЖЕ ПРАВИЛАМ, ЧТО И ИЗ CRM (аудит 23.09.2026, №47).
 *
 * Сайт уводил в Корзину объект с живой сделкой и гасил только заявки и ссылки:
 * показы, очередь монтажа и отложенные публикации по удалённому объекту жили
 * дальше.
 */

const { app } = await import("../src/app.js");
const { prisma } = await import("../src/db.js");

const runId = Date.now();
const tail = String(runId).slice(-7);
const API_KEY = `test-site-trash-${runId}`;
let districtId = "";
let agentId = "";
let directorId = "";
let directorToken = "";
let clientId = "";
const propertyIds: string[] = [];

async function siteProperty(listingId: number) {
  const created = await request(app)
    .post("/api/v1/webhooks/site-listing-upserted")
    .set("X-Api-Key", API_KEY)
    .send({ siteListingId: listingId, action: "upserted", title: `Сайт ${listingId}`, location: `Адрес ${listingId}`, price: 42000, area: 42 });
  expect(created.status).toBe(201);
  propertyIds.push(created.body.propertyId);
  return created.body.propertyId as string;
}

beforeAll(async () => {
  process.env.WEBSITE_LEAD_API_KEY = API_KEY;
  const passwordHash = await bcrypt.hash("testpass123", 10);
  districtId = (await prisma.district.create({ data: { name: `Сайт-корзина-${runId}` } })).id;
  agentId = (
    await prisma.agent.create({ data: { fullName: `Агент сайта ${runId}`, phone: `+99291${tail}`, role: "AGENT", passwordHash } })
  ).id;
  directorId = (
    await prisma.agent.create({ data: { fullName: `Директор сайта ${runId}`, phone: `+99292${tail}`, role: "DIRECTOR", passwordHash } })
  ).id;
  const login = await request(app).post("/api/v1/auth/login").send({ phone: `+99292${tail}`, password: "testpass123" });
  expect(login.status).toBe(200);
  directorToken = login.body.accessToken as string;
  await prisma.client.deleteMany({ where: { phone: `+99293${tail}` } });
  clientId = (
    await prisma.client.create({
      data: { fullName: `Покупатель сайта ${runId}`, phone: `+99293${tail}`, source: "INSTAGRAM", assignedAgentId: agentId, acceptedAt: new Date() },
    })
  ).id;
});

afterAll(async () => {
  delete process.env.WEBSITE_LEAD_API_KEY;
  await prisma.deal.deleteMany({ where: { propertyId: { in: propertyIds } } });
  await prisma.interaction.deleteMany({ where: { clientId } });
  await prisma.siteEditNotification.deleteMany({ where: { propertyId: { in: propertyIds } } });
  await prisma.property.deleteMany({ where: { id: { in: propertyIds } } });
  await prisma.client.deleteMany({ where: { id: clientId } });
  await prisma.agent.deleteMany({ where: { id: { in: [agentId, directorId] } } });
  await prisma.district.deleteMany({ where: { id: districtId } });
});

describe("Сайт удалил объект", () => {
  it("объект со сделкой в Корзину не уходит, и принять удаление нельзя", async () => {
    const listingId = 870_000_000 + Math.floor(Math.random() * 9_000_000);
    const propertyId = await siteProperty(listingId);
    await prisma.deal.create({ data: { clientId, propertyId, agentId, stage: "NEGOTIATION" } });

    const res = await request(app)
      .post("/api/v1/webhooks/site-listing-upserted")
      .set("X-Api-Key", API_KEY)
      .send({ siteListingId: listingId, action: "deleted" });
    expect(res.status).toBe(200);
    const after = await prisma.property.findUniqueOrThrow({ where: { id: propertyId } });
    expect(after.deletedAt).toBeNull();
    expect(after.publishedOnSite).toBe(false);

    const notification = await prisma.siteEditNotification.findFirstOrThrow({ where: { propertyId, action: "DELETED" } });
    const accept = await request(app)
      .post(`/api/v1/site-notifications/${notification.id}/resolve`)
      .set("Authorization", `Bearer ${directorToken}`)
      .send({ resolution: "ACCEPTED" });
    expect(accept.status).toBe(409);
    expect((await prisma.property.findUniqueOrThrow({ where: { id: propertyId } })).deletedAt).toBeNull();
  });

  it("назначенный показ по удалённому объекту снимается", async () => {
    const listingId = 880_000_000 + Math.floor(Math.random() * 9_000_000);
    const propertyId = await siteProperty(listingId);
    const showing = await prisma.interaction.create({
      data: {
        clientId,
        agentId,
        propertyId,
        type: "SHOWING",
        notes: "Показ",
        nextAction: "Показ",
        nextActionDate: new Date(Date.now() + 86_400_000),
      },
    });

    const res = await request(app)
      .post("/api/v1/webhooks/site-listing-upserted")
      .set("X-Api-Key", API_KEY)
      .send({ siteListingId: listingId, action: "deleted" });
    expect(res.status).toBe(200);
    expect((await prisma.property.findUniqueOrThrow({ where: { id: propertyId } })).deletedAt).not.toBeNull();
    const after = await prisma.interaction.findUniqueOrThrow({ where: { id: showing.id } });
    expect(after.nextAction).toBeNull();
    expect(after.declinedAt).not.toBeNull();
  });
});
