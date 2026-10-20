import { afterAll, beforeAll, describe, expect, it } from "vitest";
import request from "supertest";
import { app } from "../src/app.js";
import { prisma } from "../src/db.js";
import { signAccessToken } from "../src/auth/jwt.js";
import { dushanbeWallClock } from "../src/lib/dushanbeTime.js";
import { invalidateMissionControlCache } from "../src/lib/missionControlCache.js";
import { invalidatePultModuleCache } from "../src/lib/pultModules.js";

/**
 * «Пульс компании» (GET /dashboard/mission-control, план 31.08.2026) — экран для
 * ADMIN/DIRECTOR. Проверяем то, ради чего он строился: право закрывает доступ,
 * ответ приходит одним куском со всеми ярусами, а MANAGER (у которого
 * dashboard.analytics есть, а finance.view нет) не видит денег.
 */

const runId = Date.now();
let agentToken = "";
let adminToken = "";
let managerToken = "";
let agentId = "";
let adminId = "";
let managerId = "";

async function missionControl(token: string) {
  return request(app).get("/api/v1/dashboard/mission-control").set("Authorization", `Bearer ${token}`);
}

beforeAll(async () => {
  const agent = await prisma.agent.create({
    data: { fullName: `Агент MC ${runId}`, phone: `+99271${String(runId).slice(-7)}`, role: "AGENT", passwordHash: "x" },
  });
  const admin = await prisma.agent.create({
    data: { fullName: `Админ MC ${runId}`, phone: `+99272${String(runId).slice(-7)}`, role: "ADMIN", passwordHash: "x" },
  });
  const manager = await prisma.agent.create({
    data: { fullName: `Менеджер MC ${runId}`, phone: `+99273${String(runId).slice(-7)}`, role: "MANAGER", passwordHash: "x" },
  });
  agentId = agent.id;
  adminId = admin.id;
  managerId = manager.id;
  agentToken = signAccessToken({ sub: agent.id, role: "AGENT" });
  adminToken = signAccessToken({ sub: admin.id, role: "ADMIN" });
  managerToken = signAccessToken({ sub: manager.id, role: "MANAGER" });
  // Тест не зависит от того, что сейчас лежит в PultModule (как в
  // mission-control-cache.test.ts): убираем возможный оффнутый тумблер "team",
  // чтобы отсутствие строки трактовалось как "включён" (см. lib/pultModules.ts).
  await prisma.pultModule.deleteMany({ where: { id: "team" } });
  invalidatePultModuleCache();
  invalidateMissionControlCache();
});

afterAll(async () => {
  await prisma.agent.deleteMany({ where: { id: { in: [agentId, adminId, managerId] } } });
  await prisma.pultModule.deleteMany({ where: { id: "team" } });
  invalidatePultModuleCache();
  invalidateMissionControlCache();
  await prisma.$disconnect();
});

describe("GET /dashboard/mission-control", () => {
  it("рядовому агенту закрыт — нет dashboard.analytics", async () => {
    const res = await missionControl(agentToken);
    expect(res.status).toBe(403);
  });

  it("админу отдаёт все ярусы одним ответом, деньги видны", async () => {
    const res = await missionControl(adminToken);
    expect(res.status).toBe(200);
    expect(res.body.seesMoney).toBe(true);
    for (const key of ["hero", "firstLine", "team", "calls", "bot", "marketing", "video", "properties", "system"]) {
      expect(res.body).toHaveProperty(key);
    }
    expect(res.body.hero.commission).not.toBeNull();
    expect(res.body.hero.leadsToday).toHaveProperty("count");
    expect(res.body.firstLine).toHaveProperty("items");
    expect(Array.isArray(res.body.firstLine.items)).toBe(true);
    // Никогда не показываем демо-нолики: если крон ни разу не отчитывался, это
    // видно как lastRunAt/lastOkAt = null, а не подставная нулевая цифра.
    expect(Array.isArray(res.body.system.crons)).toBe(true);
  });

  it("MANAGER видит dashboard.analytics, но не деньги — seesMoney=false и суммы скрыты", async () => {
    const res = await missionControl(managerToken);
    expect(res.status).toBe(200);
    expect(res.body.seesMoney).toBe(false);
    expect(res.body.hero.commission).toBeNull();
    expect(res.body.hero.profit).toBeNull();
    expect(res.body.properties.portfolioValueTjs).toBeNull();
  });

  /**
   * Регрессия на баг, найденный аудитом 02.09.2026 (docs/audit-02-09-2026/06-dashboard.md):
   * writer (ai/guardMetrics.ts::guardFired) пишет GuardHit.day через
   * dushanbeWallClock().toISOString().slice(0,10) — душанбинское время как
   * «поддельный UTC». Роут читал через dushanbeStartOfToday(now).toISOString() —
   * НАСТОЯЩИЙ момент UTC душанбинской полуночи, чей календарный день — ВЧЕРАШНИЙ
   * (полночь в Душанбе = 19:00 UTC предыдущих суток). «Сторож сегодня» всегда
   * показывал 0, даже если сработки были прямо сейчас.
   */
  it("guardHitsToday видит срабатывание, записанное сегодня по Душанбе (регрессия даты)", async () => {
    const day = dushanbeWallClock().toISOString().slice(0, 10);
    await prisma.guardHit.upsert({
      where: { day_guard: { day, guard: "banned_word" } },
      update: { count: { increment: 1 } },
      create: { day, guard: "banned_word", count: 1 },
    });
    // Секция "bot" кэшируется на 60с (lib/missionControlCache.ts) — предыдущий
    // тест в этом файле уже дёрнул /mission-control и заполнил кэш до вставки
    // строки выше. Без сброса запрос ниже видит устаревший guardHitsToday=0.
    invalidateMissionControlCache();
    try {
      const res = await missionControl(adminToken);
      expect(res.status).toBe(200);
      expect(res.body.bot.guardHitsToday).toBeGreaterThanOrEqual(1);
    } finally {
      await prisma.guardHit.delete({ where: { day_guard: { day, guard: "banned_word" } } }).catch(() => null);
    }
  });
});

/**
 * Регрессия на второй баг того же аудита: pendingAccept (team-зона) считал
 * непринятых БЕЗ фильтра по статусу — карточка, ушедшая в LOST/INACTIVE/
 * ARCHIVED так и не будучи принятой агентом, висела в счётчике «непринятых»
 * навсегда вместо того чтобы исчезнуть вместе с уходом из активной работы.
 */
describe("GET /dashboard/mission-control — team.pendingAccept исключает терминальные статусы", () => {
  const runId2 = Date.now() + 1;
  let adminToken2 = "";
  let teamAgentId = "";
  let adminId2 = "";
  const clientIds: string[] = [];

  beforeAll(async () => {
    const admin = await prisma.agent.create({
      data: { fullName: `Админ MC-team ${runId2}`, phone: `+99274${String(runId2).slice(-7)}`, role: "ADMIN", passwordHash: "x" },
    });
    adminId2 = admin.id;
    adminToken2 = signAccessToken({ sub: admin.id, role: "ADMIN" });
    const agent = await prisma.agent.create({
      data: { fullName: `Агент MC-team ${runId2}`, phone: `+99275${String(runId2).slice(-7)}`, role: "AGENT", passwordHash: "x", isActive: true },
    });
    teamAgentId = agent.id;

    // Никогда не принятый, но уже LOST — терминальный, не должен считаться.
    const lost = await prisma.client.create({
      data: {
        fullName: `Непринятый LOST ${runId2}`,
        phone: `+99276${String(runId2).slice(-7)}`,
        kind: "BUYER",
        source: "PHONE_CALL",
        status: "LOST",
        workStatus: "ACTIVE",
        assignedAgentId: teamAgentId,
        acceptedAt: null,
      },
    });
    // Никогда не принятый, живой — должен считаться.
    const active = await prisma.client.create({
      data: {
        fullName: `Непринятый живой ${runId2}`,
        phone: `+99277${String(runId2).slice(-7)}`,
        kind: "BUYER",
        source: "PHONE_CALL",
        status: "NEW",
        workStatus: "ACTIVE",
        assignedAgentId: teamAgentId,
        acceptedAt: null,
      },
    });
    clientIds.push(lost.id, active.id);
  });

  afterAll(async () => {
    await prisma.client.deleteMany({ where: { id: { in: clientIds } } });
    await prisma.agent.deleteMany({ where: { id: { in: [teamAgentId, adminId2] } } });
  });

  it("считает только живого непринятого, не LOST", async () => {
    // Зона «Команда» кэшируется 60 с (lib/missionControlCache.ts) — клиенты выше
    // созданы после запросов первого describe, кэш надо сбросить явно.
    invalidateMissionControlCache();
    const res = await request(app)
      .get("/api/v1/dashboard/mission-control")
      .set("Authorization", `Bearer ${adminToken2}`);
    expect(res.status).toBe(200);
    const row = res.body.team.agents.find((a: { id: string }) => a.id === teamAgentId);
    expect(row).toBeDefined();
    expect(row.pendingAccept).toBe(1);
  });
});
