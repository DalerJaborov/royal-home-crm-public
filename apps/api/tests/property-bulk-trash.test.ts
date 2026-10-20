import { afterAll, beforeAll, describe, expect, it } from "vitest";
import bcrypt from "bcrypt";

/**
 * МАССОВОЕ УДАЛЕНИЕ ОБЪЕКТОВ В КОРЗИНУ (владелец 03.09.2026) — POST
 * /properties/bulk-trash. Проверяем ровно то, ради чего партия сделана не
 * циклом по DELETE /:id: право то же, что у одиночного удаления, отказ по
 * одному объекту (есть сделки) не отменяет остальные, а удаление мягкое —
 * объект уходит в Корзину, а не стирается.
 */

const request = (await import("supertest")).default;
const { app } = await import("../src/app.js");
const { prisma } = await import("../src/db.js");

const runId = Date.now();
const password = "testpass123";

let districtId = "";
let adminId = "";
let adminToken = "";
let agentId = "";
let agentToken = "";
const propertyIds: string[] = [];
const clientIds: string[] = [];
const dealIds: string[] = [];

async function loginAs(phone: string) {
  const res = await request(app).post("/api/v1/auth/login").send({ phone, password });
  expect(res.status).toBe(200);
  return res.body.accessToken as string;
}

async function makeProperty() {
  const property = await prisma.property.create({
    data: {
      title: `Объект партии ${runId}-${propertyIds.length}`,
      type: "APARTMENT",
      areaSqm: 50,
      price: 50000,
      currency: "USD",
      districtId,
      address: `Тест партии ${runId}`,
      condition: "GOOD",
      status: "AVAILABLE",
      assignedAgentId: agentId,
    },
  });
  propertyIds.push(property.id);
  return property;
}

beforeAll(async () => {
  districtId = (await prisma.district.create({ data: { name: `Партия-удаление-${runId}` } })).id;

  const admin = await prisma.agent.create({
    data: {
      fullName: `Админ партии ${runId}`,
      phone: `+992951${String(runId).slice(-7)}`,
      role: "ADMIN",
      passwordHash: await bcrypt.hash(password, 10),
    },
  });
  adminId = admin.id;
  adminToken = await loginAs(admin.phone);

  const agent = await prisma.agent.create({
    data: {
      fullName: `Агент партии ${runId}`,
      phone: `+992952${String(runId).slice(-7)}`,
      role: "AGENT",
      passwordHash: await bcrypt.hash(password, 10),
    },
  });
  agentId = agent.id;
  agentToken = await loginAs(agent.phone);
});

afterAll(async () => {
  await prisma.deal.deleteMany({ where: { id: { in: dealIds } } });
  await prisma.property.deleteMany({ where: { id: { in: propertyIds } } });
  await prisma.client.deleteMany({ where: { id: { in: clientIds } } });
  await prisma.agent.deleteMany({ where: { id: { in: [adminId, agentId] } } });
  await prisma.district.deleteMany({ where: { id: districtId } });
  await prisma.$disconnect();
});

describe("Массовое удаление объектов в Корзину", () => {
  it("агент без properties.delete не может удалить партию (403)", async () => {
    const property = await makeProperty();
    const res = await request(app)
      .post("/api/v1/properties/bulk-trash")
      .set("Authorization", `Bearer ${agentToken}`)
      .send({ ids: [property.id] });
    expect(res.status).toBe(403);

    const still = await prisma.property.findUnique({ where: { id: property.id }, select: { deletedAt: true } });
    expect(still?.deletedAt).toBeNull();
  });

  it("несколько объектов уходят в Корзину одним запросом", async () => {
    const first = await makeProperty();
    const second = await makeProperty();

    const res = await request(app)
      .post("/api/v1/properties/bulk-trash")
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ ids: [first.id, second.id] });
    expect(res.status).toBe(200);
    expect(res.body.trashed).toBe(2);
    expect(res.body.failed).toBe(0);
    expect(res.body.results).toHaveLength(2);

    const trashed = await prisma.property.findMany({
      where: { id: { in: [first.id, second.id] } },
      select: { id: true, deletedAt: true, deletedById: true },
    });
    expect(trashed.every((p) => p.deletedAt !== null)).toBe(true);
    expect(trashed.every((p) => p.deletedById === adminId)).toBe(true);
  });

  it("объект со сделкой отказывает сам за себя — остальные из партии удаляются", async () => {
    const withDeal = await makeProperty();
    const plain = await makeProperty();

    const client = await prisma.client.create({
      data: { fullName: `Покупатель партии ${runId}`, phone: `+992953${String(runId).slice(-7)}`, source: "WALK_IN" },
    });
    clientIds.push(client.id);
    const deal = await prisma.deal.create({
      data: { propertyId: withDeal.id, clientId: client.id, agentId, stage: "NEGOTIATION" },
    });
    dealIds.push(deal.id);

    const res = await request(app)
      .post("/api/v1/properties/bulk-trash")
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ ids: [withDeal.id, plain.id] });
    expect(res.status).toBe(200);
    expect(res.body.trashed).toBe(1);
    expect(res.body.failed).toBe(1);

    const blocked = res.body.results.find((r: { id: string }) => r.id === withDeal.id);
    expect(blocked.ok).toBe(false);
    expect(blocked.error).toContain("сделк");
    // Номер объекта в ответе — по нему экран показывает, о какой карточке речь.
    expect(blocked.shortId).toBe(withDeal.shortId);

    const states = await prisma.property.findMany({
      where: { id: { in: [withDeal.id, plain.id] } },
      select: { id: true, deletedAt: true },
    });
    expect(states.find((p) => p.id === withDeal.id)?.deletedAt).toBeNull();
    expect(states.find((p) => p.id === plain.id)?.deletedAt).not.toBeNull();
  });

  it("уже удалённый и несуществующий объект отвечают «не найден», а не ломают партию", async () => {
    const property = await makeProperty();
    await prisma.property.update({ where: { id: property.id }, data: { deletedAt: new Date() } });
    const missing = "00000000-0000-0000-0000-000000000000";

    const res = await request(app)
      .post("/api/v1/properties/bulk-trash")
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ ids: [property.id, missing] });
    expect(res.status).toBe(200);
    expect(res.body.trashed).toBe(0);
    expect(res.body.failed).toBe(2);
    expect(res.body.results.every((r: { ok: boolean }) => !r.ok)).toBe(true);
  });

  it("пустой список и партия больше 50 отсекаются валидацией", async () => {
    const empty = await request(app)
      .post("/api/v1/properties/bulk-trash")
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ ids: [] });
    expect(empty.status).toBe(400);

    const tooMany = await request(app)
      .post("/api/v1/properties/bulk-trash")
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ ids: Array.from({ length: 51 }, () => "00000000-0000-0000-0000-000000000000") });
    expect(tooMany.status).toBe(400);
  });

  it("удалённые партией объекты видны в Корзине и восстанавливаются", async () => {
    const property = await makeProperty();
    const res = await request(app)
      .post("/api/v1/properties/bulk-trash")
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ ids: [property.id] });
    expect(res.status).toBe(200);

    const restore = await request(app)
      .post(`/api/v1/properties/${property.id}/restore`)
      .set("Authorization", `Bearer ${adminToken}`);
    expect(restore.status).toBe(204);

    const back = await prisma.property.findUnique({ where: { id: property.id }, select: { deletedAt: true } });
    expect(back?.deletedAt).toBeNull();
  });

  /**
   * СПУТНИК ГАСНЕТ ВМЕСТЕ С ОБЪЕКТОМ (22.09.2026). Контейнер Instagram живёт у
   * Meta сутки: без гашения фоновый проход опубликовал бы ролик удалённого
   * объекта на публичной странице агентства через часы после удаления. Тот же
   * класс, что публичные ссылки и очередь монтажа, которые здесь уже гасятся.
   */
  it("отложенный контейнер Instagram гаснет вместе с объектом", async () => {
    const property = await makeProperty();
    const container = await prisma.pendingInstagramContainer.create({
      data: { propertyId: property.id, containerId: `container-${runId}`, kind: "REEL" },
    });

    const res = await request(app)
      .post("/api/v1/properties/bulk-trash")
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ ids: [property.id] });
    expect(res.status).toBe(200);

    const after = await prisma.pendingInstagramContainer.findUniqueOrThrow({ where: { id: container.id } });
    expect(after.status).toBe("CANCELLED");
    expect(after.resolvedAt).not.toBeNull();
    expect(after.error).toContain("Корзину");
  });
});
