import { afterAll, beforeAll, describe, expect, it } from "vitest";
import bcrypt from "bcrypt";
import request from "supertest";
import { app } from "../src/app.js";
import { prisma } from "../src/db.js";
import { grantElevation } from "../src/lib/stepUp.js";
import { createDealDocument, listDealDocuments } from "../src/lib/dealDocumentsDb.js";

/**
 * Документы отправленной/закрытой сделки агент не удаляет, а «Одобрить»
 * перепроверяет чек-лист (глубокая проверка 02.10.2026, C5).
 *
 * Раньше: агент отправил сделку с договором и свидетельством, потом удалил
 * оба (у DELETE не было проверки стадии) — директор жмёт «Одобрить», сделка
 * закрыта, деньги начислены, юридического подтверждения в CRM нет.
 */

const runId = Date.now();
const password = "testpass123";

let districtId = "";
let directorId = "";
let agentId = "";
let directorToken = "";
let agentToken = "";
const clientIds: string[] = [];
const propertyIds: string[] = [];
const dealIds: string[] = [];

async function makeDeal(stage: "PENDING_APPROVAL" | "COMPLETED" | "NEGOTIATION") {
  const client = await prisma.client.create({
    data: {
      fullName: `Клиент док-замок ${runId}-${clientIds.length}`,
      phone: `+992947${clientIds.length}${runId}`,
      source: "PHONE_CALL",
      assignedAgentId: agentId,
      acceptedAt: new Date(),
    },
  });
  clientIds.push(client.id);
  const property = await prisma.property.create({
    data: {
      title: `Объект док-замок ${runId}-${propertyIds.length}`,
      type: "APARTMENT",
      areaSqm: 50,
      price: 100000,
      currency: "TJS",
      districtId,
      address: "Тестовая, док-замок",
      condition: "GOOD",
      status: "RESERVED",
      reservedAt: new Date(),
      assignedAgentId: agentId,
    },
  });
  propertyIds.push(property.id);
  await prisma.interaction.create({
    data: { clientId: client.id, propertyId: property.id, agentId, type: "SHOWING", notes: "Показ проведён", completedAt: new Date() },
  });
  const deal = await prisma.deal.create({
    data: {
      clientId: client.id,
      propertyId: property.id,
      agentId,
      stage,
      soldPrice: 100000,
      commissionAmount: 2000,
      commissionRealtorAmount: 1000,
      commissionCompanyAmount: 1000,
      currency: "TJS",
      closedAt: stage === "COMPLETED" ? new Date() : null,
    },
  });
  dealIds.push(deal.id);
  return deal.id;
}

async function addDoc(dealId: string, kind: "OWNERSHIP" | "CONTRACT") {
  return createDealDocument({
    dealId,
    kind,
    fileName: `nonexistent-${runId}-${kind}.pdf`,
    originalName: `${kind}.pdf`,
    mimeType: "application/pdf",
    uploadedById: agentId,
  });
}

beforeAll(async () => {
  const passwordHash = await bcrypt.hash(password, 10);
  districtId = (await prisma.district.create({ data: { name: `Тест-район-док-замок-${runId}` } })).id;
  const director = await prisma.agent.create({
    data: { fullName: "Директор док-замок", phone: `+992948${runId}`, role: "DIRECTOR", passwordHash },
  });
  directorId = director.id;
  const agent = await prisma.agent.create({
    data: { fullName: "Агент док-замок", phone: `+992949${runId}`, role: "AGENT", passwordHash },
  });
  agentId = agent.id;
  const d = await request(app).post("/api/v1/auth/login").send({ phone: director.phone, password });
  grantElevation(directorId);
  directorToken = d.body.accessToken as string;
  const a = await request(app).post("/api/v1/auth/login").send({ phone: agent.phone, password });
  agentToken = a.body.accessToken as string;
  await prisma.$executeRaw`UPDATE "Settings" SET "dealRequiredDocuments" = ARRAY['OWNERSHIP','CONTRACT']::TEXT[] WHERE "id" = 'singleton'`;
});

afterAll(async () => {
  await prisma.$executeRaw`UPDATE "Settings" SET "dealRequiredDocuments" = ARRAY[]::TEXT[] WHERE "id" = 'singleton'`;
  await prisma.$executeRaw`DELETE FROM "DealDocument" WHERE "dealId" = ANY(${dealIds})`;
  await prisma.deal.deleteMany({ where: { id: { in: dealIds } } });
  await prisma.interaction.deleteMany({ where: { clientId: { in: clientIds } } });
  await prisma.client.deleteMany({ where: { id: { in: clientIds } } });
  await prisma.property.deleteMany({ where: { id: { in: propertyIds } } });
  await prisma.agent.deleteMany({ where: { id: { in: [directorId, agentId] } } });
  await prisma.district.deleteMany({ where: { id: districtId } });
});

describe("C5: документы отправленной и закрытой сделки", () => {
  it("агент не удаляет документ сделки, которая ждёт одобрения или закрыта", async () => {
    for (const stage of ["PENDING_APPROVAL", "COMPLETED"] as const) {
      const dealId = await makeDeal(stage);
      const doc = await addDoc(dealId, "CONTRACT");
      const res = await request(app)
        .delete(`/api/v1/deals/${dealId}/documents/${doc.id}`)
        .set("Authorization", `Bearer ${agentToken}`);
      expect(res.status, stage).toBe(409);
      expect((await listDealDocuments(dealId)).length, stage).toBe(1);
    }
  });

  it("на рабочей стадии агент удаляет свой документ как раньше; руководитель — на любой", async () => {
    const working = await makeDeal("NEGOTIATION");
    const doc = await addDoc(working, "CONTRACT");
    const res = await request(app)
      .delete(`/api/v1/deals/${working}/documents/${doc.id}`)
      .set("Authorization", `Bearer ${agentToken}`);
    expect(res.status).toBe(204);

    const pending = await makeDeal("PENDING_APPROVAL");
    const pendingDoc = await addDoc(pending, "CONTRACT");
    const byDirector = await request(app)
      .delete(`/api/v1/deals/${pending}/documents/${pendingDoc.id}`)
      .set("Authorization", `Bearer ${directorToken}`);
    expect(byDirector.status).toBe(204);
  });

  it("«Одобрить» перепроверяет чек-лист: без договора сделка не закрывается", async () => {
    const dealId = await makeDeal("PENDING_APPROVAL");
    await addDoc(dealId, "OWNERSHIP");
    const res = await request(app)
      .patch(`/api/v1/deals/${dealId}`)
      .set("Authorization", `Bearer ${directorToken}`)
      .send({ stage: "COMPLETED" });
    expect(res.status).toBe(400);
    expect(res.body.missingDocumentKinds).toEqual(["CONTRACT"]);
    expect((await prisma.deal.findUnique({ where: { id: dealId } }))?.stage).toBe("PENDING_APPROVAL");

    await addDoc(dealId, "CONTRACT");
    const ok = await request(app)
      .patch(`/api/v1/deals/${dealId}`)
      .set("Authorization", `Bearer ${directorToken}`)
      .send({ stage: "COMPLETED" });
    expect(ok.status).toBe(200);
  });
});
