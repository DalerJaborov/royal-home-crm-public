import { afterAll, beforeAll, describe, expect, it } from "vitest";
import request from "supertest";

/**
 * СТАТУС КЛИЕНТА НЕ МЕНЯЕТСЯ В ОБХОД ГЕЙТА ЧЕРЕЗ ПРОМЕЖУТОЧНЫЙ ТИП
 * (аудит Codex 04.10.2026, ACCESS-08).
 *
 * Так было: гейт «агент не ставит статус покупателю/продавцу» смотрел на текущий
 * kind карточки, а тип агент меняет сам. PATCH {kind:OTHER}, затем
 * PATCH {kind:BUYER, status:DEAL_CLOSED} закрывал клиента без сделки и оплаты.
 */

const { app } = await import("../src/app.js");
const { prisma } = await import("../src/db.js");
const { signAccessToken } = await import("../src/auth/jwt.js");

const runId = Date.now();
const tail = String(runId).slice(-7);
const agentIds: string[] = [];
const clientIds: string[] = [];
let ownerToken = "";
let supervisorToken = "";

async function mkClient(ownerId: string, suffix: string) {
  const c = await prisma.client.create({
    data: {
      fullName: `Статус-гейт ${suffix} ${runId}`,
      phone: `+99231${tail}${suffix}`,
      kind: "BUYER",
      source: "INSTAGRAM",
      status: "NEW",
      assignedAgentId: ownerId,
      acceptedAt: new Date(),
    } as never,
  });
  clientIds.push(c.id);
  return c;
}

beforeAll(async () => {
  const owner = await prisma.agent.create({
    data: { fullName: `Владелец гейта ${runId}`, phone: `+99232${tail}`, role: "AGENT", passwordHash: "x" },
  });
  const supervisor = await prisma.agent.create({
    data: {
      fullName: `Руководитель гейта ${runId}`,
      phone: `+99233${tail}`,
      role: "MANAGER",
      passwordHash: "x",
      permissions: { granted: ["clients.assign"], revoked: [] } as never,
    },
  });
  agentIds.push(owner.id, supervisor.id);
  ownerToken = signAccessToken({ sub: owner.id, role: "AGENT" });
  supervisorToken = signAccessToken({ sub: supervisor.id, role: "MANAGER" });
});

afterAll(async () => {
  await prisma.interaction.deleteMany({ where: { clientId: { in: clientIds } } });
  await prisma.client.deleteMany({ where: { id: { in: clientIds } } });
  await prisma.agent.deleteMany({ where: { id: { in: agentIds } } });
  await prisma.$disconnect();
});

const patch = (id: string, token: string, body: unknown) =>
  request(app).patch(`/api/v1/clients/${id}`).set("Authorization", `Bearer ${token}`).send(body as object);

describe("PATCH /clients/:id, статус без права clients.assign", () => {
  it("через промежуточный OTHER статус не проходит", async () => {
    const c = await mkClient((await prisma.agent.findFirstOrThrow({ where: { id: agentIds[0] } })).id, "1");
    const step1 = await patch(c.id, ownerToken, { kind: "OTHER" });
    expect(step1.status).toBe(200);
    const step2 = await patch(c.id, ownerToken, { kind: "BUYER", status: "DEAL_CLOSED" });
    expect(step2.status).toBe(403);
    const step3 = await patch(c.id, ownerToken, { status: "DEAL_CLOSED" });
    expect(step3.status).toBe(403);
    const after = await prisma.client.findUnique({ where: { id: c.id }, select: { status: true } });
    expect(after!.status).toBe("NEW");
  });

  it("прямая смена статуса покупателю по-прежнему закрыта, а смена типа без статуса открыта", async () => {
    const c = await mkClient(agentIds[0], "2");
    expect((await patch(c.id, ownerToken, { status: "HOT" })).status).toBe(403);
    expect((await patch(c.id, ownerToken, { kind: "SELLER" })).status).toBe(200);
  });

  it("руководитель с clients.assign статус ставит", async () => {
    const c = await mkClient(agentIds[0], "3");
    const res = await patch(c.id, supervisorToken, { status: "HOT" });
    expect(res.status).toBe(200);
    expect(res.body.status).toBe("HOT");
  });
});
