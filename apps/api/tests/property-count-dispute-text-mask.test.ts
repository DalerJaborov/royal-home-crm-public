import { afterAll, beforeAll, describe, expect, it } from "vitest";
import request from "supertest";

/**
 * СВОБОДНЫЙ ТЕКСТ ЗАЯВОК «ОСПОРИТЬ ЧИСЛО ОБЪЕКТОВ» БЕЗ НОМЕРА ДЛЯ ЧИТАТЕЛЯ
 * БЕЗ clients.viewPhone (аудит Codex 04.10.2026, ACCESS-01, расширение).
 *
 * Так было: имя и phone клиента закрыты, а причина агента (reason) и заметка
 * решения (decisionNote) шли сырыми — номер в них попадает словами.
 */

const { app } = await import("../src/app.js");
const { prisma } = await import("../src/db.js");
const { signAccessToken } = await import("../src/auth/jwt.js");

const runId = Date.now();
const tail = String(runId).slice(-7);
const DIGITS = "900001122";
const agentIds: string[] = [];
const clientIds: string[] = [];
let blindToken = "";
let clientId = "";

beforeAll(async () => {
  const blind = (
    await prisma.agent.create({
      data: {
        fullName: `Споры ${runId}`,
        phone: `+99201${tail}`,
        role: "MANAGER",
        passwordHash: "x",
        permissions: { granted: ["clients.merge", "clients.viewAll"], revoked: ["clients.viewPhone"] } as never,
      },
    })
  ).id;
  agentIds.push(blind);
  blindToken = signAccessToken({ sub: blind, role: "MANAGER" });
  const client = await prisma.client.create({
    data: { fullName: `Клиент спора ${runId}`, phone: `+99202${tail}1`, kind: "SELLER", source: "TELEGRAM", assignedAgentId: blind, acceptedAt: new Date() } as never,
  });
  clientId = client.id;
  clientIds.push(client.id);
  await prisma.propertyCountDispute.create({
    data: {
      clientId,
      requestedById: blind,
      role: "SELLER",
      aiCount: 1,
      proposedCount: 3,
      reason: `он сам сказал, что объектов три, номер +992${DIGITS}`,
      decisionNote: `проверил по звонку ${DIGITS}`,
    } as never,
  });
});

afterAll(async () => {
  await prisma.propertyCountDispute.deleteMany({ where: { clientId: { in: clientIds } } });
  await prisma.client.deleteMany({ where: { id: { in: clientIds } } });
  await prisma.agent.deleteMany({ where: { id: { in: agentIds } } });
  await prisma.$disconnect();
});

const get = (path: string) => request(app).get(path).set("Authorization", `Bearer ${blindToken}`);

describe("заявки на правку числа объектов без clients.viewPhone", () => {
  it("очередь: причина и заметка решения без номера", async () => {
    const res = await get("/api/v1/clients/property-count-disputes");
    expect(res.status).toBe(200);
    const mine = (res.body.items as Array<{ client: { id: string } }>).filter((i) => i.client.id === clientId);
    expect(mine.length).toBe(1);
    expect(JSON.stringify(mine)).not.toContain(DIGITS);
  });

  it("карточка: причина без номера", async () => {
    const res = await get(`/api/v1/clients/${clientId}/property-count-dispute`);
    expect(res.status).toBe(200);
    expect(res.body.requests.length).toBe(1);
    expect(JSON.stringify(res.body)).not.toContain(DIGITS);
  });
});
