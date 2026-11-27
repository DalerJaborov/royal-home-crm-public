import { afterAll, beforeAll, describe, expect, it } from "vitest";
import request from "supertest";
import type { Server } from "node:http";
import { app } from "../src/app.js";
import { prisma } from "../src/db.js";
import { signAccessToken } from "../src/auth/jwt.js";
import { grantElevation, revokeElevation } from "../src/lib/stepUp.js";

/**
 * АКЦИОНЕР ПРИВЯЗЫВАЕТ СВОЙ TELEGRAM САМ (27.11.2026, учредитель на проде: учётка есть,
 * Telegram не привязан). Путь: Профиль → «Личный чат с ботом CRM в Telegram» → «Привязать»
 * (POST /me/telegram-link). Режим просмотра его не закрывает, подтверждение личности —
 * как у всех: код в СМС через /auth/step-up/send-code и /auth/step-up (тоже открыты).
 */
const runId = Date.now();
let server: Server;
let agentId = "";
let token = "";

beforeAll(async () => {
  server = app.listen(0);
  const agent = await prisma.agent.create({
    data: { fullName: `Акционер ссылка ${runId}`, phone: `+99297${String(runId).slice(-7)}`, role: "SHAREHOLDER", passwordHash: "x" },
  });
  agentId = agent.id;
  token = signAccessToken({ sub: agent.id, role: "SHAREHOLDER" });
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await prisma.auditLog.deleteMany({ where: { entityId: agentId } });
  await prisma.agent.deleteMany({ where: { id: agentId } });
});

describe("акционер: привязка Telegram из профиля", () => {
  it("без подтверждения личности — 428 (окно кода), а не «режим просмотра»", async () => {
    revokeElevation(agentId);
    const res = await request(server).post("/api/v1/me/telegram-link").set("Authorization", `Bearer ${token}`).send({});
    expect(res.body?.code).not.toBe("READ_ONLY_ROLE");
    expect(res.status).toBe(428);
    expect(res.body.stepUpRequired).toBe(true);
  });

  it("шаг подтверждения ему открыт (код себе в СМС)", async () => {
    const res = await request(server).post("/api/v1/auth/step-up/send-code").set("Authorization", `Bearer ${token}`).send({});
    expect(res.body?.code).not.toBe("READ_ONLY_ROLE");
    const verify = await request(server).post("/api/v1/auth/step-up").set("Authorization", `Bearer ${token}`).send({ code: "000000" });
    expect(verify.body?.code).not.toBe("READ_ONLY_ROLE");
  });

  it("после подтверждения — одноразовый код привязки", async () => {
    grantElevation(agentId);
    const res = await request(server).post("/api/v1/me/telegram-link").set("Authorization", `Bearer ${token}`).send({});
    expect(res.status).toBe(200);
    expect(typeof res.body.code).toBe("string");
  });

  it("отметить своё уведомление прочитанным — можно", async () => {
    const res = await request(server).post("/api/v1/me/notifications/read-all").set("Authorization", `Bearer ${token}`).send({});
    expect(res.body?.code).not.toBe("READ_ONLY_ROLE");
    expect(res.status).toBeLessThan(400);
  });
});
