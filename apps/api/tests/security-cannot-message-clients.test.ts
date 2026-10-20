import { afterAll, beforeAll, describe, expect, it } from "vitest";
import request from "supertest";

/**
 * СЛУЖБА БЕЗОПАСНОСТИ НЕ ПИШЕТ ЧУЖИМ КЛИЕНТАМ (аудит 23.09.2026, №40).
 *
 * Сообщение клиенту и отправка подборки из карточки глушат бота на переписке —
 * это правка чужой карточки. Служба безопасности видит все карточки, но менять
 * их не должна (foreignWriteDenied); писать в переписку карточки из Корзины
 * тоже нельзя никому.
 */

const { app } = await import("../src/app.js");
const { prisma } = await import("../src/db.js");
const { signAccessToken } = await import("../src/auth/jwt.js");

const runId = Date.now();
const tail = String(runId).slice(-6);
const agentIds: string[] = [];
const clientIds: string[] = [];
let agentToken = "";
let securityToken = "";
let clientId = "";
let trashedId = "";
const ANY_PROPERTY = "00000000-0000-4000-8000-000000000000";

beforeAll(async () => {
  const agent = await prisma.agent.create({
    data: { fullName: `Агент переписки ${runId}`, phone: `+992936${tail}`, role: "AGENT", passwordHash: "x" },
  });
  const security = await prisma.agent.create({
    data: { fullName: `СБ переписки ${runId}`, phone: `+992937${tail}`, role: "SECURITY", passwordHash: "x" },
  });
  agentIds.push(agent.id, security.id);
  agentToken = signAccessToken({ sub: agent.id, role: "AGENT" });
  securityToken = signAccessToken({ sub: security.id, role: "SECURITY" });

  for (const [suffix, deletedAt] of [["1", null], ["2", new Date()]] as const) {
    const phone = `+99293${suffix}${tail}`.slice(0, 13);
    await prisma.client.deleteMany({ where: { phone } });
    const c = await prisma.client.create({
      data: {
        fullName: `Клиент переписки ${suffix} ${runId}`,
        phone,
        source: "INSTAGRAM",
        assignedAgentId: agent.id,
        acceptedAt: new Date(),
        deletedAt,
      },
    });
    clientIds.push(c.id);
  }
  [clientId, trashedId] = clientIds;
});

afterAll(async () => {
  await prisma.interaction.deleteMany({ where: { clientId: { in: clientIds } } });
  await prisma.client.deleteMany({ where: { id: { in: clientIds } } });
  await prisma.agent.deleteMany({ where: { id: { in: agentIds } } });
});

describe("Служба безопасности и переписка с чужим клиентом", () => {
  it("сообщение из карточки — отказ", async () => {
    const res = await request(app)
      .post(`/api/v1/clients/${clientId}/message`)
      .set("Authorization", `Bearer ${securityToken}`)
      .send({ text: "Здравствуйте" });
    expect(res.status).toBe(403);
  });

  it("отправка подборки — отказ", async () => {
    const res = await request(app)
      .post(`/api/v1/clients/${clientId}/send-properties`)
      .set("Authorization", `Bearer ${securityToken}`)
      .send({ propertyIds: [ANY_PROPERTY] });
    expect(res.status).toBe(403);
  });
});

describe("Карточка в Корзине", () => {
  it("свой агент не пишет клиенту, пока карточку не восстановили", async () => {
    const msg = await request(app)
      .post(`/api/v1/clients/${trashedId}/message`)
      .set("Authorization", `Bearer ${agentToken}`)
      .send({ text: "Здравствуйте" });
    expect(msg.status).toBe(409);
    expect(msg.body.error).toMatch(/Корзин/);
    const pick = await request(app)
      .post(`/api/v1/clients/${trashedId}/send-properties`)
      .set("Authorization", `Bearer ${agentToken}`)
      .send({ propertyIds: [ANY_PROPERTY] });
    expect(pick.status).toBe(409);
    expect(pick.body.error).toMatch(/Корзин/);
  });
});
