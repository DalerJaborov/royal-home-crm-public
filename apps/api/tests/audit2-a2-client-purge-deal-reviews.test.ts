import { afterAll, beforeAll, describe, expect, it } from "vitest";
import request from "supertest";
import { app } from "../src/app.js";
import { prisma } from "../src/db.js";
import { signAccessToken } from "../src/auth/jwt.js";

/**
 * SCHEMA01 (аудит 04.10.2026): «удалить навсегда» падало на DealReview (обе связи
 * ON DELETE RESTRICT). Отзыв строится и для продавца объекта (у которого нет
 * сделок по Deal.clientId), и для покупателя аннулированной сделки. Теперь в той
 * же транзакции стираются отзывы самого клиента и отзывы по удаляемым сделкам.
 * Без миграции: схема не менялась.
 */
const runId = Date.now();
let adminId = "";
let token = "";
let districtId = "";
let propertyId = "";
const clientIds: string[] = [];
const dealIds: string[] = [];

async function makeClient(label: string, deleted: boolean) {
  const c = await prisma.client.create({
    data: {
      fullName: `${label} ${runId}`,
      phone: `+99291${clientIds.length}${runId}`,
      source: "PHONE_CALL",
      ...(deleted ? { deletedAt: new Date() } : {}),
    },
  });
  clientIds.push(c.id);
  return c;
}
async function makeDeal(clientId: string, stage: "COMPLETED" | "CANCELLED") {
  const d = await prisma.deal.create({ data: { clientId, propertyId, agentId: adminId, stage, currency: "USD" } });
  dealIds.push(d.id);
  return d;
}
async function review(dealId: string, clientId: string) {
  await prisma.dealReview.create({ data: { dealId, clientId, channel: "WHATSAPP" } });
}

beforeAll(async () => {
  adminId = (await prisma.agent.create({ data: { fullName: `Админ purge ${runId}`, phone: `+992925${String(runId).slice(-8)}`, role: "ADMIN", passwordHash: "x" } })).id;
  token = signAccessToken({ sub: adminId, role: "ADMIN" });
  districtId = (await prisma.district.create({ data: { name: `Район purge ${runId}` } })).id;
  propertyId = (
    await prisma.property.create({
      data: { title: `Объект purge ${runId}`, type: "APARTMENT", areaSqm: 50, price: 50000, currency: "USD", districtId, address: `Тест ${runId}`, condition: "GOOD", status: "SOLD" },
    })
  ).id;
});

afterAll(async () => {
  await prisma.dealReview.deleteMany({ where: { OR: [{ dealId: { in: dealIds } }, { clientId: { in: clientIds } }] } });
  await prisma.deal.deleteMany({ where: { id: { in: dealIds } } });
  await prisma.client.deleteMany({ where: { id: { in: clientIds } } });
  await prisma.property.deleteMany({ where: { id: propertyId } });
  await prisma.agent.deleteMany({ where: { id: adminId } });
  await prisma.district.deleteMany({ where: { id: districtId } });
  await prisma.$disconnect();
});

describe("удаление навсегда и отзывы по сделкам (SCHEMA01)", () => {
  it("продавец без своих сделок, но с отзывом по чужой сделке: 204, отзыв стёрт, сделка покупателя цела", async () => {
    const buyer = await makeClient("Покупатель purge", false);
    const seller = await makeClient("Продавец purge", true);
    const deal = await makeDeal(buyer.id, "COMPLETED");
    await review(deal.id, seller.id);
    await review(deal.id, buyer.id);

    const res = await request(app).delete(`/api/v1/clients/${seller.id}/permanent`).set("Authorization", `Bearer ${token}`);
    expect(res.status).toBe(204);
    expect(await prisma.client.findUnique({ where: { id: seller.id } })).toBeNull();
    expect(await prisma.dealReview.count({ where: { dealId: deal.id, clientId: seller.id } })).toBe(0);
    // Отзыв покупателя и его сделка остаются.
    expect(await prisma.dealReview.count({ where: { dealId: deal.id, clientId: buyer.id } })).toBe(1);
    expect(await prisma.deal.findUnique({ where: { id: deal.id } })).not.toBeNull();
  });

  it("покупатель с аннулированной сделкой: 204, отзывы по этой сделке стёрты у обеих сторон", async () => {
    const buyer = await makeClient("Покупатель аннул purge", true);
    const seller = await makeClient("Продавец аннул purge", false);
    const deal = await makeDeal(buyer.id, "CANCELLED");
    await review(deal.id, buyer.id);
    await review(deal.id, seller.id);

    const res = await request(app).delete(`/api/v1/clients/${buyer.id}/permanent`).set("Authorization", `Bearer ${token}`);
    expect(res.status).toBe(204);
    expect(await prisma.client.findUnique({ where: { id: buyer.id } })).toBeNull();
    expect(await prisma.deal.findUnique({ where: { id: deal.id } })).toBeNull();
    expect(await prisma.dealReview.count({ where: { dealId: deal.id } })).toBe(0);
    // Карточка продавца осталась.
    expect(await prisma.client.findUnique({ where: { id: seller.id } })).not.toBeNull();
  });
});
