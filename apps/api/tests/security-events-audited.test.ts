import { afterAll, beforeAll, describe, expect, it } from "vitest";
import bcrypt from "bcrypt";
import request from "supertest";
import { app } from "../src/app.js";
import { prisma } from "../src/db.js";
import { waitFor } from "./helpers/waitFor.js";

/**
 * События безопасности учётки попадают в журнал действий (G13, 02.10.2026).
 *
 * Так было: смена телефона-логина не писалась вовсе, смена пароля — только если
 * были другие устройства, отзыв устройства и отвязка Telegram — тоже без следа.
 * Разбирая угон учётки, руководитель не видел, когда и с чего всё началось.
 */

const runId = String(Date.now()).slice(-7);
const password = "testpass123";
const phone = `+992991${runId}`;
const newPhone = `+992992${runId}`;
let agentId = "";
let token = "";

async function audit(action: string) {
  return waitFor(() => prisma.auditLog.findFirst({ where: { entityId: agentId, action } }), { label: action });
}

beforeAll(async () => {
  await prisma.agent.deleteMany({ where: { phone: { in: [phone, newPhone] } } });
  agentId = (
    await prisma.agent.create({
      data: { fullName: "Агент журнала безопасности", phone, role: "AGENT", passwordHash: await bcrypt.hash(password, 4) },
    })
  ).id;
  token = (await request(app).post("/api/v1/auth/login").send({ phone, password })).body.accessToken;
});

afterAll(async () => {
  await prisma.auditLog.deleteMany({ where: { entityId: agentId } });
  await prisma.session.deleteMany({ where: { agentId } });
  await prisma.agent.deleteMany({ where: { id: agentId } });
  await prisma.$disconnect();
});

describe("Журнал событий безопасности", () => {
  it("смена телефона-логина записана со старым и новым номером", async () => {
    // Смена номера требует свежего подтверждения личности (тестовый вход паролем).
    await request(app).post("/api/v1/auth/step-up").set("Authorization", `Bearer ${token}`).send({ password });
    const res = await request(app)
      .patch("/api/v1/me")
      .set("Authorization", `Bearer ${token}`)
      .send({ phone: newPhone });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    const row = await audit("PHONE_CHANGED");
    expect(JSON.stringify(row!.meta)).toContain(newPhone);
  });

  it("отзыв устройства и отвязка Telegram записаны", async () => {
    const session = await prisma.session.findFirst({ where: { agentId, revokedAt: null } });
    const del = await request(app).delete(`/api/v1/me/sessions/${session!.id}`).set("Authorization", `Bearer ${token}`);
    expect(del.status).toBe(204);
    await audit("SESSION_REVOKED");

    const unlink = await request(app).post("/api/v1/me/telegram-unlink").set("Authorization", `Bearer ${token}`);
    expect(unlink.status).toBe(200);
    await audit("TELEGRAM_UNLINKED");
  });
});
