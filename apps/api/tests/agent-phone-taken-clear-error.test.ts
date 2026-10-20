import { afterAll, beforeAll, describe, expect, it } from "vitest";
import request from "supertest";

/**
 * ЗАНЯТЫЙ ТЕЛЕФОН СОТРУДНИКА — ПОНЯТНЫЙ ОТКАЗ (аудит 23.09.2026, №63).
 *
 * Телефон — логин сотрудника и уникален. Правка карточки на номер коллеги
 * падала на уникальном индексе и отдавала «Внутренняя ошибка».
 */

const { app } = await import("../src/app.js");
const { prisma } = await import("../src/db.js");
const { signAccessToken } = await import("../src/auth/jwt.js");
const { grantElevation } = await import("../src/lib/stepUp.js");

const runId = Date.now();
const tail = String(runId).slice(-7);
const agentIds: string[] = [];
let directorToken = "";
let targetId = "";
const TAKEN = `+99295${tail}`;

beforeAll(async () => {
  const director = await prisma.agent.create({
    data: { fullName: `Директор телефонов ${runId}`, phone: `+99293${tail}`, role: "DIRECTOR", passwordHash: "x" },
  });
  const holder = await prisma.agent.create({
    data: { fullName: `Хозяин номера ${runId}`, phone: TAKEN, role: "AGENT", passwordHash: "x" },
  });
  const target = await prisma.agent.create({
    data: { fullName: `Правим ${runId}`, phone: `+99294${tail}`, role: "AGENT", passwordHash: "x" },
  });
  agentIds.push(director.id, holder.id, target.id);
  targetId = target.id;
  directorToken = signAccessToken({ sub: director.id, role: "DIRECTOR" });
  grantElevation(director.id);
});

afterAll(async () => {
  await prisma.auditLog.deleteMany({ where: { entityId: { in: agentIds } } }).catch(() => {});
  await prisma.agent.deleteMany({ where: { id: { in: agentIds } } });
});

describe("Правка телефона сотрудника", () => {
  it("номер коллеги — 409 с именем, а не внутренняя ошибка", async () => {
    const res = await request(app)
      .patch(`/api/v1/agents/${targetId}`)
      .set("Authorization", `Bearer ${directorToken}`)
      .send({ phone: TAKEN });
    expect(res.status).toBe(409);
    expect(res.body.error).toContain(`Хозяин номера ${runId}`);
  });

  it("свой же номер сохраняется", async () => {
    const res = await request(app)
      .patch(`/api/v1/agents/${targetId}`)
      .set("Authorization", `Bearer ${directorToken}`)
      .send({ phone: `+99294${tail}` });
    expect(res.status).toBe(200);
  });
});
