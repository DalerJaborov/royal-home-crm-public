import { afterAll, beforeAll, describe, expect, it } from "vitest";
import bcrypt from "bcrypt";
import request from "supertest";
import { app } from "../src/app.js";
import { prisma } from "../src/db.js";

/**
 * СПИСОК КЛИЕНТОВ ГОВОРИТ ПРАВДУ (владелец 21.11.2026, кадры с телефона):
 * «почему написано, что с кем-то не связывались 54 дня, если реально сегодня
 * связывались? Таких ошибок чтобы не было вообще».
 *
 *  1) «X ждёт агента N дней» гаснет, как только после назначения был контакт сотрудника
 *     (правило lib/noContact.ts), а контакт ДО назначения его не гасит;
 *  2) «последний контакт» в строке — по тому же правилу (`lastStaffContactAt`), а не по
 *     `lastContactAt`, который у новой карточки равен моменту создания и растёт от заметок;
 *  3) до приёма заявки даты нет вовсе (хронология закрыта), а не «контакта ещё не было».
 */

const runId = Date.now();
const tail = String(runId).slice(-7);
const password = "testpass123";
const marker = `listtruth${runId}`;
let agentId = "";
const agentPhone = `+992961${tail}`;
const clientIds: string[] = [];
const DAY = 24 * 60 * 60 * 1000;

async function token(): Promise<string> {
  const res = await request(app).post("/api/v1/auth/login").send({ phone: agentPhone, password });
  expect(res.status).toBe(200);
  return res.body.accessToken ?? res.body.token;
}

async function makeClient(i: number, data: Record<string, unknown>) {
  const c = await prisma.client.create({
    data: {
      fullName: `${marker} ${i}`, phone: `+992962${tail.slice(-6)}${i}`, source: "WEBSITE", kind: "BUYER",
      status: "CONTACTED", assignedAgentId: agentId, ...data,
    },
  });
  clientIds.push(c.id);
  return c;
}

async function staffCall(clientId: string, at: Date) {
  await prisma.interaction.create({
    data: { clientId, agentId, type: "CALL", callAttempt: "NO_ANSWER", notes: "Звонок агента", createdAt: at },
  });
}

beforeAll(async () => {
  const agent = await prisma.agent.create({
    data: { fullName: `Правда списка ${runId}`, phone: agentPhone, role: "AGENT", passwordHash: await bcrypt.hash(password, 10) },
  });
  agentId = agent.id;
});

afterAll(async () => {
  await prisma.interaction.deleteMany({ where: { clientId: { in: clientIds } } });
  await prisma.client.deleteMany({ where: { id: { in: clientIds } } });
  await prisma.agent.deleteMany({ where: { id: agentId } });
});

describe("«X ждёт агента N дней» гаснет после контакта сотрудника", () => {
  it("54 дня без приёма: без контакта строка есть; контакт после назначения — строки нет; контакт до — не в счёт", async () => {
    const auth = `Bearer ${await token()}`;
    const summary = () => request(app).get("/api/v1/clients/summary").set("Authorization", auth);
    const assignedAt = new Date(Date.now() - 54 * DAY);
    const old = await makeClient(1, { acceptedAt: null, assignedAt, createdAt: assignedAt });
    const younger = await makeClient(2, { acceptedAt: null, assignedAt: new Date(Date.now() - 3 * DAY), createdAt: new Date(Date.now() - 3 * DAY) });

    let res = await summary();
    expect(res.status).toBe(200);
    expect(res.body.awaitingAgent.oldest?.id).toBe(old.id);
    expect(res.body.awaitingAgent.oldest.waitingMinutes).toBeGreaterThan(53 * 24 * 60);

    // Контакт ДО назначения (прежний агент) — это не ответ на нынешнее ожидание.
    await staffCall(old.id, new Date(assignedAt.getTime() - DAY));
    res = await summary();
    expect(res.body.awaitingAgent.oldest?.id).toBe(old.id);

    // Сегодня агенту позвонили, «Принять» не нажали — «ждёт агента 54 дня» уже неправда.
    await staffCall(old.id, new Date(Date.now() - 60_000));
    res = await summary();
    expect(res.body.awaitingAgent.oldest?.id).toBe(younger.id);
    // Число «Ждут принятия» — факт о карточке, оно не меняется: заявку правда не приняли.
    expect(res.body.awaitingAgent.count).toBe(2);

    // Второго тоже взяли в работу сообщением из CRM (отметка lastAgentAttemptAt) — строки нет вовсе.
    await prisma.client.update({ where: { id: younger.id }, data: { lastAgentAttemptAt: new Date() } });
    res = await summary();
    expect(res.body.awaitingAgent.oldest).toBeNull();
  });
});

describe("«последний контакт» в строке списка — по правилу контакта, а не по lastContactAt", () => {
  it("новая карточка — null, звонок агента — его дата, заметка — не контакт, непринятая — без даты", async () => {
    const callAt = new Date(Date.now() - 2 * DAY);
    const fresh = await makeClient(3, { acceptedAt: new Date() });
    const called = await makeClient(4, { acceptedAt: new Date(), lastContactAt: new Date() });
    await staffCall(called.id, callAt);
    const noted = await makeClient(5, { acceptedAt: new Date(), lastContactAt: new Date() });
    await prisma.interaction.create({ data: { clientId: noted.id, agentId, type: "MESSAGE", notes: "Заметка агента о клиенте" } });
    const pending = await makeClient(6, { acceptedAt: null });

    const res = await request(app)
      .get(`/api/v1/clients?q=${marker}&pageSize=50`)
      .set("Authorization", `Bearer ${await token()}`);
    expect(res.status).toBe(200);
    const byId = new Map<string, Record<string, unknown>>(res.body.items.map((c: { id: string }) => [c.id, c]));

    // lastContactAt у новой карточки — момент создания; «связывались» по нему было бы неправдой.
    expect(byId.get(fresh.id)?.lastStaffContactAt).toBeNull();
    expect(byId.get(called.id)?.lastStaffContactAt).toBe(callAt.toISOString());
    expect(byId.get(noted.id)?.lastStaffContactAt).toBeNull();
    // Заявка ещё не принята: хронология закрыта, даты нет вовсе.
    expect(byId.has(pending.id)).toBe(true);
    expect(byId.get(pending.id)).not.toHaveProperty("lastStaffContactAt");
  });
});
