import { afterAll, beforeAll, describe, expect, it } from "vitest";
import request from "supertest";

/**
 * ВЫХОДНЫЕ — ИЗ НАСТРОЕК, ПО УМОЛЧАНИЮ ИХ НЕТ (владелец 11.10.2026).
 *
 * «У нас нет никаких выходных — робот и телефон всегда в сети; агенты тоже работают
 * каждый день; из настроек можно выбрать, у кого выходной». До этой правки воскресенье
 * было зашито общим выходным (решение 08.09.2026). Здесь — правило целиком:
 *  - одно место правила (packages/shared/src/daysOff.ts) и его значения по умолчанию;
 *  - новый чужой лид в выходной агента ему не выдаётся (acceptingLeadsWhere);
 *  - срок «первый звонок» не истекает в выходной агента, штрафа и ухода лида нет;
 *  - закрепление клиента выходной не меняет НИ В ОДНОМ сценарии;
 *  - закреплённый клиент дежурному/оператору не уходит из-за выходного никогда;
 *  - API принимает и отдаёт оба списка, мусор отклоняет.
 */

const { app } = await import("../src/app.js");
const { prisma } = await import("../src/db.js");
const { signAccessToken } = await import("../src/auth/jwt.js");
const { grantElevation } = await import("../src/lib/stepUp.js");
const shared = await import("@royal-home/shared");
const { acceptingLeadsWhere, isAgentAvailableForLead } = await import("../src/services/leads/selection.js");
const { firstCallPauses, firstCallDueAt, penalizeMissedFirstCalls } = await import("../src/services/leads/firstCall.js");
const { pickTransferAgent } = await import("../src/lib/telephony/liveCallTransfer.js");
const { pickCallbackAgent } = await import("../src/lib/telephony/consultantCallbackTarget.js");
const { createTestAgent } = await import("./helpers/ownAgent.js");
const { deleteAgentsWithTraces } = await import("./helpers/cleanupAgents.js");
const { waitFor } = await import("./helpers/waitFor.js");
const { dushanbeDateString } = await import("../src/lib/dushanbeTime.js");

const { daysOffSchema, isDayOff, nextWorkingDayStart, startOfWorkingDayAtOrAfter, daysOffSentenceRu, normalizeDaysOff, dushanbeWeekday } =
  shared;

/** Момент по Душанбе «ГГГГ-ММ-ДДTЧЧ:ММ» → настоящий момент (UTC+5). */
const dushanbe = (local: string) => new Date(new Date(`${local}:00Z`).getTime() - 5 * 3600_000);
// 05.10.2026 — понедельник … 11.10.2026 — воскресенье.
const MON = dushanbe("2026-10-05T12:00");
const TUE_EVENING = dushanbe("2026-10-06T21:00");
const WED = dushanbe("2026-10-07T12:00");
const SUN = dushanbe("2026-10-11T12:00");

describe("правило выходных (packages/shared/src/daysOff.ts)", () => {
  it("по умолчанию выходных нет: каждый день недели, включая воскресенье, рабочий", () => {
    for (let i = 0; i < 7; i++) expect(isDayOff(new Date(MON.getTime() + i * 86_400_000))).toBe(false);
    expect(isDayOff(SUN, { companyDaysOff: [], agentDaysOff: [] })).toBe(false);
  });

  it("общий выходной в воскресенье работает как раньше", () => {
    expect(isDayOff(SUN, { companyDaysOff: [0] })).toBe(true);
    expect(isDayOff(MON, { companyDaysOff: [0] })).toBe(false);
  });

  it("личный выходной агента в среду: у него среда выходная, у компании — нет", () => {
    expect(isDayOff(WED, { companyDaysOff: [], agentDaysOff: [3] })).toBe(true);
    expect(isDayOff(WED, { companyDaysOff: [] })).toBe(false);
    expect(dushanbeWeekday(WED)).toBe(3);
  });

  it("следующий рабочий день: вторник вечером у агента с выходным в среду — четверг 09:30", () => {
    expect(nextWorkingDayStart(TUE_EVENING, { agentDaysOff: [3] }, "09:30").toISOString()).toBe(dushanbe("2026-10-08T09:30").toISOString());
    expect(nextWorkingDayStart(TUE_EVENING, {}, "09:30").toISOString()).toBe(dushanbe("2026-10-07T09:30").toISOString());
    expect(startOfWorkingDayAtOrAfter(WED, { agentDaysOff: [3] }, "09:30").toISOString()).toBe(dushanbe("2026-10-08T09:30").toISOString());
    expect(startOfWorkingDayAtOrAfter(WED, {}, "09:30").getTime()).toBe(WED.getTime());
  });

  it("схема: 0..6 без повторов, хотя бы один рабочий день", () => {
    expect(daysOffSchema.safeParse([]).success).toBe(true);
    expect(daysOffSchema.safeParse([0, 6]).success).toBe(true);
    for (const bad of [[7], [-1], [1, 1], [0, 1, 2, 3, 4, 5, 6], [1.5], ["1"]]) {
      expect(daysOffSchema.safeParse(bad).success, JSON.stringify(bad)).toBe(false);
    }
    expect(normalizeDaysOff([6, 0, 0, 9, "x"])).toEqual([0, 6]);
  });

  it("выходные словами", () => {
    expect(daysOffSentenceRu([])).toBe("выходных нет — работаем каждый день");
    expect(daysOffSentenceRu([0])).toBe("выходной — воскресенье");
    expect(daysOffSentenceRu([0, 6, 3])).toBe("выходные — среда, суббота и воскресенье");
  });
});

describe("раздача, первый звонок и закрепление (база)", () => {
  const agentIds: string[] = [];
  const clientIds: string[] = [];
  let offAgent = "";
  let workingAgent = "";
  let dutyAgent = "";
  let settingsBefore: Record<string, unknown> | null = null;
  const today = dushanbeWeekday(new Date());
  const tomorrow = (today + 1) % 7;

  beforeAll(async () => {
    offAgent = await createTestAgent(`Выходной Сегодня ${Date.now()}`);
    workingAgent = await createTestAgent(`На Смене ${Date.now()}`);
    dutyAgent = await createTestAgent(`Дежурный Оператор ${Date.now()}`);
    agentIds.push(offAgent, workingAgent, dutyAgent);
    await prisma.agent.update({ where: { id: offAgent }, data: { weeklyDaysOff: [today] } });
    await prisma.agent.update({ where: { id: workingAgent }, data: { weeklyDaysOff: [tomorrow] } });
    settingsBefore = (await prisma.settings.findUnique({
      where: { id: "singleton" },
      select: {
        workHoursStart: true,
        workHoursEnd: true,
        companyDaysOff: true,
        leadReassignOnMissedCallEnabled: true,
        liveVoiceTransferAgentId: true,
        callbackOperatorAgentId: true,
      },
    })) as Record<string, unknown> | null;
    await prisma.settings.update({
      where: { id: "singleton" },
      data: {
        workHoursStart: "00:00",
        workHoursEnd: "24:00",
        companyDaysOff: [],
        leadReassignOnMissedCallEnabled: true,
        liveVoiceTransferAgentId: dutyAgent,
        callbackOperatorAgentId: dutyAgent,
      },
    });
  });

  afterAll(async () => {
    if (settingsBefore) await prisma.settings.update({ where: { id: "singleton" }, data: settingsBefore });
    await prisma.royalScoreEvent.deleteMany({ where: { agentId: { in: agentIds } } });
    await prisma.interaction.deleteMany({ where: { clientId: { in: clientIds } } });
    await prisma.client.deleteMany({ where: { id: { in: clientIds } } });
    await deleteAgentsWithTraces(agentIds);
  });

  async function ownClient(agentId: string, acceptedAgoMin: number, reference = new Date()): Promise<string> {
    const c = await prisma.client.create({
      data: {
        fullName: `Клиент выходного ${Math.random().toString(36).slice(2, 8)}`,
        phone: `+992${Math.floor(Math.random() * 900_000_000) + 100_000_000}`,
        source: "PHONE_CALL",
        kind: "BUYER",
        assignedAgentId: agentId,
        assignedAt: new Date(reference.getTime() - acceptedAgoMin * 60_000),
        acceptedAt: new Date(reference.getTime() - acceptedAgoMin * 60_000),
      },
    });
    clientIds.push(c.id);
    return c.id;
  }

  it("новый чужой лид: агент в свой выходной из раздачи выпадает, коллега с выходным в другой день — нет", async () => {
    const pickable = await prisma.agent.findMany({
      where: { id: { in: [offAgent, workingAgent] }, ...acceptingLeadsWhere() },
      select: { id: true },
    });
    expect(pickable.map((a) => a.id)).toEqual([workingAgent]);
    expect(await isAgentAvailableForLead(offAgent)).toBe(false);
    expect(await isAgentAvailableForLead(workingAgent)).toBe(true);
    // Завтра выходной у второго — и раздача честно поменяется местами.
    const tomorrowNoon = new Date(Date.now() + 86_400_000);
    const tomorrowPick = await prisma.agent.findMany({
      where: { id: { in: [offAgent, workingAgent] }, ...acceptingLeadsWhere(tomorrowNoon) },
      select: { id: true },
    });
    expect(tomorrowPick.map((a) => a.id)).toEqual([offAgent]);
  });

  it("первый звонок: срок, выпавший на выходной агента, уходит на его следующий рабочий день + полное окно", async () => {
    const acceptedAt = dushanbe("2026-10-07T11:50");
    // This fixed Wednesday/Thursday scenario must not inherit the execution
    // day's holiday: on Thursday, [3, today] also made the expected return day off.
    await prisma.agent.update({ where: { id: offAgent }, data: { weeklyDaysOff: [3] } });
    // У «агента на смене» выходной — «завтра» (beforeAll); по вторникам это среда, ровно WED этой
    // проверки, и тест краснел раз в неделю без единой правки кода (13.10.2026). На время проверки
    // выходных у него нет вовсе.
    await prisma.agent.update({ where: { id: workingAgent }, data: { weeklyDaysOff: [] } });
    try {
      const pauses = await firstCallPauses([{ id: "x", acceptedAt, assignedAgentId: offAgent }], false, WED, 15);
      expect(firstCallDueAt(acceptedAt, 15, pauses.get("x")).toISOString()).toBe(dushanbe("2026-10-08T00:15").toISOString());
      const none = await firstCallPauses([{ id: "y", acceptedAt, assignedAgentId: workingAgent }], false, WED, 15);
      expect(firstCallDueAt(acceptedAt, 15, none.get("y")).toISOString()).toBe(dushanbe("2026-10-07T12:05").toISOString());
      // The deadline's weekday matters: crossing midnight into the holiday
      // defers it, whereas a deadline missed on the preceding working day does not.
      const crossing = dushanbe("2026-10-06T23:50");
      const crossingPause = await firstCallPauses([{ id: "crossing", acceptedAt: crossing, assignedAgentId: offAgent }], false, WED, 15);
      expect(firstCallDueAt(crossing, 15, crossingPause.get("crossing")).toISOString()).toBe(dushanbe("2026-10-08T00:15").toISOString());
      const previous = dushanbe("2026-10-06T23:40");
      const previousPause = await firstCallPauses([{ id: "previous", acceptedAt: previous, assignedAgentId: offAgent }], false, WED, 15);
      expect(firstCallDueAt(previous, 15, previousPause.get("previous")).toISOString()).toBe(dushanbe("2026-10-06T23:55").toISOString());
    } finally {
      await prisma.agent.update({ where: { id: offAgent }, data: { weeklyDaysOff: [today] } });
      await prisma.agent.update({ where: { id: workingAgent }, data: { weeklyDaysOff: [tomorrow] } });
    }
  });

  it("закрепление не меняется: в свой выходной агент не получает штрафа «не позвонил за 15 мин», лид не уходит", async () => {
    // Keep acceptance and its deadline inside today's holiday. After midnight,
    // real now-minus-30 puts the deadline on yesterday's working day instead.
    const reference = dushanbe(`${dushanbeDateString()}T12:00`);
    const own = await ownClient(offAgent, 30, reference);
    const control = await ownClient(workingAgent, 30, reference);
    await penalizeMissedFirstCalls(reference);
    const ownAfter = await prisma.client.findUniqueOrThrow({ where: { id: own }, select: { assignedAgentId: true } });
    expect(ownAfter.assignedAgentId).toBe(offAgent);
    expect(await prisma.royalScoreEvent.count({ where: { agentId: offAgent, kind: "call_15min_missed" } })).toBe(0);
    // Контроль: у агента на смене то же правило срабатывает (тест умеет краснеть).
    await waitFor(() => prisma.royalScoreEvent.count({ where: { agentId: workingAgent, kind: "call_15min_missed" } }));
    expect(await prisma.royalScoreEvent.count({ where: { agentId: workingAgent, kind: "call_15min_missed" } })).toBeGreaterThan(0);
    expect(control).toBeTruthy();
  });

  it("сторож: закреплённый клиент агента в выходной не уходит ни дежурному, ни оператору — перевод и перезвон идут его агенту", async () => {
    const own = await ownClient(offAgent, 120);
    const transfer = await pickTransferAgent({ clientId: own }, null);
    expect(transfer?.agent.id).toBe(offAgent);
    expect(transfer?.because).toBe("client");
    const callback = await pickCallbackAgent({ namedAgentId: null, assignedAgentId: offAgent });
    expect(callback).toMatchObject({ agentId: offAgent, source: "assigned", agentDaysOff: [today] });
    // И в любой другой день недели — то же самое.
    for (let d = 0; d < 7; d++) {
      await prisma.agent.update({ where: { id: offAgent }, data: { weeklyDaysOff: [d] } });
      expect((await pickTransferAgent({ clientId: own }, null))?.agent.id).toBe(offAgent);
      expect((await pickCallbackAgent({ namedAgentId: null, assignedAgentId: offAgent })).agentId).toBe(offAgent);
    }
    await prisma.agent.update({ where: { id: offAgent }, data: { weeklyDaysOff: [today] } });
    const ownAfter = await prisma.client.findUniqueOrThrow({ where: { id: own }, select: { assignedAgentId: true } });
    expect(ownAfter.assignedAgentId).toBe(offAgent);
  });
});

describe("API: выходные компании и агента", () => {
  const agentIds: string[] = [];
  let token = "";
  let targetId = "";
  let before: number[] = [];

  beforeAll(async () => {
    const director = await createTestAgent(`Директор выходных ${Date.now()}`, "DIRECTOR");
    targetId = await createTestAgent(`Агент выходных ${Date.now()}`);
    agentIds.push(director, targetId);
    token = signAccessToken({ sub: director, role: "DIRECTOR" });
    grantElevation(director);
    before = (await prisma.settings.findUnique({ where: { id: "singleton" }, select: { companyDaysOff: true } }))?.companyDaysOff ?? [];
  });

  afterAll(async () => {
    await prisma.settings.update({ where: { id: "singleton" }, data: { companyDaysOff: before } });
    await prisma.auditLog.deleteMany({ where: { entityId: { in: agentIds } } }).catch(() => {});
    await deleteAgentsWithTraces(agentIds);
  });

  it("PATCH /settings принимает companyDaysOff, GET отдаёт, мусор — 400", async () => {
    const ok = await request(app).patch("/api/v1/settings").set("Authorization", `Bearer ${token}`).send({ companyDaysOff: [0] });
    expect(ok.status).toBe(200);
    const got = await request(app).get("/api/v1/settings").set("Authorization", `Bearer ${token}`);
    expect(got.body.companyDaysOff).toEqual([0]);
    for (const bad of [[7], [1, 1], [0, 1, 2, 3, 4, 5, 6]]) {
      const res = await request(app).patch("/api/v1/settings").set("Authorization", `Bearer ${token}`).send({ companyDaysOff: bad });
      expect(res.status, JSON.stringify(bad)).toBe(400);
    }
    const cleared = await request(app).patch("/api/v1/settings").set("Authorization", `Bearer ${token}`).send({ companyDaysOff: [] });
    expect(cleared.status).toBe(200);
  });

  it("PATCH /agents/:id принимает weeklyDaysOff, отдаёт его, пишет в журнал; мусор — 400", async () => {
    const res = await request(app).patch(`/api/v1/agents/${targetId}`).set("Authorization", `Bearer ${token}`).send({ weeklyDaysOff: [3] });
    expect(res.status).toBe(200);
    expect(res.body.weeklyDaysOff).toEqual([3]);
    const list = await request(app).get("/api/v1/agents").set("Authorization", `Bearer ${token}`);
    expect(list.body.find((a: { id: string }) => a.id === targetId)?.weeklyDaysOff).toEqual([3]);
    const audit = await waitFor(() =>
      prisma.auditLog.findFirst({ where: { entityId: targetId, action: "AGENT_UPDATE" }, orderBy: { createdAt: "desc" } })
    );
    expect(JSON.stringify(audit?.meta)).toContain("weeklyDaysOff");
    const bad = await request(app).patch(`/api/v1/agents/${targetId}`).set("Authorization", `Bearer ${token}`).send({ weeklyDaysOff: [9] });
    expect(bad.status).toBe(400);
  });
});
