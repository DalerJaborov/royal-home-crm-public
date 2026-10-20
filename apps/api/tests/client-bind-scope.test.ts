import { afterAll, beforeAll, describe, expect, it } from "vitest";
import request from "supertest";
import { app } from "../src/app.js";
import { prisma } from "../src/db.js";
import { signAccessToken } from "../src/auth/jwt.js";

/**
 * ЧУЖОГО КЛИЕНТА К СВОЕЙ ЗАПИСИ НЕ ПРИВЯЗАТЬ (аудит 23.09.2026, находка 1.6).
 *
 * Объект с clientId чужого продавца брал его настоящий телефон в «контакт
 * владельца» и отдавал агенту в ответе — номер в обход маски. Ссылка клиенту
 * писала «отправлен объект» в хронологию чужого клиента. Сделка это уже
 * проверяла; теперь все три идут через одно правило canBindClient.
 */

const runId = `${Date.now()}`.slice(-6);
let districtId = "";
let agentA = "";
let agentB = "";
let tokenA = "";
let foreignSellerId = "";
let ownSellerId = "";
const propertyIds: string[] = [];

function body(extra: Record<string, unknown>) {
  return {
    type: "APARTMENT",
    areaSqm: 40,
    rooms: 1,
    floor: 2,
    totalFloors: 5,
    windowCount: 2,
    price: 200000,
    currency: "TJS",
    districtId,
    address: `Привязка клиента ${runId}`,
    condition: "GOOD",
    ...extra,
  };
}

beforeAll(async () => {
  districtId = (await prisma.district.create({ data: { name: `Привязка клиента ${runId}` } })).id;
  agentA = (
    await prisma.agent.create({
      data: { fullName: `Агент А ${runId}`, phone: `+992931${runId}1`, role: "AGENT", passwordHash: "x" },
    })
  ).id;
  agentB = (
    await prisma.agent.create({
      data: { fullName: `Агент Б ${runId}`, phone: `+992931${runId}2`, role: "AGENT", passwordHash: "x" },
    })
  ).id;
  tokenA = signAccessToken({ sub: agentA, role: "AGENT" });
  foreignSellerId = (
    await prisma.client.create({
      data: {
        fullName: "Чужой продавец",
        phone: `+992932${runId}1`,
        kind: "SELLER",
        source: "WALK_IN",
        status: "NEW",
        assignedAgentId: agentB,
      },
    })
  ).id;
  ownSellerId = (
    await prisma.client.create({
      data: {
        fullName: "Свой продавец",
        phone: `+992932${runId}2`,
        kind: "SELLER",
        source: "WALK_IN",
        status: "NEW",
        assignedAgentId: agentA,
      },
    })
  ).id;
});

afterAll(async () => {
  await prisma.propertyShareLink.deleteMany({ where: { propertyId: { in: propertyIds } } });
  await prisma.interaction.deleteMany({ where: { clientId: { in: [foreignSellerId, ownSellerId] } } });
  await prisma.property.deleteMany({ where: { id: { in: propertyIds } } });
  await prisma.client.deleteMany({ where: { id: { in: [foreignSellerId, ownSellerId] } } });
  await prisma.agent.deleteMany({ where: { id: { in: [agentA, agentB] } } });
  await prisma.district.deleteMany({ where: { id: districtId } });
});

describe("привязка клиента к объекту и ссылке", () => {
  it("объект с чужим продавцом не создаётся, телефон не уходит агенту", async () => {
    const res = await request(app)
      .post("/api/v1/properties")
      .set("Authorization", `Bearer ${tokenA}`)
      .send(body({ clientId: foreignSellerId }));
    expect(res.status).toBe(403);
    expect(JSON.stringify(res.body)).not.toContain(`932${runId}1`);
  });

  it("со своим продавцом объект создаётся как раньше", async () => {
    const res = await request(app)
      .post("/api/v1/properties")
      .set("Authorization", `Bearer ${tokenA}`)
      .send(body({ clientId: ownSellerId, address: `Привязка клиента ${runId}, свой` }));
    expect(res.status).toBe(201);
    propertyIds.push(res.body.id);
  });

  it("ссылку на объект для чужого клиента сделать нельзя", async () => {
    const own = await prisma.property.create({
      data: {
        title: `Привязка ${runId}`,
        type: "APARTMENT",
        areaSqm: 40,
        price: 200000,
        currency: "TJS",
        districtId,
        condition: "GOOD",
        status: "AVAILABLE",
        assignedAgentId: agentA,
      } as never,
    });
    propertyIds.push(own.id);
    const res = await request(app)
      .post(`/api/v1/properties/${own.id}/share-links`)
      .set("Authorization", `Bearer ${tokenA}`)
      .send({ clientId: foreignSellerId });
    expect(res.status).toBe(403);
    expect(await prisma.propertyShareLink.count({ where: { propertyId: own.id } })).toBe(0);
  });

  /**
   * ГЛУБОКАЯ ПРОВЕРКА 02.10.2026, A7 — тот же класс без clientId. Агент вписывал
   * в «контакт владельца» номер чужого продавца, и сервер сам находил карточку
   * по номеру и молча привязывал объект к ней (а заодно закрывал её владельцу
   * автозадачу «продавец без объекта»). Явный clientId и PATCH номера это уже
   * проверяли (lib/propertyOwnerRelink.ts — «то же правило, что на создании»),
   * само создание — нет.
   */
  it("номер чужого продавца в контакте владельца — 403, объект не заводится", async () => {
    const before = await prisma.property.count({ where: { districtId } });
    const res = await request(app)
      .post("/api/v1/properties")
      .set("Authorization", `Bearer ${tokenA}`)
      .send(body({ ownerContact: `+992932${runId}1`, address: `Привязка клиента ${runId}, по номеру чужой` }));
    expect(res.status).toBe(403);
    expect(await prisma.property.count({ where: { districtId } })).toBe(before);
    expect(await prisma.property.count({ where: { sellerClientId: foreignSellerId } })).toBe(0);
  });

  it("номер своего продавца в контакте владельца — объект привязывается к нему, как раньше", async () => {
    const res = await request(app)
      .post("/api/v1/properties")
      .set("Authorization", `Bearer ${tokenA}`)
      .send(body({ ownerContact: `+992932${runId}2`, address: `Привязка клиента ${runId}, по номеру свой` }));
    expect(res.status).toBe(201);
    propertyIds.push(res.body.id);
    const row = await prisma.property.findUnique({ where: { id: res.body.id }, select: { sellerClientId: true } });
    expect(row?.sellerClientId).toBe(ownSellerId);
  });
});
