import { afterAll, beforeAll, describe, expect, it } from "vitest";
import request from "supertest";
import { app } from "../src/app.js";
import { prisma } from "../src/db.js";
import { signAccessToken } from "../src/auth/jwt.js";
import { invalidateMissionControlCache } from "../src/lib/missionControlCache.js";
import { invalidatePultModuleCache } from "../src/lib/pultModules.js";

/**
 * ПУЛЬТ ДИРЕКТОРА, ПАЧКА A (23.10.2026): данные сервера, которых не хватало экрану.
 *  1. «Клиент завис» — по давности тишины (Client.lastContactAt), а не 5 новейших.
 *  2. system.unresolvedTotal — все нерешённые ошибки; resolve-all {scope:"all"}.
 *  3. marketing.channels.problems / openaiOutOfMoney — из снимка самопроверки.
 *  4. marketing.instagramCommentsWaiting на месте.
 *  5. hero.commission.planIsDefault.
 */

const runId = Date.now();
const tail = String(runId).slice(-7);
const DAY = 86_400_000;
let token = "";
let adminId = "";
const clientIds: string[] = [];
const errorIds: string[] = [];
const snapshotNames = [`Тест-канал ${runId}`, `Тест-канал ок ${runId}`];

async function mc() {
  invalidateMissionControlCache();
  return request(app).get("/api/v1/dashboard/mission-control").set("Authorization", `Bearer ${token}`);
}

async function mkClient(name: string, daysSilent: number) {
  const c = await prisma.client.create({
    data: {
      fullName: `${name} ${runId}`,
      phone: `+9929${String(Math.floor(Math.random() * 1e8)).padStart(8, "0")}`,
      kind: "BUYER",
      source: "PHONE_CALL",
      status: "NEW",
      workStatus: "ACTIVE",
      lastContactAt: new Date(Date.now() - daysSilent * DAY),
    },
  });
  clientIds.push(c.id);
  return c;
}

beforeAll(async () => {
  const admin = await prisma.agent.create({
    data: { fullName: `Админ PultA ${runId}`, phone: `+99272${tail}`, role: "ADMIN", passwordHash: "x" },
  });
  adminId = admin.id;
  token = signAccessToken({ sub: admin.id, role: "ADMIN" });
  await prisma.pultModule.deleteMany({});
  invalidatePultModuleCache();
});

afterAll(async () => {
  await prisma.client.deleteMany({ where: { id: { in: clientIds } } });
  await prisma.errorLog.deleteMany({ where: { id: { in: errorIds } } });
  await prisma.integrationHealthSnapshot.deleteMany({ where: { name: { in: snapshotNames } } });
  await prisma.agent.deleteMany({ where: { id: adminId } });
  invalidateMissionControlCache();
});

describe("1. клиент завис", () => {
  it("самые давно молчащие первыми; свежий клиент в список не попадает", async () => {
    const fresh = await mkClient("Свежий", 0);
    const mid = await mkClient("Тишина4", 4999);
    const old = await mkClient("Тишина20", 5000);
    const res = await mc();
    expect(res.status).toBe(200);
    const d = res.body.hero.dealsInPipeline;
    const ids: string[] = d.items.map((i: { id: string }) => i.id);
    expect(ids).not.toContain(fresh.id);
    expect(ids).toContain(mid.id);
    expect(ids.indexOf(old.id)).toBeLessThan(ids.indexOf(mid.id));
    expect(d.items.length).toBeLessThanOrEqual(5);
    expect(d.stuckTotal).toBeGreaterThanOrEqual(2);
    expect(d.stuckDays).toBe(3);
    const row = d.items.find((i: { id: string }) => i.id === old.id);
    expect(row.silentDays).toBe(5000);
    expect(row.tone).toBe("warn");
    expect(row.hint).toContain("Без движения 5000");
    expect(row.href).toMatch(/^\/clients\//);
  });
});

describe("2. все нерешённые ошибки", () => {
  it("unresolvedTotal считает старые, errorsToday только сегодняшние; resolve-all scope=all закрывает всё", async () => {
    const before = await mc();
    const base = before.body.system.unresolvedTotal as number;
    const baseToday = before.body.system.errorsToday as number;
    const oldErr = await prisma.errorLog.create({
      data: { source: "api", message: `Старая PultA ${runId}`, createdAt: new Date(Date.now() - 10 * DAY) },
    });
    errorIds.push(oldErr.id);
    const after = await mc();
    expect(after.body.system.unresolvedTotal).toBe(base + 1);
    expect(after.body.system.errorsToday).toBe(baseToday);

    const r = await request(app).post("/api/v1/errors/resolve-all").set("Authorization", `Bearer ${token}`).send({ scope: "all" });
    expect(r.status).toBe(200);
    expect((await prisma.errorLog.findUniqueOrThrow({ where: { id: oldErr.id } })).resolvedAt).not.toBeNull();
    const done = await mc();
    expect(done.body.system.unresolvedTotal).toBe(0);
  });

  it("resolve-all отклоняет неизвестный scope", async () => {
    const r = await request(app).post("/api/v1/errors/resolve-all").set("Authorization", `Bearer ${token}`).send({ scope: "week" });
    expect(r.status).toBe(400);
  });
});

describe("3. каналы по снимку самопроверки и деньги OpenAI", () => {
  it("сломанный канал попадает в problems с путём; живой нет", async () => {
    await prisma.integrationHealthSnapshot.createMany({
      data: [
        { name: snapshotNames[0], ok: false, detail: "токен отозван" },
        { name: snapshotNames[1], ok: true, detail: "ok" },
      ],
    });
    const res = await mc();
    const ch = res.body.marketing.channels;
    const bad = ch.problems.find((p: { channel: string }) => p.channel === snapshotNames[0]);
    expect(bad).toMatchObject({ problem: "токен отозван", fixPath: "/integrations" });
    expect(new Date(bad.checkedAt).getTime()).not.toBeNaN();
    expect(ch.problems.some((p: { channel: string }) => p.channel === snapshotNames[1])).toBe(false);
    expect(typeof ch.healthCheckedAt).toBe("string");
  });

  it("openaiOutOfMoney: true при свежей нерешённой ошибке «закончились деньги», false после разбора", async () => {
    const e = await prisma.errorLog.create({
      data: { source: "ai", message: `Обложка: На счёте OpenAI закончились деньги ${runId}` },
    });
    errorIds.push(e.id);
    expect((await mc()).body.marketing.channels.openaiOutOfMoney).toBe(true);
    await prisma.errorLog.update({ where: { id: e.id }, data: { resolvedAt: new Date() } });
    expect((await mc()).body.marketing.channels.openaiOutOfMoney).toBe(false);
  });
});

describe("4. комментарии Instagram", () => {
  it("marketing.instagramCommentsWaiting число", async () => {
    const res = await mc();
    expect(typeof res.body.marketing.instagramCommentsWaiting).toBe("number");
  });
});

describe("5. план комиссии", () => {
  it("planIsDefault=true при 8000 и false при заданном плане", async () => {
    const prev = await prisma.settings.findUnique({ where: { id: "singleton" }, select: { monthlyCommissionPlan: true } });
    try {
      await prisma.settings.upsert({
        where: { id: "singleton" },
        create: { id: "singleton", monthlyCommissionPlan: 8000 },
        update: { monthlyCommissionPlan: 8000 },
      });
      expect((await mc()).body.hero.commission.planIsDefault).toBe(true);
      await prisma.settings.update({ where: { id: "singleton" }, data: { monthlyCommissionPlan: 12345 } });
      expect((await mc()).body.hero.commission.planIsDefault).toBe(false);
    } finally {
      if (prev) await prisma.settings.update({ where: { id: "singleton" }, data: { monthlyCommissionPlan: prev.monthlyCommissionPlan } });
    }
  });
});
