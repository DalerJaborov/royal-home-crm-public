import { afterAll, beforeAll, describe, expect, it } from "vitest";
import bcrypt from "bcrypt";
import request from "supertest";
import { app } from "../src/app.js";
import { prisma } from "../src/db.js";
import { grantElevation } from "../src/lib/stepUp.js";
import { invalidateMissionControlCache } from "../src/lib/missionControlCache.js";
import { invalidatePultModuleCache } from "../src/lib/pultModules.js";

/** Два темпа опроса пульта (аудит 02.09.2026 §2 п.2): live/zones, серверный кэш
 *  секций и его сброс при переключении модуля — тумблер обязан отражаться сразу. */

const runId = Date.now();
const password = "testpass123";
let adminId: string;
let adminToken: string;
let agentId: string | null = null;

function get(path: string) {
  return request(app).get(`/api/v1/dashboard/${path}`).set("Authorization", `Bearer ${adminToken}`);
}
function toggle(id: string, enabled: boolean) {
  return request(app)
    .patch(`/api/v1/dashboard/modules/${id}`)
    .set("Authorization", `Bearer ${adminToken}`)
    .send({ enabled });
}

beforeAll(async () => {
  const passwordHash = await bcrypt.hash(password, 10);
  const admin = await prisma.agent.create({
    data: { fullName: "Админ кэша пульта", phone: `+992939${runId}`, role: "ADMIN", passwordHash },
  });
  adminId = admin.id;
  adminToken = (await request(app).post("/api/v1/auth/login").send({ phone: admin.phone, password })).body.accessToken;
  grantElevation(adminId);
  await prisma.pultModule.deleteMany({ where: { id: "team" } });
  invalidatePultModuleCache();
  invalidateMissionControlCache();
});

afterAll(async () => {
  await prisma.pultModule.deleteMany({ where: { id: "team" } });
  invalidatePultModuleCache();
  invalidateMissionControlCache();
  await prisma.auditLog.deleteMany({ where: { agentId: adminId } });
  await prisma.agent.deleteMany({ where: { id: { in: [adminId, ...(agentId ? [agentId] : [])] } } });
});

describe("live / zones", () => {
  it("live отдаёт герой-строку, первую линию и звонки; zones — остальное", async () => {
    const live = await get("mission-control/live");
    expect(live.status).toBe(200);
    expect(Object.keys(live.body).sort()).toEqual(["calls", "firstLine", "generatedAt", "hero", "modulesOff", "seesMoney"]);
    const zones = await get("mission-control/zones");
    expect(zones.status).toBe(200);
    // clientsZone и commission12 добавлены 12.09.2026 вместе с блоками, которые
    // до этого показывали «нет данных» (раздел «Клиенты» и полоса «Комиссия ·
    // 12 месяцев» тумблера в реестре модулей не имеют — идут всегда, а
    // commission12 ещё и за гейтом finance.view, который у админа есть).
    expect(Object.keys(zones.body).sort()).toEqual([
      "bot",
      "clientsZone",
      "commission12",
      "generatedAt",
      "leaderboard",
      "marketing",
      "modulesOff",
      "properties",
      "seesMoney",
      "system",
      "team",
      "video",
    ]);
  });

  it("зоны кэшируются 60 с: новый агент виден только после сброса кэша", async () => {
    invalidateMissionControlCache();
    const primed = await get("mission-control/zones");
    expect(primed.status).toBe(200);
    const agent = await prisma.agent.create({
      data: { fullName: "Агент кэша пульта", phone: `+992940${runId}`, role: "AGENT", passwordHash: "x" },
    });
    agentId = agent.id;
    const stale = await get("mission-control/zones");
    expect(stale.body.team.agents.some((a: { id: string }) => a.id === agentId)).toBe(false);
    invalidateMissionControlCache();
    const fresh = await get("mission-control/zones");
    expect(fresh.body.team.agents.some((a: { id: string }) => a.id === agentId)).toBe(true);
  });

  it("переключение тумблера сбрасывает кэш: секция пропадает и возвращается сразу", async () => {
    const before = await get("mission-control/zones");
    expect(before.body).toHaveProperty("team");
    expect((await toggle("team", false)).status).toBe(200);
    const off = await get("mission-control/zones");
    expect(off.body).not.toHaveProperty("team");
    expect(off.body.modulesOff).toContain("team");
    expect((await toggle("team", true)).status).toBe(200);
    const on = await get("mission-control");
    expect(on.body).toHaveProperty("team");
    expect(on.body).toHaveProperty("hero");
    expect(on.body.modulesOff).not.toContain("team");
  });
});
