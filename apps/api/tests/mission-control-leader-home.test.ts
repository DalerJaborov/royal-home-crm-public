import { afterAll, beforeAll, describe, expect, it } from "vitest";
import request from "supertest";
import { app } from "../src/app.js";
import { prisma } from "../src/db.js";
import { signAccessToken } from "../src/auth/jwt.js";
import { invalidateMissionControlCache } from "../src/lib/missionControlCache.js";
import { computePreviousMonthCommission } from "../src/lib/dashboardInsights.js";

/**
 * ГЛАВНАЯ РУКОВОДИТЕЛЯ (20.11.2026): данные, которых не хватало плите денег и «Команде».
 *  1. Прошлый месяц на ту же точку месяца и целиком — честное сравнение комиссии.
 *  2. hero.commission несёт previousMonth* и pipeline (ожидаемая комиссия по сделкам
 *     в работе) — только при праве на деньги; у РОП и менеджера денег нет вовсе.
 *  3. team.workdayStartAt — начало рабочего дня сегодня (для «сегодня не заходил»).
 *
 * Сделки прошлого месяца лежат в 2001 году: ни одна выборка «с начала этого месяца»
 * соседних тестов их не видит, а агент у них свой.
 */

const runId = String(Date.now()).slice(-7);
const ids = { agents: [] as string[], clients: [] as string[], properties: [] as string[], districts: [] as string[] };
let directorToken = "";
let ropToken = "";
let managerToken = "";

/** Момент по Душанбе (UTC+5) как настоящий Date. */
const tj = (iso: string) => new Date(Date.parse(`${iso}+05:00`));

beforeAll(async () => {
  const mk = async (role: "DIRECTOR" | "HEAD_OF_SALES" | "MANAGER", n: number) => {
    const a = await prisma.agent.create({ data: { fullName: `Главная руководителя ${role} ${runId}`, phone: `+9928${n}${runId}`, role, passwordHash: "x" } });
    ids.agents.push(a.id);
    return signAccessToken({ sub: a.id, role });
  };
  directorToken = await mk("DIRECTOR", 3);
  ropToken = await mk("HEAD_OF_SALES", 4);
  managerToken = await mk("MANAGER", 5);

  const district = await prisma.district.create({ data: { name: `Тест-район-главная-${runId}` } });
  ids.districts.push(district.id);
  const property = await prisma.property.create({
    data: { title: `Объект главной ${runId}`, type: "APARTMENT", areaSqm: 50, price: 40000, currency: "TJS", districtId: district.id, address: "Тестовая, 1", condition: "GOOD" },
  });
  ids.properties.push(property.id);
  const client = await prisma.client.create({ data: { fullName: `Клиент главной ${runId}`, phone: `+9927${runId}9`, source: "PHONE_CALL" } });
  ids.clients.push(client.id);
  const deal = (closedAt: Date, commissionAmount: number) => prisma.deal.create({
    data: { clientId: client.id, propertyId: property.id, agentId: ids.agents[0], stage: "COMPLETED", commissionAmount, currency: "TJS", startedAt: closedAt, closedAt },
  });
  // Февраль 2001: 28 дней. 5-го — 100 с., 20-го — 50 с.; март 2001 — 7 с. (это уже «этот месяц»).
  await deal(tj("2001-02-05T12:00:00"), 100);
  await deal(tj("2001-02-20T12:00:00"), 50);
  await deal(tj("2001-03-02T12:00:00"), 7);
});

afterAll(async () => {
  await prisma.deal.deleteMany({ where: { clientId: { in: ids.clients } } });
  await prisma.client.deleteMany({ where: { id: { in: ids.clients } } });
  await prisma.property.deleteMany({ where: { id: { in: ids.properties } } });
  await prisma.district.deleteMany({ where: { id: { in: ids.districts } } });
  await prisma.agent.deleteMany({ where: { id: { in: ids.agents } } });
  invalidateMissionControlCache();
});

describe("1. прошлый месяц для сравнения", () => {
  it("10 марта 15:00 — февраль по 10-е 15:00 (100), февраль целиком (150); мартовская сделка не в счёт", async () => {
    const r = await computePreviousMonthCommission(tj("2001-03-10T15:00:00"));
    expect(r).toEqual({ toDate: 100, total: 150 });
  });

  it("31 марта — точка упирается в конец короткого февраля: весь февраль", async () => {
    const r = await computePreviousMonthCommission(tj("2001-03-31T15:00:00"));
    expect(r).toEqual({ toDate: 150, total: 150 });
  });

  it("1 марта 00:30 по Душанбе — граница месяца по Душанбе, а не по UTC: прошлый месяц — февраль", async () => {
    // В UTC это ещё 28 февраля 19:30: будь граница по UTC, «прошлым» оказался бы январь (0).
    const r = await computePreviousMonthCommission(tj("2001-03-01T00:30:00"));
    expect(r.total).toBe(150);
    expect(r.toDate).toBe(0);
  });
});

async function mc(token: string) {
  invalidateMissionControlCache();
  return request(app).get("/api/v1/dashboard/mission-control").set("Authorization", `Bearer ${token}`);
}

describe("2. плита денег в снимке пульта — только при праве на деньги", () => {
  it("директору: прошлый месяц и ожидаемая комиссия по сделкам в работе — числа", async () => {
    const res = await mc(directorToken);
    expect(res.status).toBe(200);
    const c = res.body.hero.commission;
    expect(c).not.toBeNull();
    expect(typeof c.previousMonthToDate).toBe("number");
    expect(typeof c.previousMonthTotal).toBe("number");
    expect(c.previousMonthToDate).toBeLessThanOrEqual(c.previousMonthTotal);
    expect(Number.isInteger(c.pipeline.deals)).toBe(true);
    expect(c.pipeline.expectedTjs).toBeGreaterThanOrEqual(0);
  });

  it("РОП и менеджер (без finance.view) денег не получают: commission = null", async () => {
    for (const token of [ropToken, managerToken]) {
      const res = await mc(token);
      expect(res.status).toBe(200);
      expect(res.body.hero.commission).toBeNull();
      expect(JSON.stringify(res.body.hero)).not.toMatch(/previousMonth|expectedTjs/);
    }
  });
});

describe("4. просроченные задачи агента в разделе «Команда»", () => {
  it("своя задача и записанная ботом от лица держателя — обе в счёт; выполненная и будущая — нет", async () => {
    const agent = await prisma.agent.create({ data: { fullName: `Агент просрочек ${runId}`, phone: `+9928${6}${runId}`, role: "AGENT", passwordHash: "x" } });
    ids.agents.push(agent.id);
    const clientId = ids.clients[0];
    const past = new Date(Date.now() - 3 * 86_400_000);
    await prisma.interaction.createMany({
      data: [
        { clientId, agentId: agent.id, type: "CALL", notes: "н", nextAction: "перезвонить", nextActionDate: past },
        { clientId, agentId: null, subjectAgentId: agent.id, actorKind: "AI", type: "SYSTEM", notes: "н", nextAction: "написать", nextActionDate: past },
        { clientId, agentId: agent.id, type: "CALL", notes: "н", nextAction: "сделано", nextActionDate: past, completedAt: new Date() },
        { clientId, agentId: agent.id, type: "CALL", notes: "н", nextAction: "завтра", nextActionDate: new Date(Date.now() + 86_400_000) },
      ],
    });
    try {
      const res = await mc(directorToken);
      expect(res.status).toBe(200);
      const row = res.body.team.agents.find((a: { id: string }) => a.id === agent.id);
      expect(row?.overdueTasks).toBe(2);
    } finally {
      await prisma.interaction.deleteMany({ where: { OR: [{ agentId: agent.id }, { subjectAgentId: agent.id }] } });
    }
  });
});

describe("3. начало рабочего дня в разделе «Команда»", () => {
  it("team.workdayStartAt — сегодняшний час из Настроек по Душанбе", async () => {
    const settings = await prisma.settings.findUnique({ where: { id: "singleton" }, select: { workHoursStart: true } });
    const res = await mc(directorToken);
    expect(res.status).toBe(200);
    const at = new Date(res.body.team.workdayStartAt);
    expect(Number.isNaN(at.getTime())).toBe(false);
    const wall = new Date(at.getTime() + 5 * 3600_000);
    const hhmm = `${String(wall.getUTCHours()).padStart(2, "0")}:${String(wall.getUTCMinutes()).padStart(2, "0")}`;
    expect(hhmm).toBe(settings?.workHoursStart ?? "09:30");
    const today = new Date(Date.now() + 5 * 3600_000).toISOString().slice(0, 10);
    expect(wall.toISOString().slice(0, 10)).toBe(today);
  });
});
