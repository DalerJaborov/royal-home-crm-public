import { afterAll, beforeAll, describe, expect, it } from "vitest";
import request from "supertest";

/**
 * ЗАПИСЬ ЗВОНКА-ОПРОСА — ТОЛЬКО ТЕМ, КОМУ ОТКРЫТ ЗВУК (аудит 23.09.2026, №45).
 *
 * Контроль руководителя открыт правом dashboard.analytics — оно есть у
 * менеджера. Слушать записи разговоров менеджеру не положено (calls.hearRecording),
 * а ссылка на запись опроса выдавалась всем, кто видит контроль.
 */

const { app } = await import("../src/app.js");
const { prisma } = await import("../src/db.js");
const { signAccessToken } = await import("../src/auth/jwt.js");

const runId = Date.now();
const tail = String(runId).slice(-7);
const agentIds: string[] = [];
let managerToken = "";
let directorToken = "";
const MISSING = "00000000-0000-4000-8000-000000000045";

beforeAll(async () => {
  const manager = await prisma.agent.create({
    data: { fullName: `Менеджер записи ${runId}`, phone: `+99290${tail}`, role: "MANAGER", passwordHash: "x" },
  });
  const director = await prisma.agent.create({
    data: { fullName: `Директор записи ${runId}`, phone: `+99291${tail}`, role: "DIRECTOR", passwordHash: "x" },
  });
  agentIds.push(manager.id, director.id);
  managerToken = signAccessToken({ sub: manager.id, role: "MANAGER" });
  directorToken = signAccessToken({ sub: director.id, role: "DIRECTOR" });
});

afterAll(async () => {
  await prisma.agent.deleteMany({ where: { id: { in: agentIds } } });
});

describe("Ссылка на запись звонка-опроса", () => {
  it("менеджеру без права слушать — отказ", async () => {
    const res = await request(app)
      .get(`/api/v1/oversight/showing-survey-calls/${MISSING}/recording`)
      .set("Authorization", `Bearer ${managerToken}`);
    expect(res.status).toBe(403);
  });

  it("директору право не мешает (записи нет — 404, а не отказ)", async () => {
    const res = await request(app)
      .get(`/api/v1/oversight/showing-survey-calls/${MISSING}/recording`)
      .set("Authorization", `Bearer ${directorToken}`);
    expect(res.status).toBe(404);
  });
});
