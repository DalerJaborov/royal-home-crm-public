import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import request from "supertest";
import { DIRECTOR_DRILL_KEYS } from "@royal-home/shared";
import { app } from "../src/app.js";
import { prisma } from "../src/db.js";
import { signAccessToken } from "../src/auth/jwt.js";
import { buildDirectorDrill, clearDirectorDashboardCache, resolveDirectorPeriod } from "../src/lib/directorDashboard.js";
import { createLimiter } from "../src/lib/queryGate.js";
import { DEFAULT_COMMISSION_PLAN, isDefaultCommissionPlan } from "../src/lib/dashboardInsights.js";
import { readXlsxFirstSheet } from "../src/lib/xlsxRead.js";
import { waitFor } from "./helpers/waitFor.js";

/**
 * ДАШБОРД ДИРЕКТОРА (ТЗ владельца, 21.11.2026).
 *
 * Период — давний день 14.03.2012 (по Душанбе), прошлый — 13.03.2012: когорта и
 * события считаются по датам записей, на эти дни другие тесты ничего не заводят.
 * Главный критерий приёмки ТЗ №1: список под плиткой — ровно те записи, из
 * которых сложилась цифра (сумма записей = значение плитки).
 */

const runId = Date.now();
const sfx = String(runId).slice(-7);
const DAY = "2012-03-14";
const at = new Date(`${DAY}T07:00:00.000Z`); // 12:00 по Душанбе
const prevAt = new Date("2012-03-13T07:00:00.000Z");
const ids = { agents: [] as string[], clients: [] as string[], deals: [] as string[], interactions: [] as string[] };
let districtId = "";
let propertyId = "";
let agentA = "";
let agentB = "";
let directorId = "";
let director = "";
let security = "";
let agentToken = "";
let marketing = "";
let historyClientId = "";

const q = (extra = "") => `preset=custom&from=${DAY}&to=${DAY}${extra}`;
const auth = (token: string) => ({ Authorization: `Bearer ${token}` });
type Kpi = { key: string; value: number | null; prev: number | null; drillKey: string | null; goodWhen: string };
const kpi = (body: { kpis: Kpi[] }, key: string) => body.kpis.find((k) => k.key === key)!;

beforeAll(async () => {
  const agent = async (role: string, n: string) => {
    const a = await prisma.agent.create({ data: { fullName: `${role} дашборд ${n} ${runId}`, phone: `+99293${n}${sfx}`, role: role as never, passwordHash: "x" } });
    ids.agents.push(a.id);
    return a.id;
  };
  directorId = await agent("DIRECTOR", "1");
  agentA = await agent("AGENT", "2");
  agentB = await agent("AGENT", "3");
  const securityId = await agent("SECURITY", "4");
  director = signAccessToken({ sub: directorId, role: "DIRECTOR" });
  security = signAccessToken({ sub: securityId, role: "SECURITY" });
  agentToken = signAccessToken({ sub: agentA, role: "AGENT" });
  marketing = signAccessToken({ sub: await agent("MARKETING", "5"), role: "MARKETING" });

  districtId = (await prisma.district.create({ data: { name: `Район дашборд ${runId}` } })).id;
  propertyId = (
    await prisma.property.create({
      data: { title: `Объект дашборд ${runId}`, type: "APARTMENT", areaSqm: 40, price: 1000, currency: "TJS", districtId, address: "Тестовая", condition: "GOOD", status: "SOLD" },
    })
  ).id;

  const client = async (n: number, data: Record<string, unknown>) => {
    const c = await prisma.client.create({ data: { fullName: `Дашборд ${n} ${runId}`, phone: `+99291${n}${sfx}`, ...data } as never });
    ids.clients.push(c.id);
    return c.id;
  };
  // День периода: пять заявок (c6 — в 00:30 по Душанбе, то есть 14-го, хотя по UTC ещё 13-е).
  const c1 = await client(1, { source: "INSTAGRAM", assignedAgentId: agentA, createdAt: at, firstContactAt: new Date(at.getTime() + 10 * 60_000) });
  await client(2, { source: "INSTAGRAM", assignedAgentId: agentA, createdAt: at });
  const c3 = await client(3, { source: "WEBSITE", assignedAgentId: agentB, createdAt: at, firstContactAt: new Date(at.getTime() + 30 * 60_000) });
  await client(4, {
    source: "WEBSITE",
    assignedAgentId: agentB,
    createdAt: at,
    assignmentRefusedAt: at,
    assignmentRefusedByAgentId: agentB,
    refusalReason: "EXPENSIVE",
  });
  await client(6, { source: "PHONE_CALL", assignedAgentId: agentA, createdAt: new Date("2012-03-13T19:30:00.000Z") });
  // 15-е по Душанбе (00:30) — в период не входит, хотя по UTC это ещё 14-е.
  await client(7, { source: "PHONE_CALL", assignedAgentId: agentA, createdAt: new Date("2012-03-14T19:30:00.000Z") });
  // Прошлый период: одна заявка.
  await client(5, { source: "INSTAGRAM", assignedAgentId: agentA, createdAt: prevAt });
  historyClientId = await client(8, { source: "INSTAGRAM", createdAt: new Date("2012-01-05T07:00:00.000Z") });

  ids.interactions.push(
    (await prisma.interaction.create({ data: { clientId: c1, agentId: agentA, type: "CALL", callAttempt: "TALKED", notes: "звонок дашборд", createdAt: at } })).id,
    (await prisma.interaction.create({ data: { clientId: c1, agentId: agentA, type: "MEETING", notes: "встреча дашборд", createdAt: at } })).id,
    (await prisma.interaction.create({ data: { clientId: c3, agentId: agentB, propertyId, type: "SHOWING", notes: "показ дашборд", createdAt: at } })).id,
    // Просроченная задача агента A (на сейчас, не за период).
    (
      await prisma.interaction.create({
        data: { clientId: c1, agentId: agentA, type: "CALL", callAttempt: "TALKED", notes: "задача дашборд", nextAction: "Перезвонить", nextActionDate: new Date(Date.now() - 86_400_000), createdAt: at },
      })
    ).id,
  );
  ids.deals.push(
    (await prisma.deal.create({ data: { clientId: c3, propertyId, agentId: agentB, stage: "COMPLETED", startedAt: at, closedAt: at, commissionAmount: 1000, currency: "TJS" } })).id,
  );
});

afterAll(async () => {
  await prisma.deal.deleteMany({ where: { id: { in: ids.deals } } });
  await prisma.interaction.deleteMany({ where: { clientId: { in: ids.clients } } });
  await prisma.stageEvent.deleteMany({ where: { entityId: { in: ids.clients } } });
  await prisma.client.deleteMany({ where: { id: { in: ids.clients } } });
  await prisma.property.deleteMany({ where: { id: propertyId } });
  await prisma.district.deleteMany({ where: { id: districtId } });
  await prisma.agent.deleteMany({ where: { id: { in: ids.agents } } });
});

beforeEach(() => clearDirectorDashboardCache());

describe("период по Душанбе", () => {
  // 21.11.2026 20:30 UTC = 22.11.2026 01:30 по Душанбе, воскресенье.
  const now = new Date("2026-11-21T20:30:00.000Z");
  it.each([
    ["day", "2026-11-21T19:00:00.000Z"],
    ["week", "2026-11-15T19:00:00.000Z"],
    ["month", "2026-10-31T19:00:00.000Z"],
    ["quarter", "2026-09-30T19:00:00.000Z"],
    ["year", "2025-12-31T19:00:00.000Z"],
  ] as const)("%s начинается с полуночи по Душанбе", (preset, from) => {
    const p = resolveDirectorPeriod({ preset }, now);
    expect(p.from.toISOString()).toBe(from);
    expect(p.to.toISOString()).toBe("2026-11-22T18:59:59.999Z");
  });
  it("прошлый период — той же длины сразу перед", () => {
    const p = resolveDirectorPeriod({ preset: "day" }, now);
    expect(p.prev.from.toISOString()).toBe("2026-11-20T19:00:00.000Z");
    expect(p.prev.to.toISOString()).toBe("2026-11-21T18:59:59.999Z");
    const w = resolveDirectorPeriod({ preset: "week" }, now);
    expect(w.to.getTime() - w.from.getTime()).toBe(w.prev.to.getTime() - w.prev.from.getTime());
    expect(w.prev.to.getTime()).toBe(w.from.getTime() - 1);
  });
  it("свой период: с > по — 400", async () => {
    const res = await request(app).get("/api/v1/reports/director?preset=custom&from=2012-03-15&to=2012-03-14").set(auth(director));
    expect(res.status).toBe(400);
  });
});

describe("сводка", () => {
  it("цифры периода и прошлого периода, границы суток по Душанбе", async () => {
    const res = await request(app).get(`/api/v1/reports/director?${q()}`).set(auth(director));
    expect(res.status).toBe(200);
    expect(res.body.period.from).toBe("2012-03-13T19:00:00.000Z");
    expect(res.body.prevPeriod.from).toBe("2012-03-12T19:00:00.000Z");
    expect(kpi(res.body, "newLeads")).toMatchObject({ value: 5, prev: 1, goodWhen: "up" });
    expect(kpi(res.body, "contacted").value).toBe(2);
    expect(kpi(res.body, "noContact")).toMatchObject({ value: 3, goodWhen: "down" });
    expect(kpi(res.body, "showings").value).toBe(1);
    expect(kpi(res.body, "meetings").value).toBe(1);
    expect(kpi(res.body, "negotiations").value).toBe(1);
    expect(kpi(res.body, "deals").value).toBe(1);
    expect(kpi(res.body, "revenue")).toMatchObject({ value: 1000, prev: 0, drillKey: "deals" });
    expect(res.body.funnel.steps.map((s: { count: number }) => s.count)).toEqual([5, 2, 1, 1, 1]);
    expect(res.body.funnel.steps[1].conversionFromPrev).toBe(40);
    expect(res.body.lossReasons).toEqual([{ reason: "EXPENSIVE", label: expect.any(String), count: 1 }]);
    expect(res.body.speed).toMatchObject({ medianMin: 20, avgMin: 20, answered: 2, noContactCount: 3 });
    const a = res.body.agents.find((r: { id: string }) => r.id === agentA);
    expect(a).toMatchObject({ leads: 3, contacted: 1, calls: 2, meetings: 1, deals: 0, overdueTasks: 1 });
    const b = res.body.agents.find((r: { id: string }) => r.id === agentB);
    expect(b).toMatchObject({ leads: 2, showings: 1, deals: 1, commission: 1000, conversion: 50 });
    const web = res.body.sources.find((s: { source: string }) => s.source === "WEBSITE");
    expect(web).toMatchObject({ leads: 2, deals: 1, commission: 1000 });
    expect(res.body.plan.month).toBe("2012-03");
    expect(res.body.plan.fact).toBe(1000);
  });

  it("фильтры источника и сотрудника пересчитывают цифры", async () => {
    const insta = await request(app).get(`/api/v1/reports/director?${q("&source=INSTAGRAM")}`).set(auth(director));
    expect(kpi(insta.body, "newLeads")).toMatchObject({ value: 2, prev: 1 });
    expect(kpi(insta.body, "deals").value).toBe(0);
    const byB = await request(app).get(`/api/v1/reports/director?${q(`&agentId=${agentB}`)}`).set(auth(director));
    expect(kpi(byB.body, "newLeads").value).toBe(2);
    expect(kpi(byB.body, "deals").value).toBe(1);
    expect(byB.body.agents.map((r: { id: string }) => r.id)).toEqual([agentB]);
  });

  it("без finance.view деньги — null, а не 0", async () => {
    const res = await request(app).get(`/api/v1/reports/director?${q()}`).set(auth(security));
    expect(res.status).toBe(200);
    expect(res.body.seesMoney).toBe(false);
    expect(kpi(res.body, "revenue")).toMatchObject({ value: null, prev: null });
    for (const row of res.body.agents) expect(row.commission).toBeNull();
    for (const row of res.body.sources) expect(row.commission).toBeNull();
    expect(res.body.plan).toMatchObject({ commissionPlan: null, fact: null, pct: null, left: null });
    // счётные цифры при этом те же
    expect(kpi(res.body, "deals").value).toBe(1);
  });

  it("агент без reports.view — 403 на сводку, список и выгрузку", async () => {
    for (const path of ["", "/drill?key=newLeads", "/export.xlsx", `/history?clientId=${historyClientId}`]) {
      const res = await request(app).get(`/api/v1/reports/director${path}`).set(auth(agentToken));
      expect(res.status).toBe(403);
    }
  });
});

describe("список под плиткой = цифра плитки (приёмка ТЗ №1)", () => {
  it.each([["", ""], ["&source=WEBSITE", "source"], [`&agentId=AGENT_A`, "agent"]])("фильтр %s", async (extra) => {
    const filter = extra.replace("AGENT_A", agentA);
    const summary = await request(app).get(`/api/v1/reports/director?${q(filter)}`).set(auth(director));
    expect(summary.status).toBe(200);
    for (const k of summary.body.kpis as Kpi[]) {
      if (k.unit === "tjs" || !k.drillKey) continue;
      const res = await request(app).get(`/api/v1/reports/director/drill?key=${k.drillKey}&limit=100&${q(filter)}`).set(auth(director));
      expect(res.status, k.key).toBe(200);
      expect(res.body.total, k.key).toBe(k.value);
      expect(res.body.items.length, k.key).toBe(k.value);
    }
    const lost = await request(app).get(`/api/v1/reports/director/drill?key=lost&limit=100&${q(filter)}`).set(auth(director));
    expect(lost.body.total).toBe(summary.body.lossReasons.reduce((s: number, l: { count: number }) => s + l.count, 0));
  });

  it("просроченные задачи сотрудника — те же, что в цифре", async () => {
    const summary = await request(app).get(`/api/v1/reports/director?${q(`&agentId=${agentA}`)}`).set(auth(director));
    const res = await request(app).get(`/api/v1/reports/director/drill?key=overdueTasks&limit=100&${q(`&agentId=${agentA}`)}`).set(auth(director));
    expect(summary.body.speed.overdueTasks).toBe(1);
    expect(res.body.total).toBe(1);
    expect(res.body.items[0]).toMatchObject({ entity: "interaction", agentId: agentA });
  });

  it("сделки в списке: сумма — только с finance.view, пагинация честная", async () => {
    const withMoney = await request(app).get(`/api/v1/reports/director/drill?key=deals&${q()}`).set(auth(director));
    expect(withMoney.body.items[0]).toMatchObject({ entity: "deal", amount: 1000, agentId: agentB });
    const noMoney = await request(app).get(`/api/v1/reports/director/drill?key=deals&${q()}`).set(auth(security));
    expect(noMoney.body.items[0].amount).toBeNull();
    const page = await request(app).get(`/api/v1/reports/director/drill?key=newLeads&limit=2&offset=2&${q()}`).set(auth(director));
    expect(page.body).toMatchObject({ total: 5, limit: 2, offset: 2, hasMore: true });
    expect(page.body.items).toHaveLength(2);
    const tooBig = await request(app).get(`/api/v1/reports/director/drill?key=newLeads&limit=500&${q()}`).set(auth(director));
    expect(tooBig.status).toBe(400);
  });

  it("все ключи списка отвечают", async () => {
    for (const key of DIRECTOR_DRILL_KEYS) {
      const res = await request(app).get(`/api/v1/reports/director/drill?key=${key}&limit=1&${q()}`).set(auth(director));
      expect(res.status, key).toBe(200);
    }
  });
});

describe("выгрузка в Excel", () => {
  it("настоящий .xlsx с цифрами, фильтром и без денег без finance.view", async () => {
    const res = await request(app)
      .get(`/api/v1/reports/director/export.xlsx?${q("&source=WEBSITE")}`)
      .set(auth(director))
      .buffer(true)
      .parse((r, cb) => {
        const chunks: Buffer[] = [];
        r.on("data", (c: Buffer) => chunks.push(c));
        r.on("end", () => cb(null, Buffer.concat(chunks)));
      });
    expect(res.status).toBe(200);
    expect(res.headers["content-type"]).toContain("spreadsheetml");
    const rows = readXlsxFirstSheet(res.body as Buffer);
    expect(rows[0]).toEqual(["Показатель", "За период", "Прошлый период", "Изменение"]);
    expect(rows.find((r) => r[0] === "Новые заявки")?.[1]).toBe("2");
    expect(rows.find((r) => r[0] === "Выручка (комиссия), сомони")?.[1]).toBe("1000");
    expect(rows.find((r) => r[0] === "Источник")?.[1]).toBe("Сайт");

    const noMoney = await request(app)
      .get(`/api/v1/reports/director/export.xlsx?${q()}`)
      .set(auth(security))
      .buffer(true)
      .parse((r, cb) => {
        const chunks: Buffer[] = [];
        r.on("data", (c: Buffer) => chunks.push(c));
        r.on("end", () => cb(null, Buffer.concat(chunks)));
      });
    const plain = readXlsxFirstSheet(noMoney.body as Buffer);
    expect(plain.find((r) => r[0] === "Выручка (комиссия), сомони")?.[1]).toBe("нет доступа");
    expect(plain.find((r) => r[0] === "Новые заявки")?.[1]).toBe("5");
  });
});

describe("история ключевых полей (ТЗ п.15)", () => {
  it("смена источника и статуса пишется: кто, когда, было → стало", async () => {
    const patch = await request(app).patch(`/api/v1/clients/${historyClientId}`).set(auth(director)).send({ source: "WEBSITE" });
    expect(patch.status).toBe(200);
    await prisma.client.update({ where: { id: historyClientId }, data: { status: "ARCHIVED" } });
    const sourceEvent = await waitFor(() => prisma.stageEvent.findFirst({ where: { entityId: historyClientId, field: "source" } }));
    expect(sourceEvent).toMatchObject({ from: "INSTAGRAM", to: "WEBSITE", agentId: directorId });
    await waitFor(() => prisma.stageEvent.findFirst({ where: { entityId: historyClientId, field: "status" } }));
    const res = await request(app).get(`/api/v1/reports/director/history?clientId=${historyClientId}`).set(auth(director));
    expect(res.status).toBe(200);
    const fields = (res.body.items as { field: string; from: string; to: string; byName: string }[]).map((i) => [i.field, i.from, i.to]);
    expect(fields).toContainEqual(["source", "INSTAGRAM", "WEBSITE"]);
    expect(fields).toContainEqual(["status", "NEW", "ARCHIVED"]);
    expect(res.body.items.find((i: { field: string }) => i.field === "source").byName).toContain("DIRECTOR дашборд");
  });

  it("создание карточки не пишет «источник: пусто → X»", async () => {
    const events = await prisma.stageEvent.count({ where: { entityId: { in: ids.clients.filter((id) => id !== historyClientId) }, field: "source" } });
    expect(events).toBe(0);
  });
});

describe("права на список и историю (ревью #362, блокер 1)", () => {
  it("маркетолог: сводка (числа) открыта, а список с именами клиентов и история карточки — 403", async () => {
    const summary = await request(app).get(`/api/v1/reports/director?${q()}`).set(auth(marketing));
    expect(summary.status).toBe(200);
    for (const key of DIRECTOR_DRILL_KEYS) {
      const res = await request(app).get(`/api/v1/reports/director/drill?key=${key}&${q()}`).set(auth(marketing));
      expect(res.status, key).toBe(403);
      expect(JSON.stringify(res.body)).not.toContain("Дашборд 1");
    }
    const history = await request(app).get(`/api/v1/reports/director/history?clientId=${historyClientId}`).set(auth(marketing));
    expect(history.status).toBe(403);
  });

  it("директор тот же список получает", async () => {
    const res = await request(app).get(`/api/v1/reports/director/drill?key=newLeads&${q()}`).set(auth(director));
    expect(res.status).toBe(200);
    expect(res.body.items.length).toBeGreaterThan(0);
  });
});

describe("свободный текст задачи в списке (ревью #362, блокер 2)", () => {
  it("номер в «Задача: …» скрыт тому, у кого нет права на номера, и виден тому, у кого есть", async () => {
    const clientId = ids.clients[0];
    const created = await prisma.interaction.create({
      data: { clientId, agentId: agentA, type: "CALL", callAttempt: "TALKED", notes: "маска дашборд", nextAction: "Перезвонить на +992 90 123 45 67", nextActionDate: new Date(Date.now() - 3_600_000), createdAt: at },
    });
    ids.interactions.push(created.id);
    const base = { preset: "custom" as const, from: DAY, to: DAY, key: "overdueTasks" as const, limit: 50, offset: 0 };
    const viewer = { investigationRole: undefined, seesMoney: false, seesOrigin: true, seesArchive: true };
    const present = (c: { fullName: string; source: string }) => ({ name: c.fullName, source: c.source, sourceLabel: c.source });
    const hidden = await buildDirectorDrill(base, { ...viewer, seesPhone: false }, present);
    const shown = await buildDirectorDrill(base, { ...viewer, seesPhone: true }, present);
    const textOf = (r: { items: { id: string; statusLabel: string }[] }) => r.items.find((i) => i.id === created.id)?.statusLabel ?? "";
    expect(textOf(hidden)).toContain("Задача:");
    expect(textOf(hidden)).not.toContain("123 45 67");
    expect(textOf(hidden)).not.toContain("1234567");
    expect(textOf(shown)).toContain("123 45 67");
  });
});

describe("нагрузка и план (ревью #362)", () => {
  it("ограничитель пускает не больше заданного числа запросов разом", async () => {
    const gate = createLimiter(2);
    let active = 0;
    let peak = 0;
    await Promise.all(
      Array.from({ length: 8 }, () =>
        gate(async () => {
          active += 1;
          peak = Math.max(peak, active);
          await new Promise((r) => setTimeout(r, 5));
          active -= 1;
        })
      )
    );
    expect(peak).toBe(2);
  });

  it("«без контакта» = новые − обработанные и совпадает с длиной списка", async () => {
    const res = await request(app).get(`/api/v1/reports/director?${q()}`).set(auth(director));
    const by = (k: string) => res.body.kpis.find((x: { key: string }) => x.key === k).value as number;
    expect(by("noContact")).toBe(by("newLeads") - by("contacted"));
    const list = await request(app).get(`/api/v1/reports/director/drill?key=noContact&${q()}`).set(auth(director));
    expect(list.body.total).toBe(by("noContact"));
  });

  it("план: умолчание из Настроек — «не задан», а не «процент от 8000»", async () => {
    expect(isDefaultCommissionPlan(DEFAULT_COMMISSION_PLAN)).toBe(true);
    expect(isDefaultCommissionPlan(60_000)).toBe(false);
    const res = await request(app).get(`/api/v1/reports/director?${q()}`).set(auth(director));
    expect(res.body.plan.planIsDefault).toBe(res.body.plan.commissionPlan === null);
    if (res.body.plan.planIsDefault) expect(res.body.plan.pct).toBeNull();
  });

  it("подписи: плитка и шаг воронки про переговоры называются по-разному", async () => {
    const res = await request(app).get(`/api/v1/reports/director?${q()}`).set(auth(director));
    const tile = res.body.kpis.find((k: { key: string }) => k.key === "negotiations").label;
    const step = res.body.funnel.steps.find((s: { key: string }) => s.key === "negotiations").label;
    expect(tile).not.toBe(step);
  });
});

describe("Корзина в списке сделок (повторное ревью)", () => {
  it("без archive.view список прячет сделки удалённого клиента и говорит, сколько их", async () => {
    const trashed = await prisma.client.create({
      data: { fullName: `Корзина дашборд ${runId}`, phone: `+99291999${sfx}`, source: "WEBSITE", assignedAgentId: agentB, createdAt: at, deletedAt: new Date() },
    });
    ids.clients.push(trashed.id);
    ids.deals.push((await prisma.deal.create({ data: { clientId: trashed.id, propertyId, agentId: agentB, stage: "COMPLETED", startedAt: at, closedAt: at, commissionAmount: 500, currency: "TJS" } })).id);
    const base = { preset: "custom" as const, from: DAY, to: DAY, key: "deals" as const, limit: 50, offset: 0 };
    const viewer = { investigationRole: undefined, seesMoney: true, seesOrigin: true, seesPhone: true };
    const present = (c: { fullName: string; source: string }) => ({ name: c.fullName, source: c.source, sourceLabel: c.source });
    const without = await buildDirectorDrill(base, { ...viewer, seesArchive: false }, present);
    const withArchive = await buildDirectorDrill(base, { ...viewer, seesArchive: true }, present);
    expect(without.hiddenInTrash).toBe(1);
    expect(withArchive.hiddenInTrash).toBe(0);
    expect(withArchive.total).toBe(without.total + 1);
    expect(without.items.some((i) => i.clientName.startsWith("Корзина дашборд"))).toBe(false);
  });
});
