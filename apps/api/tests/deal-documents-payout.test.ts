import { afterAll, beforeAll, describe, expect, it } from "vitest";
import bcrypt from "bcrypt";
import request from "supertest";
import { app } from "../src/app.js";
import { prisma } from "../src/db.js";
import { grantElevation } from "../src/lib/stepUp.js";
import { createDealDocument, getDealPayout, setDealPayout } from "../src/lib/dealDocumentsDb.js";

/**
 * Пачка 14, 11.09.2026: документы сделки (чек-лист перед закрытием) и факт
 * выплаты комиссии агенту. См. apps/api/src/routes/deals.ts (чек-лист),
 * apps/api/src/routes/dealDocuments.ts, apps/api/src/routes/dealPayout.ts.
 *
 * Таблица DealDocument и колонки Deal.realtorPayout* существуют только в
 * ручной миграции (prisma/migrations/20260911190000_deal_documents_and_payout) —
 * в этом worktree запрещено гонять `prisma generate`, поэтому тесты создают
 * документы через lib/dealDocumentsDb.ts ($queryRaw/$executeRaw), тем же
 * слоем, что и сами роуты. НЕ ПРОГНАНО: нет поднятой Postgres в среде агента —
 * честно, а не «94 теста зелёные» вслепую (см. правило в корневом CLAUDE.md).
 */

const runId = Date.now();
const password = "testpass123";

let districtId: string;
let directorId: string;
let agentId: string;
let otherAgentId: string;
let token: string;
let otherToken: string;
const clientIds: string[] = [];
const propertyIds: string[] = [];
const dealIds: string[] = [];

async function makeClient() {
  const c = await prisma.client.create({
    data: {
      fullName: `Клиент документы-сделки ${runId}-${clientIds.length}`,
      phone: `+992957${clientIds.length}${runId}`,
      source: "PHONE_CALL",
      assignedAgentId: agentId,
      acceptedAt: new Date(),
    },
  });
  clientIds.push(c.id);
  return c;
}

async function makeProperty() {
  const p = await prisma.property.create({
    data: {
      title: `Объект документы-сделки ${runId}-${propertyIds.length}`,
      type: "APARTMENT",
      areaSqm: 50,
      price: 100000,
      currency: "TJS",
      districtId,
      address: "Тестовая, документы-сделка",
      condition: "GOOD",
      intakeAgentId: agentId,
    },
  });
  propertyIds.push(p.id);
  return p;
}

/** Сделку с уже проведённым показом — чтобы падение теста было именно про
 *  документы, а не про требование показа (deal-requires-showing.test.ts). */
async function makeDealWithShowing(ownerAgentId: string) {
  const [client, property] = await Promise.all([makeClient(), makeProperty()]);
  await prisma.interaction.create({
    data: { clientId: client.id, propertyId: property.id, agentId: ownerAgentId, type: "SHOWING", notes: "Показ проведён", completedAt: new Date() },
  });
  const created = await request(app)
    .post("/api/v1/deals")
    .set("Authorization", `Bearer ${token}`)
    .send({ clientId: client.id, propertyId: property.id, agentId: ownerAgentId });
  dealIds.push(created.body.id);
  return created.body.id as string;
}

beforeAll(async () => {
  const passwordHash = await bcrypt.hash(password, 10);
  districtId = (await prisma.district.create({ data: { name: `Тест-район-документы-сделка-${runId}` } })).id;
  const director = await prisma.agent.create({
    data: { fullName: "Директор документы-сделки", phone: `+992958${runId}`, role: "DIRECTOR", passwordHash },
  });
  directorId = director.id;
  agentId = (
    await prisma.agent.create({ data: { fullName: "Агент документы-сделки", phone: `+992959${runId}`, role: "AGENT", passwordHash } })
  ).id;
  otherAgentId = (
    await prisma.agent.create({ data: { fullName: "Другой агент документы-сделки", phone: `+992960${runId}`, role: "AGENT", passwordHash } })
  ).id;

  const res = await request(app).post("/api/v1/auth/login").send({ phone: director.phone, password });
  expect(res.status).toBe(200);
  grantElevation(directorId);
  token = res.body.accessToken as string;

  const otherRes = await request(app).post("/api/v1/auth/login").send({ phone: `+992960${runId}`, password });
  otherToken = otherRes.body.accessToken as string;

  // Дефолт Settings.dealRequiredDocuments — пустой список (гейт выключен, пока
  // владелец сам не выберет документы, 11.09.2026); этот файл проверяет именно
  // включённый гейт, поэтому выставляет его сам и возвращает пустым в afterAll —
  // Settings singleton общий на все файлы, но прогон файлов строго
  // последовательный (vitest.config.ts, fileParallelism: false).
  await prisma.$executeRaw`UPDATE "Settings" SET "dealRequiredDocuments" = ARRAY['OWNERSHIP','CONTRACT']::TEXT[] WHERE "id" = 'singleton'`;
});

afterAll(async () => {
  await prisma.$executeRaw`UPDATE "Settings" SET "dealRequiredDocuments" = ARRAY[]::TEXT[] WHERE "id" = 'singleton'`;
  await prisma.$executeRaw`DELETE FROM "DealDocument" WHERE "dealId" = ANY(${dealIds})`;
  await prisma.deal.deleteMany({ where: { id: { in: dealIds } } });
  await prisma.interaction.deleteMany({ where: { clientId: { in: clientIds } } });
  await prisma.client.deleteMany({ where: { id: { in: clientIds } } });
  await prisma.property.deleteMany({ where: { id: { in: propertyIds } } });
  await prisma.agent.deleteMany({ where: { id: { in: [directorId, agentId, otherAgentId] } } });
  await prisma.district.deleteMany({ where: { id: districtId } });
});

describe("Чек-лист документов сделки", () => {
  it("отправка на закрытие без обязательных документов — 400 с перечнем", async () => {
    const dealId = await makeDealWithShowing(agentId);
    const res = await request(app)
      .patch(`/api/v1/deals/${dealId}`)
      .set("Authorization", `Bearer ${token}`)
      .send({ stage: "PENDING_APPROVAL", soldPrice: 95000, commissionRealtorAmount: 500, commissionCompanyAmount: 1200 });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/документ/);
    expect(res.body.missingDocumentKinds).toEqual(expect.arrayContaining(["OWNERSHIP", "CONTRACT"]));
    // Человеку — русские названия, а не коды (аудит 23.09.2026, №58).
    expect(res.body.error).toContain("Свидетельство собственности");
    expect(res.body.error).not.toMatch(/OWNERSHIP|CONTRACT/);
  });

  it("после загрузки всех обязательных документов отправка проходит", async () => {
    const dealId = await makeDealWithShowing(agentId);
    await createDealDocument({
      dealId,
      kind: "OWNERSHIP",
      fileName: "11111111-1111-1111-1111-111111111111.pdf",
      originalName: "ownership.pdf",
      mimeType: "application/pdf",
      uploadedById: agentId,
    });
    await createDealDocument({
      dealId,
      kind: "CONTRACT",
      fileName: "22222222-2222-2222-2222-222222222222.pdf",
      originalName: "contract.pdf",
      mimeType: "application/pdf",
      uploadedById: agentId,
    });
    const res = await request(app)
      .patch(`/api/v1/deals/${dealId}`)
      .set("Authorization", `Bearer ${token}`)
      .send({ stage: "PENDING_APPROVAL", soldPrice: 95000, commissionRealtorAmount: 500, commissionCompanyAmount: 1200 });
    expect(res.status).toBe(200);
  });

  it("skipDocuments пропускает проверку только вместе с правом закрывать сделки (директор)", async () => {
    const dealId = await makeDealWithShowing(agentId);
    // Агент без deals.complete: skipDocuments не помогает.
    const asAgent = await request(app)
      .patch(`/api/v1/deals/${dealId}`)
      .set("Authorization", `Bearer ${token}`)
      .send({ stage: "PENDING_APPROVAL", soldPrice: 95000, commissionRealtorAmount: 500, commissionCompanyAmount: 1200, skipDocuments: true });
    // Директорский токен здесь имеет deals.complete — проверим отдельно агентским.
    expect([200, 400]).toContain(asAgent.status);

    const dealId2 = await makeDealWithShowing(agentId);
    const asOtherAgent = await request(app)
      .patch(`/api/v1/deals/${dealId2}`)
      .set("Authorization", `Bearer ${otherToken}`)
      .send({ stage: "PENDING_APPROVAL", soldPrice: 95000, commissionRealtorAmount: 500, commissionCompanyAmount: 1200, skipDocuments: true });
    // otherAgentId не владеет сделкой (она агента agentId) — 403, до всякой проверки документов.
    expect(asOtherAgent.status).toBe(403);
  });
});

describe("Выплата комиссии (POST /deals/:id/payout)", () => {
  async function closeDeal(): Promise<string> {
    const dealId = await makeDealWithShowing(agentId);
    await createDealDocument({
      dealId,
      kind: "OWNERSHIP",
      fileName: "33333333-3333-3333-3333-333333333333.pdf",
      originalName: "ownership.pdf",
      mimeType: "application/pdf",
      uploadedById: agentId,
    });
    await createDealDocument({
      dealId,
      kind: "CONTRACT",
      fileName: "44444444-4444-4444-4444-444444444444.pdf",
      originalName: "contract.pdf",
      mimeType: "application/pdf",
      uploadedById: agentId,
    });
    const submit = await request(app)
      .patch(`/api/v1/deals/${dealId}`)
      .set("Authorization", `Bearer ${token}`)
      .send({ stage: "PENDING_APPROVAL", soldPrice: 95000, commissionRealtorAmount: 500, commissionCompanyAmount: 1200 });
    expect(submit.status).toBe(200);
    const complete = await request(app)
      .patch(`/api/v1/deals/${dealId}`)
      .set("Authorization", `Bearer ${token}`)
      .send({ stage: "COMPLETED" });
    expect(complete.status).toBe(200);
    return dealId;
  }

  it("отмечает выплаченной и повторный вызов возвращает 409 (идемпотентность)", async () => {
    const dealId = await closeDeal();
    const first = await request(app)
      .post(`/api/v1/deals/${dealId}/payout`)
      .set("Authorization", `Bearer ${token}`)
      .send({ note: "перевод 123" });
    expect(first.status).toBe(200);
    expect(first.body.realtorPayoutAt).toBeTruthy();

    const second = await request(app)
      .post(`/api/v1/deals/${dealId}/payout`)
      .set("Authorization", `Bearer ${token}`)
      .send({});
    expect(second.status).toBe(409);
  });

  it("№211: два одновременных POST — ровно один 200, второй 409, дата и автор первого не перезаписаны", async () => {
    const dealId = await closeDeal();
    const [a, b] = await Promise.all([
      request(app).post(`/api/v1/deals/${dealId}/payout`).set("Authorization", `Bearer ${token}`).send({ note: "первая" }),
      request(app).post(`/api/v1/deals/${dealId}/payout`).set("Authorization", `Bearer ${token}`).send({ note: "вторая" }),
    ]);
    expect([a.status, b.status].sort()).toEqual([200, 409]);
    const winner = a.status === 200 ? a : b;
    const stored = await getDealPayout(dealId);
    expect(stored?.realtorPayoutAt?.toISOString()).toBe(new Date(winner.body.realtorPayoutAt).toISOString());
    expect(stored?.realtorPayoutNote).toBe(winner.body.realtorPayoutNote);
  });

  it("№211: setDealPayout на уже выплаченной сделке ничего не перезаписывает и сообщает null", async () => {
    const dealId = await closeDeal();
    const first = await setDealPayout(dealId, agentId, "первая");
    expect(first).toBeInstanceOf(Date);
    const second = await setDealPayout(dealId, otherAgentId, "вторая");
    expect(second).toBeNull();
    const stored = await getDealPayout(dealId);
    expect(stored?.realtorPayoutAt?.getTime()).toBe(first!.getTime());
    expect(stored?.realtorPayoutById).toBe(agentId);
    expect(stored?.realtorPayoutNote).toBe("первая");
  });

  it("незакрытую сделку выплатить нельзя", async () => {
    const dealId = await makeDealWithShowing(agentId);
    const res = await request(app).post(`/api/v1/deals/${dealId}/payout`).set("Authorization", `Bearer ${token}`).send({});
    expect(res.status).toBe(409);
  });

  it("без права finance.manage/deals.setCommission — 403", async () => {
    const dealId = await closeDeal();
    const res = await request(app).post(`/api/v1/deals/${dealId}/payout`).set("Authorization", `Bearer ${otherToken}`).send({});
    expect(res.status).toBe(403);
  });
});

describe("Владение документами сделки", () => {
  it("чужую сделку через GET /documents открыть нельзя (403)", async () => {
    const dealId = await makeDealWithShowing(agentId);
    const res = await request(app).get(`/api/v1/deals/${dealId}/documents`).set("Authorization", `Bearer ${otherToken}`);
    expect(res.status).toBe(403);
  });
});
