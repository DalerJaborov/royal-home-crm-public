import { afterAll, beforeAll, describe, expect, it } from "vitest";
import bcrypt from "bcrypt";
import request from "supertest";
import { app } from "../src/app.js";
import { prisma } from "../src/db.js";
import { deleteAgentsWithTraces } from "./helpers/cleanupAgents.js";

/**
 * Телефон и имя сотрудника — с форматом и потолком (ночная проверка 24.09.2026, №166).
 * Раньше в своём профиле принимался телефон «abcde» (по нему потом и входили)
 * и имя любой длины.
 */
const runId = Date.now();
const password = "testpass123";
const phone = `+992984${runId}`;
let agentId: string;
let token: string;

beforeAll(async () => {
  const agent = await prisma.agent.create({
    data: { fullName: "Профиль Агент", phone, role: "AGENT", passwordHash: await bcrypt.hash(password, 10) },
  });
  agentId = agent.id;
  const res = await request(app).post("/api/v1/auth/login").send({ phone, password });
  expect(res.status).toBe(200);
  token = res.body.accessToken as string;
});

afterAll(async () => {
  await deleteAgentsWithTraces([agentId]);
});

describe("свой профиль: телефон и имя", () => {
  it("телефон без цифр не принимается", async () => {
    const res = await request(app)
      .patch("/api/v1/me")
      .set("Authorization", `Bearer ${token}`)
      .send({ phone: "abcde", currentPassword: password });
    expect(res.status).toBe(400);
    const saved = await prisma.agent.findUnique({ where: { id: agentId }, select: { phone: true } });
    expect(saved?.phone).toBe(phone);
  });

  it("имя длиннее 120 знаков не принимается", async () => {
    const res = await request(app)
      .patch("/api/v1/me")
      .set("Authorization", `Bearer ${token}`)
      .send({ fullName: "А".repeat(121) });
    expect(res.status).toBe(400);
  });
});
