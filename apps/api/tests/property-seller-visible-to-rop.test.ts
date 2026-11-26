import { afterAll, beforeAll, describe, expect, it } from "vitest";
import request from "supertest";

/**
 * РОП ВИДИТ ИМЯ ПРОДАВЦА И ЗВОНИТ ЕМУ НА ЛЮБОМ ОБЪЕКТЕ (владелец 26.11.2026:
 * «она должна иметь права любому человеку позвонить и видеть имя хозяина объекта»).
 *
 * Полный номер закрыт всем, кроме директора (16.11.2026), поэтому у РОП — имя, маска
 * и карточка продавца (`sellerClient.canOpen`), по которым работает кнопка «Позвонить».
 * Посторонний агент чужого объекта по-прежнему не видит ни продавца, ни номера.
 */

const { app } = await import("../src/app.js");
const { prisma } = await import("../src/db.js");
const { signAccessToken } = await import("../src/auth/jwt.js");

const runId = Date.now();
const agentIds: string[] = [];
let districtId = "";
let propertyId = "";
let sellerId = "";
let ropToken = "";
let strangerToken = "";

async function agent(role: "AGENT" | "HEAD_OF_SALES", tail: string) {
  const a = await prisma.agent.create({
    data: { fullName: `Продавец объекта ${role} ${runId}`, phone: `+99298${tail}${String(runId).slice(-5)}`, role, passwordHash: "x" },
  });
  agentIds.push(a.id);
  return a;
}

beforeAll(async () => {
  districtId = (await prisma.district.create({ data: { name: `Район продавца РОП ${runId}` } })).id;
  const owner = await agent("AGENT", "71");
  ropToken = signAccessToken({ sub: (await agent("HEAD_OF_SALES", "72")).id, role: "HEAD_OF_SALES" });
  strangerToken = signAccessToken({ sub: (await agent("AGENT", "73")).id, role: "AGENT" });
  sellerId = (
    await prisma.client.create({
      data: { fullName: `Хозяин объекта ${runId}`, phone: `+992981${String(runId).slice(-8)}`, source: "WALK_IN", assignedAgentId: owner.id, acceptedAt: new Date() },
    })
  ).id;
  propertyId = (
    await prisma.property.create({
      data: {
        title: `Объект продавца РОП ${runId}`,
        type: "APARTMENT",
        areaSqm: 50,
        price: 40000,
        currency: "TJS",
        districtId,
        address: "Тестовая продавца, 1",
        condition: "GOOD",
        status: "AVAILABLE",
        intakeAgentId: owner.id,
        createdById: owner.id,
        assignedAgentId: owner.id,
        sellerClientId: sellerId,
        ownerContact: "+992900000088",
      } as never,
    })
  ).id;
});

afterAll(async () => {
  await prisma.property.deleteMany({ where: { id: propertyId } });
  await prisma.client.deleteMany({ where: { id: sellerId } });
  await prisma.district.deleteMany({ where: { id: districtId } });
  await prisma.agent.deleteMany({ where: { id: { in: agentIds } } });
});

describe("GET /properties/:id: продавец чужого объекта", () => {
  it("РОП видит имя, карточку и маску номера, полного номера нет", async () => {
    const res = await request(app).get(`/api/v1/properties/${propertyId}`).set("Authorization", `Bearer ${ropToken}`);
    expect(res.status).toBe(200);
    expect(res.body.sellerClient).toMatchObject({ id: sellerId, canOpen: true });
    expect(res.body.ownerContactMasked).toBeTruthy();
    expect(res.body.ownerContact ?? null).toBeNull();
  });

  it("посторонний агент чужого объекта продавца не видит", async () => {
    const res = await request(app).get(`/api/v1/properties/${propertyId}`).set("Authorization", `Bearer ${strangerToken}`);
    expect(res.status).toBe(200);
    expect(res.body.sellerClient).toBeNull();
    expect(res.body.ownerContactMasked).toBeNull();
  });
});
