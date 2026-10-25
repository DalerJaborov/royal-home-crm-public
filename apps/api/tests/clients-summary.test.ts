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
    expect(res.body.lost).toBeNull();
    expect(res.body.other).toBeNull();
    expect(res.body.freeAgents).toBeNull();
    // «Мои» — согласовано со списком agentId=me (18.09.2026, задание В §f п.4,
    // §c разведки 17.09: счётчик расходился со списком, который показывает
    // ВСЁ назначенное, а не только принятое и нетерминальное) — обе карточки.
    expect(res.body.mine).toBe(2);
  });

  it("директор: счётчики по всему агентству, «Потерянные» и свободные агенты отданы", async () => {
    const token = await login(directorPhone);
    const res = await request(app).get("/api/v1/clients/summary").set("Authorization", `Bearer ${token}`);
    expect(res.status).toBe(200);
    expect(res.body.buyers).toBeGreaterThanOrEqual(1);
    expect(res.body.awaitingAgent.count).toBeGreaterThanOrEqual(1);
    expect(typeof res.body.lost).toBe("number");
    expect(Array.isArray(res.body.freeAgents)).toBe(true);
    // Список — ТРИ самых свободных агента базы (slice(0, 3) в routes/clients/summary.ts).
    // На стенде и на проде рядом лежат чужие агенты, и тестовый — держит одного
    // активного покупателя при лимите ≥ 2 — вытесняется теми, у кого запас больше.
    // Проверяем то, что маршрут обещает на самом деле: не длиннее трёх, у каждого
    // есть свободное место, и наш агент либо в списке, либо вытеснен полным списком.
    const free = res.body.freeAgents as { id: string; slotsLeft: number }[];
    expect(free.length).toBeLessThanOrEqual(3);
    expect(free.every((a) => a.slotsLeft > 0)).toBe(true);
    if (!free.some((a) => a.id === agentId)) expect(free).toHaveLength(3);
    expect(res.body.showings).toEqual({ today: expect.any(Number), tomorrow: expect.any(Number) });
  });

  it("без входа — 401", async () => {
    const res = await request(app).get("/api/v1/clients/summary");
    expect(res.status).toBe(401);
  });

  /**
   * Стадии воронки (экран «Воронка лидов», docs/agent-briefs/
   * mobile-c99db05f-step4-14-09.md) — по одной карточке на каждый статус,
   * проверяем группировку по ДВУМ статусам сразу (CONTACTED+HOT,
   * COLD+UNRESPONSIVE, DEAL_CLOSED+LOST), не только счёт как таковой.
   */
  it("stages: считает по группам статусов, а не по одному", async () => {
    const stageIds: string[] = [];
    const mk = (suffix: string, status: string) =>
      prisma.client.create({
        data: {
          fullName: `Сводка Стадия ${suffix} ${runId}`,
          phone: `+99296${suffix}${String(runId).slice(-6)}`,
          source: "INSTAGRAM",
          kind: "BUYER",
          assignedAgentId: agentId,
          acceptedAt: new Date(),
          status,
        },
      });
    try {
      const created = await Promise.all([
        mk("1", "CONTACTED"),
        mk("2", "HOT"),
        mk("3", "COLD"),
        mk("4", "UNRESPONSIVE"),
        mk("5", "DEAL_CLOSED"),
        mk("6", "LOST"),
      ]);
      stageIds.push(...created.map((c) => c.id));

      const token = await login(agentPhone);
      const res = await request(app).get("/api/v1/clients/summary").set("Authorization", `Bearer ${token}`);
      expect(res.status).toBe(200);
      // «Новые» — исходная непринятая карточка из beforeAll (status по умолчанию NEW).
      expect(res.body.stages.new).toBeGreaterThanOrEqual(1);
      expect(res.body.stages.inProgress).toBeGreaterThanOrEqual(2); // CONTACTED + HOT
      expect(res.body.stages.awaitingDecision).toBeGreaterThanOrEqual(2); // COLD + UNRESPONSIVE
      expect(res.body.stages.closed).toBeGreaterThanOrEqual(2); // DEAL_CLOSED + LOST
    } finally {
      await prisma.client.deleteMany({ where: { id: { in: stageIds } } });
    }
  });
});
