import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import bcrypt from "bcrypt";
import request from "supertest";
import { app } from "../src/app.js";
import { prisma } from "../src/db.js";
import { grantElevation } from "../src/lib/stepUp.js";
import { deleteAgentsWithTraces } from "./helpers/cleanupAgents.js";

/**
 * Правка несуществующего сотрудника (ночная проверка 24.09.2026, №152): раньше
 * `prisma.agent.update` падал P2025, и ответ был 500 с записью в журнал ошибок.
 */

const runId = Date.now();
const password = "testpass123";
const directorPhone = `+992985${runId}`;
let directorId: string;
let token: string;

beforeAll(async () => {
  const director = await prisma.agent.create({
    data: { fullName: "Правка Директор", phone: directorPhone, role: "DIRECTOR", passwordHash: await bcrypt.hash(password, 10) },
  });
  directorId = director.id;
  const res = await request(app).post("/api/v1/auth/login").send({ phone: directorPhone, password });
  expect(res.status).toBe(200);
  grantElevation(directorId);
  token = res.body.accessToken as string;
});

afterAll(async () => {
  await deleteAgentsWithTraces([directorId]);
});

describe("PATCH /agents/:id несуществующего сотрудника", () => {
  it("отвечает 404, а не 500", async () => {
    const res = await request(app)
      .patch(`/api/v1/agents/${randomUUID()}`)
      .set("Authorization", `Bearer ${token}`)
      .send({ fullName: "Никого нет" });
    expect(res.status).toBe(404);
    expect(res.body.error).toBe("Сотрудник не найден");
  });
});
