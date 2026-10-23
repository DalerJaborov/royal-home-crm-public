import { afterAll, beforeAll, describe, expect, it } from "vitest";
import request from "supertest";
import { app } from "../src/app.js";
import { prisma } from "../src/db.js";
import { signAccessToken } from "../src/auth/jwt.js";
import { invalidateMissionControlCache } from "../src/lib/missionControlCache.js";
import { invalidatePultModuleCache } from "../src/lib/pultModules.js";

/**
 * Задача L2-T3 (docs/pult/theme-2026/tasks-theme-2026.md, D6): расширение
 * GET /dashboard/mission-control — присутствие «Команда» (lastSeenAt) и items[]
 * (до 5 штук) в зонах вместо голого count. Проверяем и новые поля, и что старые
 * не пропали — обратная совместимость обязательна (пульт v8 читает те же ключи).
 */

const runId = Date.now();
let adminToken = "";
let adminId = "";
let agentId = "";
const clientIds: string[] = [];

async function missionControl(token: string) {
  return request(app).get("/api/v1/dashboard/mission-control").set("Authorization", `Bearer ${token}`);
}

beforeAll(async () => {
  const admin = await prisma.agent.create({
    data: { fullName: `Админ L2T3 ${runId}`, phone: `+99278${String(runId).slice(-7)}`, role: "ADMIN", passwordHash: "x" },
  });
  adminId = admin.id;
  adminToken = signAccessToken({ sub: admin.id, role: "ADMIN" });

  const agent = await prisma.agent.create({
    data: {
      fullName: `Агент L2T3 ${runId}`,
      phone: `+99279${String(runId).slice(-7)}`,
      role: "AGENT",
      passwordHash: "x",
      isActive: true,
      lastSeenAt: new Date(),
    },
  });
  agentId = agent.id;

  // Клиент в активной воронке — должен попасть в hero.dealsInPipeline.items.
  const client = await prisma.client.create({
    data: {
      fullName: `Клиент в воронке L2T3 ${runId}`,
      phone: `+99280${String(runId).slice(-7)}`,
      kind: "BUYER",
      source: "PHONE_CALL",
      status: "NEW",
      workStatus: "ACTIVE",
      assignedAgentId: agentId,
      // «Завис» = без работы 3+ дней (5000 — чтобы обойти чужих давно молчащих в общей базе) (hero.dealsInPipeline.items, 23.10.2026).
      lastContactAt: new Date(Date.now() - 5000 * 86_400_000),
    },
  });
  clientIds.push(client.id);

  invalidatePultModuleCache();
  invalidateMissionControlCache();
});

afterAll(async () => {
  await prisma.client.deleteMany({ where: { id: { in: clientIds } } });
  await prisma.agent.deleteMany({ where: { id: { in: [agentId, adminId] } } });
  invalidateMissionControlCache();
  await prisma.$disconnect();
});

describe("GET /dashboard/mission-control — L2-T3: присутствие и items[]", () => {
  it("team.agents несёт lastSeenAt рядом со старыми полями", async () => {
    const res = await missionControl(adminToken);
    expect(res.status).toBe(200);
    const row = res.body.team.agents.find((a: { id: string }) => a.id === agentId);
    expect(row).toBeDefined();
    // Старые поля никуда не делись.
    expect(row).toHaveProperty("pendingAccept");
    expect(row).toHaveProperty("activeLoad");
    // Новое поле — ISO-строка недавнего lastSeenAt.
    expect(typeof row.lastSeenAt).toBe("string");
    expect(new Date(row.lastSeenAt).getTime()).not.toBeNaN();
  });

  it("team.agents.lastSeenAt = null у агента, который ни разу не заходил", async () => {
    const neverSeen = await prisma.agent.create({
      data: {
        fullName: `Никогда не заходил L2T3 ${runId}`,
        phone: `+99281${String(runId).slice(-7)}`,
        role: "AGENT",
        passwordHash: "x",
        isActive: true,
      },
    });
    try {
      invalidateMissionControlCache();
      const res = await missionControl(adminToken);
      expect(res.status).toBe(200);
      const row = res.body.team.agents.find((a: { id: string }) => a.id === neverSeen.id);
      expect(row).toBeDefined();
      expect(row.lastSeenAt).toBeNull();
    } finally {
      await prisma.agent.delete({ where: { id: neverSeen.id } });
    }
  });

  it("hero.dealsInPipeline: count/byStage на месте, items — до 5, с id/title/href/tone/hint", async () => {
    const res = await missionControl(adminToken);
    expect(res.status).toBe(200);
    expect(res.body.hero.dealsInPipeline).toHaveProperty("count");
    expect(res.body.hero.dealsInPipeline).toHaveProperty("byStage");
    const items = res.body.hero.dealsInPipeline.items;
    expect(Array.isArray(items)).toBe(true);
    expect(items.length).toBeLessThanOrEqual(5);
    const mine = items.find((i: { id: string }) => i.id === clientIds[0]);
    expect(mine).toBeDefined();
    expect(typeof mine.title).toBe("string");
    expect(typeof mine.href).toBe("string");
    expect(["ok", "warn", "crit"]).toContain(mine.tone);
    expect(typeof mine.hint).toBe("string");
  });

  it("properties: available/newThisWeek/reserved/portfolioValueTjs на месте, items — до 5", async () => {
    const res = await missionControl(adminToken);
    expect(res.status).toBe(200);
    expect(res.body.properties).toHaveProperty("available");
    expect(res.body.properties).toHaveProperty("newThisWeek");
    expect(res.body.properties).toHaveProperty("reserved");
    expect(res.body.properties).toHaveProperty("portfolioValueTjs");
    const items = res.body.properties.items;
    expect(Array.isArray(items)).toBe(true);
    expect(items.length).toBeLessThanOrEqual(5);
    if (items.length > 0) {
      const [first] = items;
      expect(typeof first.id).toBe("string");
      expect(typeof first.title).toBe("string");
      expect(typeof first.href).toBe("string");
      expect(["ok", "warn", "crit"]).toContain(first.tone);
      expect(typeof first.hint).toBe("string");
    }
  });
});

describe("GET /dashboard/modules — модуль sound зарегистрирован", () => {
  it("присутствует, kind=preference, включён по умолчанию", async () => {
    const res = await request(app).get("/api/v1/dashboard/modules").set("Authorization", `Bearer ${adminToken}`);
    expect(res.status).toBe(200);
    const row = res.body.modules.find((m: { id: string }) => m.id === "sound");
    expect(row).toBeDefined();
    expect(row.kind).toBe("preference");
    expect(row.enabled).toBe(true);
  });
});
