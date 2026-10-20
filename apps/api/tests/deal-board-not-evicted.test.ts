import { afterAll, beforeAll, describe, expect, it } from "vitest";
import bcrypt from "bcrypt";
import request from "supertest";
import { app } from "../src/app.js";
import { prisma } from "../src/db.js";

/**
 * Архив сделок не вытесняет доску.
 *
 * Разбор интерфейса 13.08.2026: GET /deals отдавал ОДИН запрос `take: 500` по
 * всем стадиям сразу, отсортированный по дате начала (свежие первыми). Активных
 * сделок в агентстве всегда десятки, а завершённые и отменённые копятся годами и
 * никуда не деваются. В тот день, когда закрытых наберётся пятьсот, они занимают
 * собой весь потолок — и действующая сделка, начатая давно, просто пропадает с
 * доски: ни ошибки, ни пометки, карточки на экране нет.
 *
 * Здесь это воспроизведено в миниатюре: закрытых заведомо больше потолка, старая
 * активная сделка — самая давняя из всех. Она обязана вернуться в ответе.
 */

const runId = Date.now();
const password = "testpass123";
/** Столько же, сколько потолок каждой корзины в routes/deals.ts. */
const BUCKET_LIMIT = 500;

let districtId = "";
let directorId = "";
let agentId = "";
let clientId = "";
let propertyId = "";
let token = "";
let oldActiveDealId = "";

beforeAll(async () => {
  const passwordHash = await bcrypt.hash(password, 10);
  districtId = (await prisma.district.create({ data: { name: `Доска-${runId}` } })).id;
  const director = await prisma.agent.create({
    data: { fullName: `Доска Дир ${runId}`, phone: `+992941${String(runId).slice(-7)}`, role: "DIRECTOR", passwordHash },
  });
  directorId = director.id;
  const agent = await prisma.agent.create({
    data: { fullName: `Доска Агент ${runId}`, phone: `+992942${String(runId).slice(-7)}`, role: "AGENT", passwordHash },
  });
  agentId = agent.id;
  const client = await prisma.client.create({
    data: {
      fullName: `Доска Клиент ${runId}`,
      phone: `+992943${String(runId).slice(-7)}`,
      source: "PHONE_CALL",
      assignedAgentId: agent.id,
      acceptedAt: new Date(),
    },
  });
  clientId = client.id;
  const property = await prisma.property.create({
    data: {
      title: `Доска ${runId}`,
      type: "APARTMENT",
      areaSqm: 60,
      price: 100000,
      currency: "USD",
      districtId,
      address: `Тест ${runId}`,
      condition: "GOOD",
      status: "AVAILABLE",
    },
  });
  propertyId = property.id;

  // Активная сделка — САМАЯ СТАРАЯ из всех: при сортировке «свежие первыми» она
  // уходит в самый хвост и первой попадает под нож общего потолка.
  const oldActive = await prisma.deal.create({
    data: {
      clientId,
      propertyId,
      agentId,
      stage: "NEGOTIATION",
      startedAt: new Date("2024-01-01T00:00:00Z"),
    },
  });
  oldActiveDealId = oldActive.id;

  // Закрытых — с запасом больше потолка одной корзины.
  await prisma.deal.createMany({
    data: Array.from({ length: BUCKET_LIMIT + 20 }, (_, i) => ({
      clientId,
      propertyId,
      agentId,
      stage: (i % 2 === 0 ? "COMPLETED" : "CANCELLED") as "COMPLETED" | "CANCELLED",
      // Все свежее активной — именно они и вытесняли её раньше.
      startedAt: new Date(Date.UTC(2026, 0, 1, 0, 0, i)),
    })),
  });

  const login = await request(app).post("/api/v1/auth/login").send({ phone: director.phone, password });
  expect(login.status).toBe(200);
  token = login.body.accessToken as string;
});

afterAll(async () => {
  await prisma.deal.deleteMany({ where: { clientId } });
  await prisma.interaction.deleteMany({ where: { clientId } });
  await prisma.client.deleteMany({ where: { id: clientId } });
  await prisma.property.deleteMany({ where: { id: propertyId } });
  await prisma.agent.deleteMany({ where: { id: { in: [directorId, agentId] } } });
  await prisma.district.deleteMany({ where: { id: districtId } });
  await prisma.$disconnect();
});

describe("Доска сделок не тонет в архиве", () => {
  it("старая активная сделка возвращается, даже когда закрытых больше потолка", async () => {
    const res = await request(app).get("/api/v1/deals").set("Authorization", `Bearer ${token}`);
    expect(res.status).toBe(200);

    const ids = (res.body as { id: string }[]).map((d) => d.id);
    expect(ids).toContain(oldActiveDealId);
  });

  it("фильтр по стадии продолжает отдавать только её", async () => {
    const res = await request(app)
      .get("/api/v1/deals?stage=NEGOTIATION")
      .set("Authorization", `Bearer ${token}`);
    expect(res.status).toBe(200);

    const stages = new Set((res.body as { stage: string }[]).map((d) => d.stage));
    expect([...stages]).toEqual(["NEGOTIATION"]);
  });
});
