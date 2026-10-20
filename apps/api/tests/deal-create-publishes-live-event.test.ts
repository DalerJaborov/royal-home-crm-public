import { afterAll, beforeAll, describe, expect, it } from "vitest";
import bcrypt from "bcrypt";
import request from "supertest";
import { app } from "../src/app.js";
import { prisma } from "../src/db.js";
import { waitFor } from "./helpers/waitFor.js";

/**
 * НОЧНОЙ АУДИТ 24.09.2026 (№11): `publishDealUpdated` в routes/deals.ts звучал
 * только из PATCH (смена этапа) — POST / (создание сделки) коммитил транзакцию
 * и на этом останавливался. Руководитель, у которого открыта доска сделок,
 * узнавал о новой сделке только через общий таймер (60 с), а не сразу.
 *
 * Публикация — `void`-запись в фоне (см. lib/eventBus.ts::publish), поэтому
 * читаем через waitFor, а не сразу после ответа.
 */

const runId = Date.now();
const password = "testpass123";

let districtId = "";
let agentId = "";
let buyerId = "";
let propertyId = "";
let token = "";
/** Заполняется внутри теста — используется для точечной уборки в afterAll. */
let createdDealId = "";

beforeAll(async () => {
  const passwordHash = await bcrypt.hash(password, 10);
  districtId = (await prisma.district.create({ data: { name: `Сделка-событие-${runId}` } })).id;
  const agent = await prisma.agent.create({
    data: { fullName: `Агент События ${runId}`, phone: `+992958${String(runId).slice(-7)}`, role: "AGENT", passwordHash },
  });
  agentId = agent.id;

  const buyer = await prisma.client.create({
    data: {
      fullName: `Покупатель События ${runId}`,
      phone: `+992959${String(runId).slice(-7)}`,
      source: "PHONE_CALL",
      kind: "BUYER",
      assignedAgentId: agent.id,
      acceptedAt: new Date(),
    },
  });
  buyerId = buyer.id;

  const property = await prisma.property.create({
    data: {
      title: `Объект для события ${runId}`,
      type: "APARTMENT",
      areaSqm: 55,
      price: 90000,
      currency: "USD",
      districtId,
      address: `Тест события ${runId}`,
      condition: "GOOD",
      status: "AVAILABLE",
    },
  });
  propertyId = property.id;

  const login = await request(app).post("/api/v1/auth/login").send({ phone: agent.phone, password });
  token = login.body.accessToken;
});

afterAll(async () => {
  if (createdDealId) {
    await prisma.liveEventOutbox.deleteMany({
      where: { type: "deal.updated", payload: { path: ["dealId"], equals: createdDealId } },
    });
  }
  await prisma.deal.deleteMany({ where: { clientId: buyerId } });
  await prisma.property.deleteMany({ where: { id: propertyId } });
  await prisma.client.deleteMany({ where: { id: buyerId } });
  await prisma.agent.deleteMany({ where: { id: agentId } });
  await prisma.district.deleteMany({ where: { id: districtId } });
});

describe("POST /deals публикует живое событие (ночной аудит 24.09.2026, №11)", () => {
  it("после создания сделки в LiveEventOutbox появляется deal.updated с её id", async () => {
    const res = await request(app)
      .post("/api/v1/deals")
      .set("Authorization", `Bearer ${token}`)
      .send({ clientId: buyerId, propertyId });

    expect(res.status).toBe(201);
    const dealId = res.body.id as string;
    createdDealId = dealId;

    const row = await waitFor(
      () =>
        prisma.liveEventOutbox.findFirst({
          where: { type: "deal.updated", payload: { path: ["dealId"], equals: dealId } },
        }),
      { label: `запись deal.updated для сделки ${dealId}` }
    );

    expect(row?.type).toBe("deal.updated");
    expect((row?.payload as { dealId?: string } | null)?.dealId).toBe(dealId);
  });
});
