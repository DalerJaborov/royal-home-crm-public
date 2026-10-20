import { afterAll, beforeAll, describe, expect, it } from "vitest";
import request from "supertest";
import { app } from "../src/app.js";
import { prisma } from "../src/db.js";
import { signAccessToken } from "../src/auth/jwt.js";
import { invalidateMissionControlCache } from "../src/lib/missionControlCache.js";
import { invalidatePultModuleCache } from "../src/lib/pultModules.js";
import { deleteAgentsWithTraces } from "./helpers/cleanupAgents.js";

/**
 * ПУЛЬТ НЕ ПРЕДЛАГАЕТ ЗАМОРОЖЕННОГО АГЕНТА (глубокая проверка 02.10.2026, F2).
 *
 * «Передать наименее загруженному» в пульте выбирает минимум activeLoad по
 * team.agents. Список команды брал всех активных агентов, включая
 * замороженных и тех, у кого приём лидов на паузе, — у замороженного
 * нагрузка 0, и пульт предлагал отдать лид именно ему. Теперь каждая строка
 * команды говорит, принимает ли агент лиды (takesLeads), и пульт выбирает
 * только среди принимающих. Сама команда на плитке остаётся полной.
 */

const runId = Date.now();
const tail = String(runId).slice(-6);
let adminId = "";
let adminToken = "";
let workingId = "";
let frozenId = "";
let pausedId = "";

beforeAll(async () => {
  const admin = await prisma.agent.create({
    data: { fullName: `Админ F2 ${runId}`, phone: `+99277${tail}1`, role: "ADMIN", passwordHash: "x" },
  });
  adminId = admin.id;
  adminToken = signAccessToken({ sub: admin.id, role: "ADMIN" });
  workingId = (
    await prisma.agent.create({
      data: { fullName: `Работает F2 ${runId}`, phone: `+99277${tail}2`, role: "AGENT", passwordHash: "x" },
    })
  ).id;
  frozenId = (
    await prisma.agent.create({
      data: {
        fullName: `Заморожен F2 ${runId}`,
        phone: `+99277${tail}3`,
        role: "AGENT",
        passwordHash: "x",
        frozenAt: new Date(),
        frozenReason: "тест",
      },
    })
  ).id;
  pausedId = (
    await prisma.agent.create({
      data: {
        fullName: `Пауза F2 ${runId}`,
        phone: `+99277${tail}4`,
        role: "AGENT",
        passwordHash: "x",
        leadsPausedUntil: new Date(Date.now() + 60 * 60 * 1000),
      },
    })
  ).id;
  invalidatePultModuleCache();
  invalidateMissionControlCache();
});

afterAll(async () => {
  await deleteAgentsWithTraces([adminId, workingId, frozenId, pausedId]);
  invalidateMissionControlCache();
});

describe("GET /dashboard/mission-control — team.agents[].takesLeads (F2)", () => {
  it("замороженный и на паузе приёма — takesLeads=false, остальные — true; в списке остаются все", async () => {
    const res = await request(app).get("/api/v1/dashboard/mission-control").set("Authorization", `Bearer ${adminToken}`);
    expect(res.status).toBe(200);
    const rows = res.body.team.agents as { id: string; takesLeads?: boolean }[];
    const byId = new Map(rows.map((r) => [r.id, r]));
    expect(byId.get(workingId)?.takesLeads).toBe(true);
    expect(byId.get(frozenId)?.takesLeads).toBe(false);
    expect(byId.get(pausedId)?.takesLeads).toBe(false);
  });
});
