import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import request from "supertest";
import { app } from "../src/app.js";
import { prisma } from "../src/db.js";
import { signAccessToken } from "../src/auth/jwt.js";

/**
 * CRM-06 (аудит 04.10.2026): «одобрить» и «отклонить» заявку на удаление читали
 * PENDING, а писали решение без условия по статусу. Клиент (объект) уходил в
 * Корзину, а заявка показывала отказ, или наоборот. Гонка воспроизводится подставной
 * задержкой: сразу после чтения заявки тест сам выносит «конкурирующее» решение.
 * То же в routes/properties/deleteRequests.ts.
 */
const runId = Date.now();
let adminId = "";
let agentId = "";
let token = "";
let districtId = "";
const clientIds: string[] = [];
const propertyIds: string[] = [];

beforeAll(async () => {
  adminId = (await prisma.agent.create({ data: { fullName: `Админ гонки ${runId}`, phone: `+992927${String(runId).slice(-8)}`, role: "ADMIN", passwordHash: "x" } })).id;
  agentId = (await prisma.agent.create({ data: { fullName: `Агент гонки ${runId}`, phone: `+992926${String(runId).slice(-8)}`, role: "AGENT", passwordHash: "x" } })).id;
  token = signAccessToken({ sub: adminId, role: "ADMIN" });
  districtId = (await prisma.district.create({ data: { name: `Район гонки заявок ${runId}` } })).id;
});

afterEach(() => {
  vi.restoreAllMocks();
});

afterAll(async () => {
  await prisma.clientDeleteRequest.deleteMany({ where: { clientId: { in: clientIds } } });
  await prisma.propertyDeleteRequest.deleteMany({ where: { propertyId: { in: propertyIds } } });
  await prisma.interaction.deleteMany({ where: { clientId: { in: clientIds } } });
  await prisma.client.deleteMany({ where: { id: { in: clientIds } } });
  await prisma.property.deleteMany({ where: { id: { in: propertyIds } } });
  await prisma.agent.deleteMany({ where: { id: { in: [adminId, agentId] } } });
  await prisma.district.deleteMany({ where: { id: districtId } });
  await prisma.$disconnect();
});

async function clientRequest() {
  const client = await prisma.client.create({
    data: { fullName: `Клиент гонки заявки ${runId}-${clientIds.length}`, phone: `+99292${clientIds.length}${runId}`, source: "PHONE_CALL", assignedAgentId: agentId, acceptedAt: new Date() },
  });
  clientIds.push(client.id);
  const req = await prisma.clientDeleteRequest.create({ data: { clientId: client.id, requestedById: agentId, reason: "OTHER", comment: "тест" } });
  return { client, req };
}

async function propertyRequest() {
  const property = await prisma.property.create({
    data: { title: `Объект гонки заявки ${runId}-${propertyIds.length}`, type: "APARTMENT", areaSqm: 50, price: 50000, currency: "USD", districtId, address: `Тест ${runId}`, condition: "GOOD", status: "AVAILABLE", assignedAgentId: agentId },
  });
  propertyIds.push(property.id);
  const req = await prisma.propertyDeleteRequest.create({ data: { propertyId: property.id, requestedById: agentId, reason: "TEST_CARD", comment: "тест" } });
  return { property, req };
}

/** После чтения заявки маршрутом выполняет `competitor` и отдаёт маршруту СТАРУЮ строку. */
function raceAfterRead(delegate: { findUnique: (...a: never[]) => Promise<unknown> }, competitor: () => Promise<unknown>) {
  const real = (delegate.findUnique as (...a: unknown[]) => Promise<unknown>).bind(delegate);
  vi.spyOn(delegate as never, "findUnique").mockImplementation(((args: unknown) =>
    real(args).then(async (row) => {
      await competitor();
      return row;
    })) as never);
}

describe("заявка на удаление клиента: решение берётся атомарно (CRM-06)", () => {
  it("одобрение, проигравшее отказу, отвечает 409 и клиента не удаляет", async () => {
    const { client, req } = await clientRequest();
    raceAfterRead(prisma.clientDeleteRequest as never, () =>
      prisma.clientDeleteRequest.update({ where: { id: req.id }, data: { status: "REJECTED", decidedById: adminId, decidedAt: new Date(), decisionNote: "нет" } })
    );
    const res = await request(app).post(`/api/v1/clients/delete-requests/${req.id}/approve`).set("Authorization", `Bearer ${token}`).send({});
    expect(res.status).toBe(409);
    const after = await prisma.client.findUniqueOrThrow({ where: { id: client.id } });
    expect(after.deletedAt).toBeNull();
    expect((await prisma.clientDeleteRequest.findUniqueOrThrow({ where: { id: req.id } })).status).toBe("REJECTED");
  });

  it("отказ, проигравший одобрению, отвечает 409 и не переписывает решение", async () => {
    const { req } = await clientRequest();
    raceAfterRead(prisma.clientDeleteRequest as never, () =>
      prisma.clientDeleteRequest.update({ where: { id: req.id }, data: { status: "APPROVED", decidedById: adminId, decidedAt: new Date() } })
    );
    const res = await request(app)
      .post(`/api/v1/clients/delete-requests/${req.id}/reject`)
      .set("Authorization", `Bearer ${token}`)
      .send({ decisionNote: "не согласен" });
    expect(res.status).toBe(409);
    expect((await prisma.clientDeleteRequest.findUniqueOrThrow({ where: { id: req.id } })).status).toBe("APPROVED");
  });

  it("одиночное одобрение работает как раньше: клиент в Корзине, заявка APPROVED с заметкой", async () => {
    const { client, req } = await clientRequest();
    const res = await request(app)
      .post(`/api/v1/clients/delete-requests/${req.id}/approve`)
      .set("Authorization", `Bearer ${token}`)
      .send({ decisionNote: "согласен" });
    expect(res.status).toBe(200);
    expect((await prisma.client.findUniqueOrThrow({ where: { id: client.id } })).deletedAt).not.toBeNull();
    const after = await prisma.clientDeleteRequest.findUniqueOrThrow({ where: { id: req.id } });
    expect(after.status).toBe("APPROVED");
    expect(after.decisionNote).toBe("согласен");
    expect(after.decidedById).toBe(adminId);
  });
});

describe("заявка на удаление объекта: то же (CRM-06, расширение)", () => {
  it("одобрение, проигравшее отказу, отвечает 409 и объект не удаляет", async () => {
    const { property, req } = await propertyRequest();
    raceAfterRead(prisma.propertyDeleteRequest as never, () =>
      prisma.propertyDeleteRequest.update({ where: { id: req.id }, data: { status: "REJECTED", decidedById: adminId, decidedAt: new Date(), decisionNote: "нет" } })
    );
    const res = await request(app).post(`/api/v1/properties/delete-requests/${req.id}/approve`).set("Authorization", `Bearer ${token}`).send({});
    expect(res.status).toBe(409);
    expect((await prisma.property.findUniqueOrThrow({ where: { id: property.id } })).deletedAt).toBeNull();
    expect((await prisma.propertyDeleteRequest.findUniqueOrThrow({ where: { id: req.id } })).status).toBe("REJECTED");
  });

  it("отказ, проигравший одобрению, отвечает 409 и не переписывает решение", async () => {
    const { req } = await propertyRequest();
    raceAfterRead(prisma.propertyDeleteRequest as never, () =>
      prisma.propertyDeleteRequest.update({ where: { id: req.id }, data: { status: "APPROVED", decidedById: adminId, decidedAt: new Date() } })
    );
    const res = await request(app)
      .post(`/api/v1/properties/delete-requests/${req.id}/reject`)
      .set("Authorization", `Bearer ${token}`)
      .send({ decisionNote: "не согласен" });
    expect(res.status).toBe(409);
    expect((await prisma.propertyDeleteRequest.findUniqueOrThrow({ where: { id: req.id } })).status).toBe("APPROVED");
  });
});
