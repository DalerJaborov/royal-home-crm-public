import { afterAll, beforeAll, describe, expect, it } from "vitest";
import bcrypt from "bcrypt";
import request from "supertest";
import { app } from "../src/app.js";
import { prisma } from "../src/db.js";

/**
 * Явное «Получить этот лид как 7-го клиента» (Путь покупателя, пп.5.1-5.2):
 * GET /clients/:id должен отдавать matchScore, когда лид ушёл агенту по правилу
 * «свой объект» (assignReason=own_property_match) и ещё не принят — карточка
 * показывает агенту процент совпадения, а не просто «новый лид».
 */

const runId = Date.now();
const password = "testpass123";

let agentId: string;
let token: string;
let districtId: string;
let propertyId: string;
let clientId: string;

async function getClient() {
  const res = await request(app).get(`/api/v1/clients/${clientShortId}`).set("Authorization", `Bearer ${token}`);
  expect(res.status).toBe(200);
  return res.body as {
    matchScore: number | null;
    assignReason: string | null;
    acceptedAt: string | null;
    aiInsight: string | null;
    budgetMin: string | number | null;
  };
}

/** Сводка ИИ на карточке — её видно только после принятия лида (см. ниже). */
const INSIGHT = "Ищет 3-комнатную, бюджет назвал, ждёт подборку.";

let clientShortId: number;

beforeAll(async () => {
  const passwordHash = await bcrypt.hash(password, 10);
  agentId = (
    await prisma.agent.create({
      data: { fullName: "Агент своего объекта (счёт)", phone: `+992907${runId}`, role: "AGENT", passwordHash },
    })
  ).id;
  token = (
    await request(app).post("/api/v1/auth/login").send({ phone: `+992907${runId}`, password })
  ).body.accessToken;

  districtId = (await prisma.district.create({ data: { name: `Тест-счёт-совпадения-${runId}` } })).id;
  const property = await prisma.property.create({
    data: {
      title: `Объект под счёт совпадения ${runId}`,
      type: "APARTMENT",
      areaSqm: 60,
      rooms: 3,
      price: 300_000,
      currency: "TJS",
      districtId,
      address: "Тестовая, 1",
      condition: "GOOD",
      status: "AVAILABLE",
      intakeAgentId: agentId,
    },
  });
  propertyId = property.id;

  const client = await prisma.client.create({
    data: {
      fullName: `Клиент под счёт совпадения ${runId}`,
      phone: `+992908${runId}`,
      source: "INSTAGRAM",
      kind: "BUYER",
      status: "NEW",
      currency: "TJS",
      budgetMin: 250_000,
      budgetMax: 400_000,
      desiredDistrictId: districtId,
      desiredRooms: 3,
      assignedAgentId: agentId,
      assignReason: "own_property_match",
      matchedPropertyId: propertyId,
      aiInsight: INSIGHT,
      aiInsightAt: new Date(),
    },
  });
  clientId = client.id;
  clientShortId = client.shortId;
});

afterAll(async () => {
  await prisma.client.deleteMany({ where: { id: clientId } });
  await prisma.property.deleteMany({ where: { id: propertyId } });
  await prisma.agent.deleteMany({ where: { id: agentId } });
  await prisma.district.deleteMany({ where: { id: districtId } });
  await prisma.$disconnect();
});

describe("matchScore на карточке непринятого лида по своему объекту", () => {
  it("совпадение 100 из 100 — точное попадание по умолчаниям весов", async () => {
    const body = await getClient();
    expect(body.assignReason).toBe("own_property_match");
    expect(body.matchScore).toBe(100);
  });

  /**
   * Сводка ИИ — пересказ переписки и хронологии, а они до принятия лида закрыты
   * (владелец 20.08.2026: агент отклонил объект, посмотрев бюджет в непринятой
   * карточке). Оставить сводку значило бы отдать то же содержимое, только короче.
   * Проверяем вместе с бюджетом: одна ветка в routes/clients.ts, и разъехаться
   * они могут только по недосмотру.
   */
  it("до принятия лида сводка ИИ и бюджет закрыты", async () => {
    const body = await getClient();
    expect(body.acceptedAt).toBeNull();
    expect(body.aiInsight).toBeNull();
    expect(body.budgetMin).toBeNull();
  });

  it("после приёма лида matchScore больше не считается, а сводка открывается", async () => {
    await request(app).post(`/api/v1/clients/${clientId}/accept`).set("Authorization", `Bearer ${token}`);
    const body = await getClient();
    expect(body.acceptedAt).not.toBeNull();
    expect(body.matchScore).toBeNull();
    expect(body.aiInsight).toBe(INSIGHT);
  });
});
