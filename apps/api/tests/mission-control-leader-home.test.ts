import { afterAll, beforeAll, describe, expect, it } from "vitest";
import request from "supertest";
import { app } from "../src/app.js";
import { prisma } from "../src/db.js";
import { signAccessToken } from "../src/auth/jwt.js";
import { dropMissionControlCache, invalidateMissionControlCache } from "../src/lib/missionControlCache.js";
import { computePreviousMonthCommission } from "../src/lib/dashboardInsights.js";
import { buildCommissionForecast, currentDushanbeMonth } from "../src/lib/financeForecast.js";
import { countOverdueTasksByAgent, overdueTasksOfAgentsWhere } from "../src/lib/tasks.js";
import { dushanbeStartOfMonth } from "../src/lib/dushanbeTime.js";

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

describe("3. начало рабочего дня и выходные в разделе «Команда»", () => {
  it("team.workdayStartAt — сегодняшний час из своей настройки «Начало рабочего дня», а не окна раздачи заявок", async () => {
    const before = await prisma.settings.findUnique({ where: { id: "singleton" }, select: { workdayStart: true, workHoursStart: true } });
    await prisma.settings.update({ where: { id: "singleton" }, data: { workdayStart: "08:15", workHoursStart: "10:45" } });
    try {
      const res = await mc(directorToken);
      expect(res.status).toBe(200);
      const at = new Date(res.body.team.workdayStartAt);
      const wall = new Date(at.getTime() + 5 * 3600_000);
      const hhmm = `${String(wall.getUTCHours()).padStart(2, "0")}:${String(wall.getUTCMinutes()).padStart(2, "0")}`;
      expect(hhmm).toBe("08:15");
      const today = new Date(Date.now() + 5 * 3600_000).toISOString().slice(0, 10);
      expect(wall.toISOString().slice(0, 10)).toBe(today);
    } finally {
      await prisma.settings.update({ where: { id: "singleton" }, data: { workdayStart: before?.workdayStart ?? "09:30", workHoursStart: before?.workHoursStart ?? "09:30" } });
    }
  });

  it("dayOffToday: общий выходной сегодня и личный выходной агента — true; обычный день — false", async () => {
    const weekday = new Date(Date.now() + 5 * 3600_000).getUTCDay();
    const agent = await prisma.agent.create({ data: { fullName: `Агент выходных ${runId}`, phone: `+9928${7}${runId}`, role: "AGENT", passwordHash: "x" } });
    ids.agents.push(agent.id);
    const before = await prisma.settings.findUnique({ where: { id: "singleton" }, select: { companyDaysOff: true } });
    try {
      const plain = await mc(directorToken);
      expect(plain.body.team.agents.find((a: { id: string }) => a.id === agent.id)?.dayOffToday).toBe(before?.companyDaysOff.includes(weekday) ?? false);
      await prisma.agent.update({ where: { id: agent.id }, data: { weeklyDaysOff: [weekday] } });
      const personal = await mc(directorToken);
      expect(personal.body.team.agents.find((a: { id: string }) => a.id === agent.id)?.dayOffToday).toBe(true);
      await prisma.agent.update({ where: { id: agent.id }, data: { weeklyDaysOff: [] } });
      await prisma.settings.update({ where: { id: "singleton" }, data: { companyDaysOff: [weekday] } });
      const company = await mc(directorToken);
      expect(company.body.team.agents.find((a: { id: string }) => a.id === agent.id)?.dayOffToday).toBe(true);
    } finally {
      await prisma.settings.update({ where: { id: "singleton" }, data: { companyDaysOff: before?.companyDaysOff ?? [] } });
    }
  });
});

describe("5. дела за сегодня — по каждому агенту, без обрезки «Дня команды» до 12", () => {
  it("агент с фамилией на «Я» и нулём дел получает actionsToday 0; со звонком сегодня — callsToday 1", async () => {
    const quiet = await prisma.agent.create({ data: { fullName: `Яяя Последний ${runId}`, phone: `+9928${8}${runId}`, role: "AGENT", passwordHash: "x" } });
    const busy = await prisma.agent.create({ data: { fullName: `Яяя Звонивший ${runId}`, phone: `+9928${9}${runId}`, role: "AGENT", passwordHash: "x" } });
    ids.agents.push(quiet.id, busy.id);
    await prisma.interaction.create({ data: { clientId: ids.clients[0], agentId: busy.id, type: "CALL", notes: "н", actorKind: "AGENT" } });
    try {
      const res = await mc(directorToken);
      const row = (id: string) => res.body.team.agents.find((a: { id: string }) => a.id === id);
      expect(row(quiet.id)).toMatchObject({ callsToday: 0, actionsToday: 0 });
      expect(row(busy.id)).toMatchObject({ callsToday: 1, actionsToday: 1 });
    } finally {
      await prisma.interaction.deleteMany({ where: { agentId: busy.id } });
    }
  });
});

describe("6. просрочки по агенту — одно правило для карточки сотрудника и главной", () => {
  it("исполнитель и «от лица» считаются по разу; счёт по агентам совпадает с условием карточки", async () => {
    const [a, b] = await Promise.all([1, 2].map((n) => prisma.agent.create({ data: { fullName: `Просрочки ${n} ${runId}`, phone: `+99277${n}${runId}`, role: "AGENT", passwordHash: "x" } })));
    ids.agents.push(a.id, b.id);
    const past = new Date(Date.now() - 86_400_000);
    const clientId = ids.clients[0];
    await prisma.interaction.createMany({ data: [
      { clientId, agentId: a.id, subjectAgentId: b.id, type: "CALL", notes: "н", nextAction: "1", nextActionDate: past },
      { clientId, agentId: a.id, subjectAgentId: a.id, type: "CALL", notes: "н", nextAction: "2", nextActionDate: past },
      { clientId, agentId: null, subjectAgentId: b.id, actorKind: "AI", type: "SYSTEM", notes: "н", nextAction: "3", nextActionDate: past },
    ] });
    try {
      const now = new Date();
      const byAgent = await countOverdueTasksByAgent(now, [a.id, b.id]);
      expect(byAgent.get(a.id)).toBe(2);
      expect(byAgent.get(b.id)).toBe(2);
      for (const id of [a.id, b.id]) {
        expect(await prisma.interaction.count({ where: overdueTasksOfAgentsWhere(now, [id]) })).toBe(byAgent.get(id));
      }
    } finally {
      await prisma.interaction.deleteMany({ where: { OR: [{ agentId: { in: [a.id, b.id] } }, { subjectAgentId: { in: [a.id, b.id] } }] } });
    }
  });
});

describe("7. добавки к плите денег — свой кэш, живой сброс их не пересчитывает", () => {
  it("после живого сброса прошлый месяц из кэша; после полного — пересчитан", async () => {
    invalidateMissionControlCache();
    const first = await request(app).get("/api/v1/dashboard/mission-control").set("Authorization", `Bearer ${directorToken}`);
    const before = first.body.hero.commission.previousMonthToDate as number;
    // Сделка прошлого месяца в самом его начале — попадает в «ту же точку месяца».
    const prevStart = dushanbeStartOfMonth(new Date(dushanbeStartOfMonth(new Date()).getTime() - 1));
    const deal = await prisma.deal.create({ data: {
      clientId: ids.clients[0], propertyId: ids.properties[0], agentId: ids.agents[0], stage: "COMPLETED",
      commissionAmount: 777, currency: "TJS", startedAt: prevStart, closedAt: new Date(prevStart.getTime() + 3600_000),
    } });
    try {
      dropMissionControlCache("live");
      const live = await request(app).get("/api/v1/dashboard/mission-control").set("Authorization", `Bearer ${directorToken}`);
      expect(live.body.hero.commission.previousMonthToDate).toBe(before);
      invalidateMissionControlCache();
      const all = await request(app).get("/api/v1/dashboard/mission-control").set("Authorization", `Bearer ${directorToken}`);
      expect(all.body.hero.commission.previousMonthToDate).toBeCloseTo(before + 777, 2);
    } finally {
      await prisma.deal.delete({ where: { id: deal.id } });
      invalidateMissionControlCache();
    }
  });

  it("ожидаемая комиссия по сделкам в работе = ожидаемое за месяц − уже полученное (та же оценка, что «Прогноз комиссии»)", async () => {
    const res = await mc(directorToken);
    const forecast = await buildCommissionForecast(currentDushanbeMonth(), new Date());
    expect(res.body.hero.commission.pipeline).toEqual({
      deals: forecast.stages.reduce((sum, stage) => sum + stage.count, 0),
      expectedTjs: Math.max(0, Math.round((forecast.expectedTjs - forecast.factTjs) * 100) / 100),
    });
  });
});
