import { afterAll, beforeAll, describe, expect, it } from "vitest";
import bcrypt from "bcrypt";
import request from "supertest";
import { app } from "../src/app.js";
import { prisma } from "../src/db.js";

/**
 * Заявка на пересмотр числа объектов (владелец 06.09.2026, разбор слепых зон
 * п.3; роль добавлена 07.09.2026 для симметрии с покупателем): число пишет
 * только ИИ, агент может лишь оспорить — подтверждает руководитель (право
 * clients.merge). Пока заявка PENDING, число ИИ остаётся в силе.
 */

const runId = Date.now();
const password = "testpass123";

let adminId: string;
let agentId: string;
let adminToken: string;
let agentToken: string;
const clientIds: string[] = [];
const disputeIds: string[] = [];

async function login(phone: string) {
  const res = await request(app).post("/api/v1/auth/login").send({ phone, password });
  return res.body.accessToken as string;
}

beforeAll(async () => {
  const passwordHash = await bcrypt.hash(password, 10);
  adminId = (
    await prisma.agent.create({ data: { fullName: "Админ спора объектов", phone: `+992971${runId}`, role: "ADMIN", passwordHash } })
  ).id;
  agentId = (
    await prisma.agent.create({ data: { fullName: "Агент спора объектов", phone: `+992972${runId}`, role: "AGENT", passwordHash } })
  ).id;
  adminToken = await login(`+992971${runId}`);
  agentToken = await login(`+992972${runId}`);
});

afterAll(async () => {
  await prisma.propertyCountDispute.deleteMany({ where: { id: { in: disputeIds } } });
  await prisma.notification.deleteMany({ where: { tag: { startsWith: "property-count-dispute-" } } });
  await prisma.client.deleteMany({ where: { id: { in: clientIds } } });
  await prisma.agent.deleteMany({ where: { id: { in: [adminId, agentId] } } });
  await prisma.$disconnect();
});

async function makeClientWithAiCount(
  suffix: string,
  aiCount: number,
  role: "SELLER" | "BUYER" = "SELLER"
) {
  const c = await prisma.client.create({
    data: {
      fullName: `Клиент спора ${runId}${suffix}`,
      phone: `+992973${runId}${suffix}`,
      source: "PHONE_CALL",
      kind: role,
      assignedAgentId: agentId,
      ...(role === "SELLER"
        ? { sellerDeclaredPropertyCount: aiCount, sellerDeclaredPropertyCountAt: new Date() }
        : { buyerDesiredPropertyCount: aiCount, buyerDesiredPropertyCountAt: new Date() }),
    },
  });
  clientIds.push(c.id);
  return c;
}

describe("Заявка на пересмотр числа объектов", () => {
  it("агент подаёт заявку (продавец) — 201, число ИИ на карточке не меняется", async () => {
    const client = await makeClientWithAiCount("a", 3);

    const res = await request(app)
      .post(`/api/v1/clients/${client.id}/property-count-dispute`)
      .set("Authorization", `Bearer ${agentToken}`)
      .send({ role: "SELLER", proposedCount: 1, reason: "ИИ перепутал — это была только одна квартира" });

    expect(res.status).toBe(201);
    disputeIds.push(res.body.id);

    const unchanged = await prisma.client.findUnique({ where: { id: client.id } });
    expect(unchanged?.sellerDeclaredPropertyCount).toBe(3);

    const pending = await request(app)
      .get(`/api/v1/clients/${client.id}/property-count-dispute`)
      .set("Authorization", `Bearer ${agentToken}`);
    expect(pending.body.requests).toHaveLength(1);
    expect(pending.body.requests[0].role).toBe("SELLER");
    expect(pending.body.requests[0].status).toBe("PENDING");
    expect(pending.body.requests[0].aiCount).toBe(3);
    expect(pending.body.requests[0].proposedCount).toBe(1);
  });

  it("агент подаёт заявку (покупатель) — пишет и решает buyerDesiredPropertyCount, не трогая продавца", async () => {
    const client = await makeClientWithAiCount("g", 2, "BUYER");

    const res = await request(app)
      .post(`/api/v1/clients/${client.id}/property-count-dispute`)
      .set("Authorization", `Bearer ${agentToken}`)
      .send({ role: "BUYER", proposedCount: 1, reason: "Купит только одну — вторую передумал" });
    expect(res.status).toBe(201);
    disputeIds.push(res.body.id);

    const approve = await request(app)
      .post(`/api/v1/clients/property-count-disputes/${res.body.id}/approve`)
      .set("Authorization", `Bearer ${adminToken}`)
      .send({});
    expect(approve.status).toBe(200);

    const updated = await prisma.client.findUnique({ where: { id: client.id } });
    expect(updated?.buyerDesiredPropertyCount).toBe(1);
    expect(updated?.sellerDeclaredPropertyCount).toBeNull();
  });

  it("dualIntent: заявка на продавца и заявка на покупателя одновременно — не конфликтуют", async () => {
    const client = await prisma.client.create({
      data: {
        fullName: `Дуал спора ${runId}`,
        phone: `+992973${runId}h`,
        source: "PHONE_CALL",
        kind: "SELLER",
        dualIntent: true,
        assignedAgentId: agentId,
        sellerDeclaredPropertyCount: 3,
        sellerDeclaredPropertyCountAt: new Date(),
        buyerDesiredPropertyCount: 2,
        buyerDesiredPropertyCountAt: new Date(),
      },
    });
    clientIds.push(client.id);

    const sellerDispute = await request(app)
      .post(`/api/v1/clients/${client.id}/property-count-dispute`)
      .set("Authorization", `Bearer ${agentToken}`)
      .send({ role: "SELLER", proposedCount: 2, reason: "Продавец: на самом деле два" });
    expect(sellerDispute.status).toBe(201);
    disputeIds.push(sellerDispute.body.id);

    const buyerDispute = await request(app)
      .post(`/api/v1/clients/${client.id}/property-count-dispute`)
      .set("Authorization", `Bearer ${agentToken}`)
      .send({ role: "BUYER", proposedCount: 1, reason: "Покупатель: передумал про вторую" });
    expect(buyerDispute.status).toBe(201);
    disputeIds.push(buyerDispute.body.id);

    const pending = await request(app)
      .get(`/api/v1/clients/${client.id}/property-count-dispute`)
      .set("Authorization", `Bearer ${agentToken}`);
    expect(pending.body.requests).toHaveLength(2);
    const roles = pending.body.requests.map((r: { role: string }) => r.role).sort();
    expect(roles).toEqual(["BUYER", "SELLER"]);
  });

  it("вторая заявка по той же стороне, пока первая висит — 409", async () => {
    const client = await makeClientWithAiCount("b", 2);
    const first = await request(app)
      .post(`/api/v1/clients/${client.id}/property-count-dispute`)
      .set("Authorization", `Bearer ${agentToken}`)
      .send({ role: "SELLER", proposedCount: 1, reason: "Причина А" });
    disputeIds.push(first.body.id);

    const second = await request(app)
      .post(`/api/v1/clients/${client.id}/property-count-dispute`)
      .set("Authorization", `Bearer ${agentToken}`)
      .send({ role: "SELLER", proposedCount: 0, reason: "Причина Б" });
    expect(second.status).toBe(409);
  });

  it("без числа от ИИ — оспаривать нечего, 409", async () => {
    const client = await prisma.client.create({
      data: {
        fullName: `Продавец без числа ${runId}`,
        phone: `+992974${runId}`,
        source: "PHONE_CALL",
        kind: "SELLER",
        assignedAgentId: agentId,
      },
    });
    clientIds.push(client.id);

    const res = await request(app)
      .post(`/api/v1/clients/${client.id}/property-count-dispute`)
      .set("Authorization", `Bearer ${agentToken}`)
      .send({ role: "SELLER", proposedCount: 1, reason: "Причина" });
    expect(res.status).toBe(409);
  });

  it("руководитель одобряет — число меняется на предложенное агентом", async () => {
    const client = await makeClientWithAiCount("c", 3);
    const created = await request(app)
      .post(`/api/v1/clients/${client.id}/property-count-dispute`)
      .set("Authorization", `Bearer ${agentToken}`)
      .send({ role: "SELLER", proposedCount: 1, reason: "Только одна квартира на самом деле" });
    disputeIds.push(created.body.id);

    const approve = await request(app)
      .post(`/api/v1/clients/property-count-disputes/${created.body.id}/approve`)
      .set("Authorization", `Bearer ${adminToken}`)
      .send({});
    expect(approve.status).toBe(200);

    const updated = await prisma.client.findUnique({ where: { id: client.id } });
    expect(updated?.sellerDeclaredPropertyCount).toBe(1);

    const dispute = await prisma.propertyCountDispute.findUnique({ where: { id: created.body.id } });
    expect(dispute?.status).toBe("APPROVED");
  });

  it("руководитель отклоняет — число ИИ остаётся в силе", async () => {
    const client = await makeClientWithAiCount("d", 3);
    const created = await request(app)
      .post(`/api/v1/clients/${client.id}/property-count-dispute`)
      .set("Authorization", `Bearer ${agentToken}`)
      .send({ role: "SELLER", proposedCount: 1, reason: "Оспариваю" });
    disputeIds.push(created.body.id);

    const reject = await request(app)
      .post(`/api/v1/clients/property-count-disputes/${created.body.id}/reject`)
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ decisionNote: "Проверили запись звонка — ИИ услышал верно, три объекта" });
    expect(reject.status).toBe(200);

    const unchanged = await prisma.client.findUnique({ where: { id: client.id } });
    expect(unchanged?.sellerDeclaredPropertyCount).toBe(3);

    const dispute = await prisma.propertyCountDispute.findUnique({ where: { id: created.body.id } });
    expect(dispute?.status).toBe("REJECTED");
  });

  it("отклонение без decisionNote — 400", async () => {
    const client = await makeClientWithAiCount("e", 2);
    const created = await request(app)
      .post(`/api/v1/clients/${client.id}/property-count-dispute`)
      .set("Authorization", `Bearer ${agentToken}`)
      .send({ role: "SELLER", proposedCount: 1, reason: "Оспариваю" });
    disputeIds.push(created.body.id);

    const reject = await request(app)
      .post(`/api/v1/clients/property-count-disputes/${created.body.id}/reject`)
      .set("Authorization", `Bearer ${adminToken}`)
      .send({});
    expect(reject.status).toBe(400);
  });

  /**
   * Ночная проверка 24.09.2026: клиент, ушедший в Корзину, не должен вечно
   * держать заявку в очереди руководителя, и решение по такой заявке не
   * должно молча править удалённую карточку.
   */
  it("клиент удалён напрямую (например, автосвипом) — заявки нет в очереди, approve/reject дают 404", async () => {
    const client = await makeClientWithAiCount("i", 3);
    const created = await request(app)
      .post(`/api/v1/clients/${client.id}/property-count-dispute`)
      .set("Authorization", `Bearer ${agentToken}`)
      .send({ role: "SELLER", proposedCount: 1, reason: "Оспариваю" });
    expect(created.status).toBe(201);
    disputeIds.push(created.body.id);

    // Уход в Корзину напрямую (не через trashClient) — тот же путь, которым
    // могли раньше пользоваться другие места, и он не должен зависеть от того,
    // кто именно погасил спутники.
    await prisma.client.update({ where: { id: client.id }, data: { deletedAt: new Date() } });

    const queue = await request(app)
      .get("/api/v1/clients/property-count-disputes")
      .set("Authorization", `Bearer ${adminToken}`);
    expect(queue.status).toBe(200);
    expect(queue.body.items.map((r: { id: string }) => r.id)).not.toContain(created.body.id);

    const approve = await request(app)
      .post(`/api/v1/clients/property-count-disputes/${created.body.id}/approve`)
      .set("Authorization", `Bearer ${adminToken}`)
      .send({});
    expect(approve.status).toBe(404);

    const reject = await request(app)
      .post(`/api/v1/clients/property-count-disputes/${created.body.id}/reject`)
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ decisionNote: "Проверено" });
    expect(reject.status).toBe(404);
  });

  it("обычное удаление клиента в Корзину гасит его открытую заявку сама (REJECTED)", async () => {
    const client = await makeClientWithAiCount("j", 3);
    const created = await request(app)
      .post(`/api/v1/clients/${client.id}/property-count-dispute`)
      .set("Authorization", `Bearer ${agentToken}`)
      .send({ role: "SELLER", proposedCount: 1, reason: "Оспариваю" });
    expect(created.status).toBe(201);
    disputeIds.push(created.body.id);

    const del = await request(app)
      .delete(`/api/v1/clients/${client.id}`)
      .set("Authorization", `Bearer ${adminToken}`);
    expect(del.status).toBe(200);

    const dispute = await prisma.propertyCountDispute.findUnique({ where: { id: created.body.id } });
    expect(dispute?.status).toBe("REJECTED");
  });

  it("обычный агент не может решать заявки — 403", async () => {
    const client = await makeClientWithAiCount("f", 2);
    const created = await request(app)
      .post(`/api/v1/clients/${client.id}/property-count-dispute`)
      .set("Authorization", `Bearer ${agentToken}`)
      .send({ role: "SELLER", proposedCount: 1, reason: "Оспариваю" });
    disputeIds.push(created.body.id);

    const approve = await request(app)
      .post(`/api/v1/clients/property-count-disputes/${created.body.id}/approve`)
      .set("Authorization", `Bearer ${agentToken}`)
      .send({});
    expect(approve.status).toBe(403);
  });

  it("статус в очереди — только из известных; чужое слово → 400, а не пустой список (№155)", async () => {
    const bad = await request(app)
      .get("/api/v1/clients/property-count-disputes?status=XYZ")
      .set("Authorization", `Bearer ${adminToken}`);
    expect(bad.status).toBe(400);
    const ok = await request(app)
      .get("/api/v1/clients/property-count-disputes?status=APPROVED")
      .set("Authorization", `Bearer ${adminToken}`);
    expect(ok.status).toBe(200);
  });
});
