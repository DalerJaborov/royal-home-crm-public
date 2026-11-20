import { afterAll, beforeAll, describe, expect, it } from "vitest";
import request from "supertest";
import { app } from "../src/app.js";
import { prisma } from "../src/db.js";
import { signAccessToken } from "../src/auth/jwt.js";

/**
 * ОТЧЁТЫ ДИРЕКТОРА (20.11.2026, разделы директора).
 *
 * 1. Воронка заявок периода (cohort): каждый шаг — это заявки ЭТОГО периода,
 *    дошедшие до шага или дальше. Шаг не больше предыдущего, доля не выше 100 %.
 *    Прежняя воронка событий давала «Переговоры 4» при «Показах 0».
 * 2. В рейтинге по агентам только продающие роли: акционер (и прочие
 *    не-продавцы) без сделок в строки не попадает; директор, сам закрывший
 *    сделку, остаётся — иначе сумма сделок по людям не сойдётся с итогом.
 *
 * 3. В рейтинге — RATED_ROLES: РОП с агентами не соревнуется, если сам не закрыл сделку.
 *
 * Период — один давний день, на который другие тесты карточек не заводят:
 * когорта считается по дате карточки, и чужие клиенты исказили бы числа.
 */

const runId = Date.now();
const sfx = String(runId).slice(-7);
const DAY = "2011-05-17";
const at = new Date(`${DAY}T07:00:00.000Z`); // 12:00 по Душанбе
const ids = { agents: [] as string[], clients: [] as string[], deals: [] as string[], interactions: [] as string[] };
let token = "";
let districtId = "";
let propertyId = "";
let agentId = "";
let shareholderId = "";
let directorId = "";
let ropId = "";

beforeAll(async () => {
  directorId = (await prisma.agent.create({ data: { fullName: `Директор когорта ${runId}`, phone: `+992931${sfx}`, role: "DIRECTOR", passwordHash: "x" } })).id;
  agentId = (await prisma.agent.create({ data: { fullName: `Агент когорта ${runId}`, phone: `+992930${sfx}`, role: "AGENT", passwordHash: "x" } })).id;
  shareholderId = (await prisma.agent.create({ data: { fullName: `Акционер когорта ${runId}`, phone: `+992929${sfx}`, role: "SHAREHOLDER", passwordHash: "x" } })).id;
  ropId = (await prisma.agent.create({ data: { fullName: `РОП когорта ${runId}`, phone: `+992928${sfx}`, role: "HEAD_OF_SALES", passwordHash: "x" } })).id;
  ids.agents.push(directorId, agentId, shareholderId, ropId);
  token = signAccessToken({ sub: directorId, role: "DIRECTOR" });
  districtId = (await prisma.district.create({ data: { name: `Район когорта ${runId}` } })).id;
  propertyId = (
    await prisma.property.create({
      data: { title: `Объект когорта ${runId}`, type: "APARTMENT", areaSqm: 40, price: 1000, currency: "TJS", districtId, address: "Тестовая", condition: "GOOD", status: "SOLD" },
    })
  ).id;
  const client = async (n: number) => {
    const c = await prisma.client.create({ data: { fullName: `Когорта ${n} ${runId}`, phone: `+99292${n}${sfx}`, source: "PHONE_CALL", createdAt: at } });
    ids.clients.push(c.id);
    return c.id;
  };
  const silent = await client(1);
  const called = await client(2);
  const dealNoShowing = await client(3);
  const showingAndTalks = await client(4);
  // Клиент сам звонил, трубку не взяли, плюс заметка сотрудника — это НЕ «связались»
  // (общее правило lib/noContact.ts, ревью #336).
  const missedOnly = await client(5);
  void silent;
  ids.interactions.push(
    (await prisma.interaction.create({ data: { clientId: called, agentId, type: "CALL", callAttempt: "NO_ANSWER", notes: "звонок когорта", createdAt: at } })).id,
    (await prisma.interaction.create({ data: { clientId: missedOnly, agentId, type: "CALL", actorKind: "AGENT", notes: "Входящий звонок: пропущен", createdAt: at } })).id,
    (await prisma.interaction.create({ data: { clientId: missedOnly, agentId, type: "MESSAGE", notes: "заметка когорта", createdAt: at } })).id,
    (await prisma.interaction.create({ data: { clientId: showingAndTalks, agentId, propertyId, type: "SHOWING", notes: "показ когорта", createdAt: at } })).id,
  );
  ids.deals.push(
    // Сделку закрыл директор сам — в рейтинге он обязан остаться строкой.
    (await prisma.deal.create({ data: { clientId: dealNoShowing, propertyId, agentId: directorId, stage: "COMPLETED", startedAt: at, closedAt: at, commissionAmount: 100, currency: "TJS" } })).id,
    (await prisma.deal.create({ data: { clientId: showingAndTalks, propertyId, agentId, stage: "NEGOTIATION", startedAt: at } })).id,
  );
});

afterAll(async () => {
  await prisma.deal.deleteMany({ where: { id: { in: ids.deals } } });
  await prisma.interaction.deleteMany({ where: { id: { in: ids.interactions } } });
  await prisma.client.deleteMany({ where: { id: { in: ids.clients } } });
  await prisma.property.deleteMany({ where: { id: propertyId } });
  await prisma.district.deleteMany({ where: { id: districtId } });
  await prisma.agent.deleteMany({ where: { id: { in: ids.agents } } });
});

describe("воронка заявок периода", () => {
  it("шаги — заявки периода, дошедшие до шага или дальше; пропущенный входящий и заметка — не «связались»", async () => {
    const res = await request(app).get(`/api/v1/reports/funnel?from=${DAY}&to=${DAY}`).set("Authorization", `Bearer ${token}`);
    expect(res.status).toBe(200);
    const cohort = res.body.cohort as { key: string; count: number }[];
    expect(cohort.map((s) => [s.key, s.count])).toEqual([
      ["leads", 5],
      ["contacted", 3],
      ["showings", 2],
      ["negotiations", 2],
      ["deals", 1],
    ]);
    for (let i = 1; i < cohort.length; i += 1) expect(cohort[i].count).toBeLessThanOrEqual(cohort[i - 1].count);
    // прежние итоги периода на месте: экран берёт из них плитки и комиссию
    expect((res.body.funnel as { key: string }[]).map((s) => s.key)).toEqual(["leads", "contacted", "showings", "negotiations", "deals"]);
  });
});

describe("рейтинг по агентам — только те, кто продаёт", () => {
  it("акционера и РОП без сделок нет, агент есть, директор со своей сделкой периода есть", async () => {
    const res = await request(app).get(`/api/v1/reports/agents?from=${DAY}&to=${DAY}`).set("Authorization", `Bearer ${token}`);
    expect(res.status).toBe(200);
    const rows = res.body as { agentId: string; dealsClosed: number }[];
    expect(rows.some((r) => r.agentId === shareholderId)).toBe(false);
    expect(rows.some((r) => r.agentId === ropId)).toBe(false);
    expect(rows.some((r) => r.agentId === agentId)).toBe(true);
    expect(rows.find((r) => r.agentId === directorId)?.dealsClosed).toBe(1);
  });
});
