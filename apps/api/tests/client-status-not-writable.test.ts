import { afterAll, beforeAll, describe, expect, it } from "vitest";
import request from "supertest";

/**
 * СТАТУС КЛИЕНТА НИКТО НЕ СТАВИТ ВРУЧНУЮ (владелец 17.11.2026: статусы клиента не
 * показываются и не ставятся). Колонка осталась для внутренних нужд (закрытая
 * сделка, Архив) — их ставит сама CRM. Ни PATCH карточки, ни вебхук сайта
 * статус не меняют.
 */

const { app } = await import("../src/app.js");
const { prisma } = await import("../src/db.js");
const { signAccessToken } = await import("../src/auth/jwt.js");

const runId = Date.now();
const tail = String(runId).slice(-7);
const API_KEY = `test-status-${runId}`;
let directorId = "";
let token = "";
let clientId = "";

beforeAll(async () => {
  process.env.WEBSITE_LEAD_API_KEY = API_KEY;
  directorId = (
    await prisma.agent.create({ data: { fullName: `Статус-тест ${runId}`, phone: `+99241${tail}`, role: "DIRECTOR", passwordHash: "x" } })
  ).id;
  token = signAccessToken({ sub: directorId, role: "DIRECTOR" });
  clientId = (
    await prisma.client.create({
      data: { fullName: `Без статуса ${runId}`, phone: `+99242${tail}`, kind: "BUYER", source: "WEBSITE", status: "NEW", assignedAgentId: directorId, acceptedAt: new Date() },
    })
  ).id;
});

afterAll(async () => {
  delete process.env.WEBSITE_LEAD_API_KEY;
  await prisma.interaction.deleteMany({ where: { clientId } });
  await prisma.client.deleteMany({ where: { id: clientId } });
  await prisma.agent.deleteMany({ where: { id: directorId } });
  await prisma.$disconnect();
});

describe("статус клиента не пишется ни вручную, ни сайтом", () => {
  it("PATCH со статусом — 400 даже директору, статус прежний", async () => {
    for (const status of ["CONTACTED", "HOT", "DEAL_CLOSED", "ARCHIVED"]) {
      const res = await request(app).patch(`/api/v1/clients/${clientId}`).set("Authorization", `Bearer ${token}`).send({ status });
      expect(res.status, status).toBe(400);
    }
    expect((await prisma.client.findUniqueOrThrow({ where: { id: clientId } })).status).toBe("NEW");
  });

  it("обычная правка карточки без статуса работает", async () => {
    const res = await request(app).patch(`/api/v1/clients/${clientId}`).set("Authorization", `Bearer ${token}`).send({ fullName: `Переименован ${runId}` });
    expect(res.status).toBe(200);
  });

  it("вебхук сайта отвечает 200, но статус не меняет", async () => {
    const res = await request(app).post("/api/v1/webhooks/site-lead-status").set("X-Api-Key", API_KEY).send({ clientId, status: "contacted" });
    expect(res.status).toBe(200);
    expect(res.body.applied).toBe(false);
    expect((await prisma.client.findUniqueOrThrow({ where: { id: clientId } })).status).toBe("NEW");
  });

  it("список клиентов больше не фильтрует и не сортирует по статусу", async () => {
    const sorted = await request(app).get("/api/v1/clients?sort=status_asc").set("Authorization", `Bearer ${token}`);
    expect(sorted.status).toBe(400);
  });
});
