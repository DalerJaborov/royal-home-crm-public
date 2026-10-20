import { afterAll, beforeAll, describe, expect, it } from "vitest";
import request from "supertest";

/**
 * СКРЫТОЕ ИМЯ КЛИЕНТА НЕ ПЕРЕПИСЫВАЕТСЯ СОХРАНЕНИЕМ КАРТОЧКИ (аудит 23.09.2026, №67).
 *
 * Агент без права видеть номера получает имя «Азиз 9188•••••54»; форма шлёт имя
 * при каждом сохранении — правка бюджета записывала маску в базу навсегда.
 */

const { app } = await import("../src/app.js");
const { prisma } = await import("../src/db.js");
const { signAccessToken } = await import("../src/auth/jwt.js");

const runId = Date.now();
const tail = String(runId).slice(-7);
const REAL_NAME = "Азиз 910001003";
let agentId = "";
let clientId = "";
let token = "";

beforeAll(async () => {
  agentId = (
    await prisma.agent.create({ data: { fullName: `Агент скрытого имени ${runId}`, phone: `+99291${tail}`, role: "AGENT", passwordHash: "x" } })
  ).id;
  token = signAccessToken({ sub: agentId, role: "AGENT" });
  await prisma.client.deleteMany({ where: { phone: `+99292${tail}` } });
  clientId = (
    await prisma.client.create({
      data: {
        fullName: REAL_NAME,
        phone: `+99292${tail}`,
        source: "INSTAGRAM",
        kind: "BUYER",
        assignedAgentId: agentId,
        acceptedAt: new Date(),
      },
    })
  ).id;
});

afterAll(async () => {
  await prisma.interaction.deleteMany({ where: { clientId } });
  await prisma.client.deleteMany({ where: { id: clientId } });
  await prisma.agent.deleteMany({ where: { id: agentId } });
});

describe("Сохранение карточки тем, кому номер в имени скрыт", () => {
  it("показанное скрытым имя, присланное обратно, в базу не пишется", async () => {
    const card = await request(app).get(`/api/v1/clients/${clientId}`).set("Authorization", `Bearer ${token}`);
    expect(card.status).toBe(200);
    const shownName: string = card.body.fullName ?? card.body.client?.fullName;
    expect(shownName).not.toBe(REAL_NAME);

    const res = await request(app)
      .patch(`/api/v1/clients/${clientId}`)
      .set("Authorization", `Bearer ${token}`)
      .send({ fullName: shownName, budgetMax: 50000 });
    expect(res.status).toBeLessThan(300);

    const after = await prisma.client.findUniqueOrThrow({ where: { id: clientId } });
    expect(after.fullName).toBe(REAL_NAME);
    expect(Number(after.budgetMax)).toBe(50000);
  });

  it("новое имя со скрытым номером внутри — понятный отказ, а не маска в базе", async () => {
    const res = await request(app)
      .patch(`/api/v1/clients/${clientId}`)
      .set("Authorization", `Bearer ${token}`)
      .send({ fullName: "Азиз-ака 9188•••••54" });
    expect(res.status).toBe(400);
    const after = await prisma.client.findUniqueOrThrow({ where: { id: clientId } });
    expect(after.fullName).toBe(REAL_NAME);
  });
});
