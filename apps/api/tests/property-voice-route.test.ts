import { afterAll, beforeAll, describe, expect, it } from "vitest";
import bcrypt from "bcrypt";
import request from "supertest";
import { app } from "../src/app.js";
import { prisma } from "../src/db.js";

/**
 * GET /properties/:id/voice — права. Агент получает «голос рынка» без раздела
 * showingFeedback (звонки-опросы покупателей после показа по замыслу скрыты от
 * агентов); директор — с ним. Без токена — 401, несуществующий объект — 404.
 */

const runId = Date.now();
const password = "testpass123";

let districtId = "";
let agentId = "";
let directorId = "";
let propertyId = "";
let propertyShortId = 0;
let agentToken = "";
let directorToken = "";

beforeAll(async () => {
  const passwordHash = await bcrypt.hash(password, 10);
  districtId = (await prisma.district.create({ data: { name: `Тест-район-голос-${runId}` } })).id;
  agentId = (
    await prisma.agent.create({ data: { fullName: "Агент голос", phone: `+992957${runId}`, role: "AGENT", passwordHash } })
  ).id;
  directorId = (
    await prisma.agent.create({ data: { fullName: "Директор голос", phone: `+992958${runId}`, role: "DIRECTOR", passwordHash } })
  ).id;
  const property = await prisma.property.create({
    data: {
      title: `Объект голоса ${runId}`,
      type: "APARTMENT",
      areaSqm: 55,
      rooms: 2,
      price: 400_000,
      currency: "TJS",
      districtId,
      address: "Тестовая, 9",
      condition: "GOOD",
      status: "AVAILABLE",
      assignedAgentId: agentId,
    },
  });
  propertyId = property.id;
  propertyShortId = property.shortId;
  await prisma.showingSurveyCall.create({
    data: {
      interactionId: `route-survey-${runId}`,
      clientId: `route-client-${runId}`,
      agentId,
      propertyId,
      redFlags: [{ category: "agent_rude", detail: "грубил" }],
    },
  });
  const login = async (phone: string) => {
    const res = await request(app).post("/api/v1/auth/login").send({ phone, password });
    expect(res.status).toBe(200);
    return res.body.accessToken as string;
  };
  agentToken = await login(`+992957${runId}`);
  directorToken = await login(`+992958${runId}`);
});

afterAll(async () => {
  await prisma.showingSurveyCall.deleteMany({ where: { propertyId } });
  await prisma.property.deleteMany({ where: { id: propertyId } });
  await prisma.agent.deleteMany({ where: { id: { in: [agentId, directorId] } } });
  await prisma.district.deleteMany({ where: { id: districtId } });
  await prisma.$disconnect();
});

describe("GET /properties/:id/voice", () => {
  it("без токена — 401", async () => {
    const res = await request(app).get(`/api/v1/properties/${propertyShortId}/voice`);
    expect(res.status).toBe(401);
  });

  it("агент видит голос рынка, но не раздел с опросами покупателей после показа", async () => {
    const res = await request(app)
      .get(`/api/v1/properties/${propertyShortId}/voice`)
      .set("Authorization", `Bearer ${agentToken}`);
    expect(res.status).toBe(200);
    expect(res.body.propertyId).toBe(propertyId);
    expect(res.body.interest).toBeDefined();
    expect(res.body.questions).toBeDefined();
    expect("showingFeedback" in res.body).toBe(false);
    expect(JSON.stringify(res.body)).not.toContain("грубил");
  });

  it("директор получает и раздел showingFeedback", async () => {
    const res = await request(app)
      .get(`/api/v1/properties/${propertyShortId}/voice`)
      .set("Authorization", `Bearer ${directorToken}`);
    expect(res.status).toBe(200);
    expect(res.body.showingFeedback.calls).toBe(1);
  });

  it("несуществующий объект — 404", async () => {
    const res = await request(app)
      .get("/api/v1/properties/999999999/voice")
      .set("Authorization", `Bearer ${directorToken}`);
    expect(res.status).toBe(404);
  });
});
