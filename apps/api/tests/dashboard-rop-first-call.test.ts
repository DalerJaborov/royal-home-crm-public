import { afterAll, beforeAll, describe, expect, it } from "vitest";
import request from "supertest";
import { app } from "../src/app.js";
import { prisma } from "../src/db.js";
import { signAccessToken } from "../src/auth/jwt.js";

/**
 * «Позвонить сейчас» у РОП (26.11.2026, владелец: у Нозы РОП исчезло «Позвонить
 * клиентам»). У РОП есть право clients.viewAll, поэтому scopeToOwnAgent отдаёт ей
 * undefined, и сводка молча отдавала пустые firstCallDue/assignedBySupervisor, хотя
 * крон считает срок первого звонка по её личным клиентам (РОП работает как агент).
 * Правило: роль, которая ведёт клиентов (SALES_AGENT_ROLES), видит свои сроки;
 * директор и админ без собственных лидов — по-прежнему нет.
 */

const runId = Date.now();
let ropId: string;
let directorId: string;
let ropToken: string;
let directorToken: string;
let ropClientId: string;
let foreignClientId: string;
let directorClientId: string;

beforeAll(async () => {
  ropId = (await prisma.agent.create({ data: { fullName: "РОП звонка", phone: `+992951${runId}`, role: "HEAD_OF_SALES", passwordHash: "x" } })).id;
  directorId = (await prisma.agent.create({ data: { fullName: "Директор звонка", phone: `+992952${runId}`, role: "DIRECTOR", passwordHash: "x" } })).id;
  ropToken = signAccessToken({ sub: ropId, role: "HEAD_OF_SALES" });
  directorToken = signAccessToken({ sub: directorId, role: "DIRECTOR" });
  const make = (suffix: string, assignedAgentId: string) =>
    prisma.client.create({
      data: { fullName: `Клиент звонка ${suffix} ${runId}`, phone: `+992953${suffix}${String(runId).slice(-6)}`, source: "WALK_IN", assignedAgentId, acceptedAt: new Date() },
    });
  ropClientId = (await make("1", ropId)).id;
  directorClientId = (await make("2", directorId)).id;
  // Чужой клиент: закреплён за директором, у РОП в списке «позвонить» быть не должен.
  foreignClientId = directorClientId;
});

afterAll(async () => {
  await prisma.interaction.deleteMany({ where: { clientId: { in: [ropClientId, directorClientId] } } });
  await prisma.client.deleteMany({ where: { id: { in: [ropClientId, directorClientId] } } });
  await prisma.agent.deleteMany({ where: { id: { in: [ropId, directorId] } } });
  await prisma.$disconnect();
});

describe("GET /dashboard/summary: «позвонить» у РОП", () => {
  it("РОП видит свою принятую карточку без звонка и не видит чужую", async () => {
    const res = await request(app).get("/api/v1/dashboard/summary").set("Authorization", `Bearer ${ropToken}`);
    expect(res.status).toBe(200);
    const ids = (res.body.firstCallDue as { id: string }[]).map((c) => c.id);
    expect(ids).toContain(ropClientId);
    expect(ids).not.toContain(foreignClientId);
  });

  it("директор без личных лидов списка «позвонить» по-прежнему не получает", async () => {
    const res = await request(app).get("/api/v1/dashboard/summary").set("Authorization", `Bearer ${directorToken}`);
    expect(res.status).toBe(200);
    expect(res.body.firstCallDue).toEqual([]);
    expect(res.body.assignedBySupervisor).toEqual([]);
  });
});
