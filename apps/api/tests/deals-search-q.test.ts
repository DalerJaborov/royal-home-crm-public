import { afterAll, beforeAll, describe, expect, it } from "vitest";
import request from "supertest";

/**
 * БЫСТРЫЙ ПОИСК ПО СДЕЛКАМ ИЩЕТ (аудит 23.09.2026, №67).
 *
 * Командная палитра шлёт /deals?q=…, сервер проверял q и выбрасывал: раздел
 * «Сделки» показывал одни и те же пять последних сделок на любой запрос.
 */

const { app } = await import("../src/app.js");
const { prisma } = await import("../src/db.js");
const { signAccessToken } = await import("../src/auth/jwt.js");

const runId = Date.now();
const tail = String(runId).slice(-7);
const MARK = `Искомый${tail}`;
const agentIds: string[] = [];
const clientIds: string[] = [];
const propertyIds: string[] = [];
const dealIds: string[] = [];
let districtId = "";
let directorToken = "";

beforeAll(async () => {
  const director = await prisma.agent.create({
    data: { fullName: `Директор поиска ${runId}`, phone: `+99290${tail}`, role: "DIRECTOR", passwordHash: "x" },
  });
  agentIds.push(director.id);
  directorToken = signAccessToken({ sub: director.id, role: "DIRECTOR" });
  districtId = (await prisma.district.create({ data: { name: `Район поиска сделок ${runId}` } })).id;
  for (const [i, name] of [`${MARK} Азиз`, `Другой ${runId}`].entries()) {
    const phone = `+9929${i}${tail}1`.slice(0, 13);
    await prisma.client.deleteMany({ where: { phone } });
    const c = await prisma.client.create({
      data: { fullName: name, phone, source: "INSTAGRAM", assignedAgentId: director.id, acceptedAt: new Date() },
    });
    clientIds.push(c.id);
    const p = await prisma.property.create({
      data: {
        title: `Объект поиска ${runId}-${i}`,
        type: "APARTMENT",
        areaSqm: 50,
        price: 40000,
        currency: "TJS",
        districtId,
        address: "Поисковая, 1",
        condition: "GOOD",
        status: "AVAILABLE",
      },
    });
    propertyIds.push(p.id);
    dealIds.push((await prisma.deal.create({ data: { clientId: c.id, propertyId: p.id, agentId: director.id } })).id);
  }
});

afterAll(async () => {
  await prisma.deal.deleteMany({ where: { id: { in: dealIds } } });
  await prisma.property.deleteMany({ where: { id: { in: propertyIds } } });
  await prisma.interaction.deleteMany({ where: { clientId: { in: clientIds } } });
  await prisma.client.deleteMany({ where: { id: { in: clientIds } } });
  await prisma.district.deleteMany({ where: { id: districtId } });
  await prisma.agent.deleteMany({ where: { id: { in: agentIds } } });
});

describe("Поиск сделок", () => {
  it("по имени клиента находит только его сделку", async () => {
    const res = await request(app)
      .get(`/api/v1/deals?q=${encodeURIComponent(MARK.toLowerCase())}`)
      .set("Authorization", `Bearer ${directorToken}`);
    expect(res.status).toBe(200);
    expect(res.body.map((d: { id: string }) => d.id)).toEqual([dealIds[0]]);
  });

  it("по названию объекта тоже находит", async () => {
    const res = await request(app)
      .get(`/api/v1/deals?q=${encodeURIComponent(`Объект поиска ${runId}-1`)}`)
      .set("Authorization", `Bearer ${directorToken}`);
    expect(res.status).toBe(200);
    expect(res.body.map((d: { id: string }) => d.id)).toEqual([dealIds[1]]);
  });
});
