import { afterAll, beforeAll, describe, expect, it } from "vitest";
import bcrypt from "bcrypt";
import request from "supertest";
import { app } from "../src/app.js";
import { prisma } from "../src/db.js";
import { hoursAgoWithinDushanbeDay, minutesSince } from "./helpers/dushanbeFixtures.js";

/**
 * GET /clients/summary — сводка экрана «Клиенты» (артефакт, tpl-clients).
 *
 * Проверяем две вещи, которые ничем другим не ловятся:
 *  1) счётчики считают то, что обещают: непринятая карточка попадает в
 *     «ждут агента» и становится «самой давней», принятая — нет; новая за
 *     сегодня считается по createdAt;
 *  2) граница прав та же, что у списка: агент видит только своих, «Потерянные»,
 *     «Прочие» и свободные агенты ему не отдаются (null), а директору отдаются.
 */

const runId = Date.now();
const password = "testpass123";
const ids: string[] = [];
let agentPhone = "";
let directorPhone = "";
let agentId = "";
/** Возраст непринятой карточки — считается по тому же правилу, что и фикстура. */
let pendingWaitingMinutes = 0;

// 16.11.2026 (владелец: «удалить все папки и статусы»): список один. Старые
// INACTIVE/LOST/ARCHIVED-строки — обычные клиенты списка; прячутся только закрытая
// сделка и назначение с завершённой работой.
it("один список: старые неактивные/потерянные/архивные видны, закрытые сделка и назначение — нет", async () => {
  const token = await login(agentPhone);
  const get = (path: string) => request(app).get(path).set("Authorization", `Bearer ${token}`);
  const before = await get("/api/v1/clients/summary");
  const marker = `workscope${runId}`;
  const fixtures = [
    { status: "CONTACTED", workStatus: "ACTIVE" },
    { status: "CONTACTED", workStatus: "INACTIVE" },
    { status: "LOST", workStatus: "ACTIVE" },
    { status: "ARCHIVED", workStatus: "ACTIVE" },
    { status: "DEAL_CLOSED", workStatus: "ACTIVE" },
    { status: "CONTACTED", workStatus: "ACTIVE", assignmentCompletedAt: new Date() },
  ] as const;
  const created: string[] = [];
  try {
    for (const [i, state] of fixtures.entries()) {
      const c = await prisma.client.create({ data: {
        fullName: `${marker} ${i}`, phone: `test-${marker}-${i}`, source: "WEBSITE",
        kind: "BUYER", assignedAgentId: agentId, acceptedAt: new Date(), ...state,
      } });
      created.push(c.id);
    }
    const after = await get("/api/v1/clients/summary");
    expect(after.body.buyers).toBe(before.body.buyers + 4);
    const work = await get(`/api/v1/clients?scope=inWork&kind=BUYER&q=${marker}`);
    expect(work.status).toBe(200);
    expect(work.body.items.map((c: { id: string }) => c.id).sort()).toEqual([created[0], created[1], created[2], created[3]].sort());
    const search = await get(`/api/v1/clients?q=${marker}`);
    expect(search.status).toBe(200);
    expect(search.body.items).toHaveLength(fixtures.length);
    // Фильтра по workStatus больше нет: параметр молча отбрасывается.
    const inactive = await get(`/api/v1/clients?workStatus=INACTIVE&q=${marker}`);
    expect(inactive.body.items).toHaveLength(fixtures.length);
  } finally {
    await prisma.client.deleteMany({ where: { id: { in: created } } });
  }
});

async function login(phone: string): Promise<string> {
  const res = await request(app).post("/api/v1/auth/login").send({ phone, password });
  expect(res.status).toBe(200);
  return res.body.accessToken ?? res.body.token;
}

beforeAll(async () => {
  const passwordHash = await bcrypt.hash(password, 10);
  agentPhone = `+992957${String(runId).slice(-7)}`;
  directorPhone = `+992958${String(runId).slice(-7)}`;
  const agent = await prisma.agent.create({
    data: { fullName: `Сводка Агент ${runId}`, phone: agentPhone, role: "AGENT", passwordHash },
  });
  agentId = agent.id;
  await prisma.agent.create({
    data: { fullName: `Сводка Директор ${runId}`, phone: directorPhone, role: "DIRECTOR", passwordHash },
  });
  // Не «просто два часа назад»: полночь по Душанбе наступает в 19:00 UTC, и в
  // прогоне после неё «два часа назад» — это ВЧЕРА, а `newToday` тогда считает
  // одну карточку вместо двух. Помощник ужимает отступ у самой границы суток и
  // днём отдаёт ровно те же два часа.
  const twoHoursAgo = hoursAgoWithinDushanbeDay(2);
  pendingWaitingMinutes = minutesSince(twoHoursAgo);
  const pending = await prisma.client.create({
    data: {
      fullName: `Сводка Ждёт ${runId}`,
      phone: `+992959${String(runId).slice(-7)}`,
      source: "INSTAGRAM",
      kind: "BUYER",
      assignedAgentId: agent.id,
      acceptedAt: null,
      createdAt: twoHoursAgo,
      // Ожидание считается с выдачи лида агенту (24.09.2026, пункт 25).
      assignedAt: twoHoursAgo,
    },
  });
  const accepted = await prisma.client.create({
    data: {
      fullName: `Сводка Принят ${runId}`,
      phone: `+992960${String(runId).slice(-7)}`,
      source: "WHATSAPP",
      kind: "SELLER",
      assignedAgentId: agent.id,
      acceptedAt: new Date(),
    },
  });
  ids.push(pending.id, accepted.id);
});

afterAll(async () => {
  await prisma.client.deleteMany({ where: { id: { in: ids } } });
  await prisma.agent.deleteMany({ where: { phone: { in: [agentPhone, directorPhone] } } });
});

it("карточки с заявкой на удаление: счётчик «в работе» равен длине списка (сторож пустых списков)", async () => {
  const token = await login(agentPhone);
  const get = (path: string) => request(app).get(path).set("Authorization", `Bearer ${token}`);
  const marker = `pendel${runId}`;
  const before = await get("/api/v1/clients/summary");
  const created = await prisma.client.create({ data: {
    fullName: `${marker} 0`, phone: `test-${marker}-0`, source: "WEBSITE",
    kind: "BUYER", status: "CONTACTED", assignedAgentId: agentId, acceptedAt: new Date(),
  } });
  try {
    const afterCreate = await get("/api/v1/clients/summary");
    expect(afterCreate.body.buyers).toBe(before.body.buyers + 1);
    await prisma.clientDeleteRequest.create({ data: {
      clientId: created.id, requestedById: agentId, reason: "OTHER", comment: "test", status: "PENDING",
    } });
    const after = await get("/api/v1/clients/summary");
    const list = await get(`/api/v1/clients?scope=inWork&kind=BUYER&pageSize=200`);
    expect(list.status).toBe(200);
    // Список прячет карточку, и сводка обязана вести себя так же.
    expect(list.body.items.map((c: { id: string }) => c.id)).not.toContain(created.id);
    expect(after.body.buyers).toBe(before.body.buyers);
    expect(after.body.buyers).toBe(list.body.total);
  } finally {
    await prisma.clientDeleteRequest.deleteMany({ where: { clientId: created.id } });
    await prisma.client.delete({ where: { id: created.id } });
  }
});

describe("GET /clients/summary", () => {
  it("приватный показ не добавляется к обычной сводке агента", async () => {
    const token = await login(agentPhone);
    const before = await request(app).get("/api/v1/clients/summary").set("Authorization", `Bearer ${token}`);
    const row = await prisma.interaction.create({ data: {
      clientId: ids[0], agentId, type: "SHOWING", notes: "Private showing fixture", nextActionDate: new Date(), investigationOnly: true,
    } });
    try {
      const after = await request(app).get("/api/v1/clients/summary").set("Authorization", `Bearer ${token}`);
      expect(after.status).toBe(200);
      expect(after.body.showings).toEqual(before.body.showings);
    } finally {
      await prisma.interaction.delete({ where: { id: row.id } });
    }
  });
  it("агент: свои покупатели и продавцы, непринятая карточка ждёт агента, чужие срезы закрыты", async () => {
    const token = await login(agentPhone);
    const res = await request(app).get("/api/v1/clients/summary").set("Authorization", `Bearer ${token}`);
    expect(res.status).toBe(200);
    expect(res.body.buyers).toBe(1);
    expect(res.body.sellers).toBe(1);
    // Обе карточки созданы сегодня по Душанбе: `twoHoursAgo` в beforeAll зажат
    // началом суток, поэтому после полуночи ожидание не плавает.
    expect(res.body.newToday).toBe(2);
    expect(res.body.awaitingAgent.count).toBe(1);
    expect(res.body.awaitingAgent.oldest.fullName).toBe(`Сводка Ждёт ${runId}`);
    // Ожидание считаем из ТОЙ ЖЕ точки, что и фикстура: у самой границы суток по
    // Душанбе она короче двух часов, и жёсткие «119 минут» там были бы неправдой.
    expect(res.body.awaitingAgent.oldest.waitingMinutes).toBeGreaterThanOrEqual(pendingWaitingMinutes - 1);
    // Поле `pool` (Client.assignedAgentId === null) убрано вместе с пулом «ничьих»
    // (17.09.2026, закон о владении клиентом П-4/Р-3) — «Забрать из пула» больше
    // нет ни кнопки, ни смысла эту сводку показывать.
    expect(res.body.awaitingAgent.oldest.pool).toBeUndefined();
    expect(res.body.other).toBeNull();
    // «Потерянных», «Неактивных», «Отложенных», воронки и «свободных агентов» нет с 16.11.2026.
    for (const gone of ["lost", "inactive", "deferred", "stages", "freeAgents"]) expect(res.body).not.toHaveProperty(gone);
    // «Мои» — согласовано со списком agentId=me (18.09.2026, задание В §f п.4,
    // §c разведки 17.09: счётчик расходился со списком, который показывает
    // ВСЁ назначенное, а не только принятое и нетерминальное) — обе карточки.
    expect(res.body.mine).toBe(2);
  });

  it("директор: счётчики по всему агентству", async () => {
    const token = await login(directorPhone);
    const res = await request(app).get("/api/v1/clients/summary").set("Authorization", `Bearer ${token}`);
    expect(res.status).toBe(200);
    expect(res.body.buyers).toBeGreaterThanOrEqual(1);
    expect(res.body.awaitingAgent.count).toBeGreaterThanOrEqual(1);
    expect(res.body.showings).toEqual({ today: expect.any(Number), tomorrow: expect.any(Number) });
  });

  it("без входа — 401", async () => {
    const res = await request(app).get("/api/v1/clients/summary");
    expect(res.status).toBe(401);
  });
});
