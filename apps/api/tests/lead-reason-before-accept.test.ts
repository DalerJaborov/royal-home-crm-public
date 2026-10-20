import { afterAll, beforeAll, describe, expect, it } from "vitest";
import bcrypt from "bcrypt";
import request from "supertest";
import { app } from "../src/app.js";
import { prisma } from "../src/db.js";
import { leadReasonText } from "../src/lib/leadReason.js";

/**
 * «Почему лид ваш» до принятия (23.09.2026, lib/leadReason.ts).
 *
 * Распределение отдаёт лид агенту объекта, о котором спрашивал клиент, но
 * экраны принятия этого не показывали: агент принимал вслепую. Проверяется:
 * (1) строка собирается по причине и объекту, удалённый объект без ссылки;
 * (2) список «Ждут принятия» и карточка отдают её своему непринятому лиду,
 * при этом гейт «до приёма только имя» по-прежнему прячет бюджет.
 */

const runId = Date.now();
const password = "testpass123";

let agentId = "";
let districtId = "";
let propertyId = "";
let propertyShortId = 0;
let clientId = "";
let clientShortId = 0;
let token = "";

beforeAll(async () => {
  const passwordHash = await bcrypt.hash(password, 10);
  const agent = await prisma.agent.create({
    data: { fullName: `Причина Агент ${runId}`, phone: `+992961${String(runId).slice(-7)}`, role: "AGENT", passwordHash },
  });
  agentId = agent.id;
  districtId = (await prisma.district.create({ data: { name: `Причина-район-${runId}` } })).id;
  const property = await prisma.property.create({
    data: {
      title: `Причина-объект-${runId}`,
      type: "APARTMENT",
      areaSqm: 50,
      price: 40000,
      currency: "USD",
      districtId,
      address: "Тестовая, 1",
      condition: "GOOD",
      assignedAgentId: agentId,
      ownerContact: "+992900000099",
    },
  });
  propertyId = property.id;
  propertyShortId = property.shortId;
  const client = await prisma.client.create({
    data: {
      fullName: `Причина Клиент ${runId}`,
      phone: `+992962${String(runId).slice(-7)}`,
      source: "INSTAGRAM",
      kind: "BUYER",
      budgetMax: 50000,
      assignedAgentId: agentId,
      assignedAt: new Date(),
      acceptedAt: null,
      assignReason: "own_property_explicit",
      matchedPropertyId: propertyId,
    },
  });
  clientId = client.id;
  clientShortId = client.shortId;

  const login = await request(app).post("/api/v1/auth/login").send({ phone: agent.phone, password });
  expect(login.status).toBe(200);
  token = login.body.accessToken as string;
});

afterAll(async () => {
  await prisma.client.deleteMany({ where: { id: clientId } });
  await prisma.property.deleteMany({ where: { id: propertyId } });
  await prisma.district.deleteMany({ where: { id: districtId } });
  await prisma.agent.deleteMany({ where: { id: agentId } });
});

describe("leadReasonText", () => {
  const property = { shortId: 12, title: "1-комн · Сино", deletedAt: null };

  it("объект назван: номер и название, со ссылкой", () => {
    expect(leadReasonText({ assignReason: "own_property_explicit", matchedPropertyId: "p" }, property)).toEqual({
      text: "Спрашивал про ваш объект №12 «1-комн · Сино»",
      propertyShortId: 12,
    });
  });

  it("удалённый объект — без ссылки и с пометкой", () => {
    const r = leadReasonText({ assignReason: "instagram_post_link", matchedPropertyId: "p" }, { ...property, deletedAt: new Date() });
    expect(r?.propertyShortId).toBeNull();
    expect(r?.text).toContain("(объект удалён)");
  });

  it("клиент назвал сотрудника — без объекта", () => {
    expect(leadReasonText({ assignReason: "requested_by_client", matchedPropertyId: null }, null)?.text).toBe(
      "Клиент сам назвал вас"
    );
  });

  it("обычная очередь — строки нет", () => {
    expect(leadReasonText({ assignReason: "queue", matchedPropertyId: null }, null)).toBeNull();
    expect(leadReasonText({ assignReason: null, matchedPropertyId: null }, null)).toBeNull();
  });
});

describe("экраны принятия получают причину", () => {
  it("список «Ждут принятия»: строка есть, бюджет по-прежнему закрыт", async () => {
    const res = await request(app)
      .get("/api/v1/clients?pendingAcceptance=1&pageSize=20")
      .set("Authorization", `Bearer ${token}`);
    expect(res.status).toBe(200);
    const row = (res.body.items as { id: string; leadReason: unknown; budgetMax: unknown }[]).find((c) => c.id === clientId);
    expect(row?.leadReason).toEqual({
      text: `Спрашивал про ваш объект №${propertyShortId} «Причина-объект-${runId}»`,
      propertyShortId,
    });
    expect(row?.budgetMax).toBeNull();
  });

  it("карточка до приёма: та же строка", async () => {
    const res = await request(app).get(`/api/v1/clients/${clientShortId}`).set("Authorization", `Bearer ${token}`);
    expect(res.status).toBe(200);
    expect(res.body.leadReason?.propertyShortId).toBe(propertyShortId);
    expect(res.body.budgetMax).toBeNull();
  });
});
