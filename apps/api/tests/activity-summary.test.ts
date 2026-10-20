import { afterAll, beforeAll, describe, expect, it } from "vitest";
import request from "supertest";
import { app } from "../src/app.js";
import { prisma } from "../src/db.js";
import { signAccessToken } from "../src/auth/jwt.js";

/**
 * Сводка «Активности» за период (GET /api/v1/interactions/summary).
 *
 * ЗАЧЕМ МАРШРУТ. Плитки экрана считались по ЗАГРУЖЕННОЙ странице ленты — число
 * менялось от того, докрутил ли человек список. Цифра выглядела фактом за
 * период, не будучи им (решение владельца 09.09.2026, docs/theme-2026-missing.md §8).
 *
 * ЧТО ЗДЕСЬ ПРОВЕРЯЕТСЯ, кроме арифметики:
 *  — ПРАВА. Право, урезающее выдачу, легко потерять в агрегате: список чужих
 *    строк заметен глазом, чужое число в плитке — нет. Поэтому сужение до своих
 *    событий проверяется отдельно, включая попытку обойти его через ?agentId.
 *  — ГРАНИЦЫ СУТОК. Душанбе — UTC+5, контейнер живёт в UTC. События первых пяти
 *    часов суток по Душанбе лежат в базе «вчерашним» UTC-днём: наивная граница
 *    их теряет, а последний день периода обрезает целиком.
 *  — СОГЛАСИЕ СО СПИСКОМ. Сводка и лента обязаны считать по одному и тому же
 *    периоду; расхождение ничего не ломает и ничем не сигналит — просто врёт.
 *
 * ТЕЛЕФОНЫ ПО СЧЁТЧИКУ, А НЕ СЛУЧАЙНЫЕ. На общей локальной базе разработчика
 * случайные значения уже давали ложные падения по уникальности телефона.
 */

const runId = Date.now();
let seq = 0;
/** Уникальный телефон: префикс прогона + порядковый номер. Столкновений нет по построению. */
function nextPhone(): string {
  seq += 1;
  return `+992${String(runId).slice(-9)}${String(seq).padStart(2, "0")}`.slice(0, 16);
}

let adminId = "";
let agentAId = "";
let agentBId = "";
let clientAId = "";
let clientBId = "";
let adminToken = "";
let agentAToken = "";

/**
 * Период теста — фиксированные сутки в прошлом, а не «сегодня»: база
 * разработчика общая, и в «сегодня» лежат чужие события. Все запросы ниже
 * ограничены этими датами, поэтому чужие записи в числа не попадают.
 */
const DAY = "2026-03-10";
const NEXT_DAY = "2026-03-11";
/** 23:30 по Душанбе 10 марта = 18:30 UTC того же дня. */
const LATE_ON_DAY = new Date("2026-03-10T18:30:00.000Z");
/** 00:30 по Душанбе 11 марта = 19:30 UTC ДЕСЯТОГО. Наивная граница теряет это событие. */
const EARLY_NEXT_DAY = new Date("2026-03-10T19:30:00.000Z");

async function makeInteraction(agentId: string, clientId: string, type: string, createdAt: Date) {
  await prisma.interaction.create({
    data: {
      agentId,
      clientId,
      type: type as never,
      notes: `Тест сводки ${runId}`,
      createdAt,
    },
  });
}

beforeAll(async () => {
  const admin = await prisma.agent.create({
    data: { fullName: `Админ сводки ${runId}`, phone: nextPhone(), role: "ADMIN", passwordHash: "x" },
  });
  adminId = admin.id;
  const agentA = await prisma.agent.create({
    data: { fullName: `Агент А сводки ${runId}`, phone: nextPhone(), role: "AGENT", passwordHash: "x" },
  });
  agentAId = agentA.id;
  const agentB = await prisma.agent.create({
    data: { fullName: `Агент Б сводки ${runId}`, phone: nextPhone(), role: "AGENT", passwordHash: "x" },
  });
  agentBId = agentB.id;

  const clientA = await prisma.client.create({
    data: { fullName: `Клиент А ${runId}`, phone: nextPhone(), source: "PHONE_CALL", assignedAgentId: agentAId },
  });
  clientAId = clientA.id;
  const clientB = await prisma.client.create({
    data: { fullName: `Клиент Б ${runId}`, phone: nextPhone(), source: "PHONE_CALL", assignedAgentId: agentBId },
  });
  clientBId = clientB.id;

  adminToken = signAccessToken({ sub: adminId, role: "ADMIN" });
  agentAToken = signAccessToken({ sub: agentAId, role: "AGENT" });

  // Агент А: 2 звонка + 1 сообщение + 1 показ, все внутри 10 марта по Душанбе.
  await makeInteraction(agentAId, clientAId, "CALL", LATE_ON_DAY);
  await makeInteraction(agentAId, clientAId, "CALL", new Date("2026-03-10T09:00:00.000Z"));
  await makeInteraction(agentAId, clientAId, "MESSAGE", new Date("2026-03-10T09:10:00.000Z"));
  await makeInteraction(agentAId, clientAId, "SHOWING", new Date("2026-03-10T09:20:00.000Z"));
  // Агент Б: 1 встреча в тот же день — в сводку агента А попасть не должна.
  await makeInteraction(agentBId, clientBId, "MEETING", new Date("2026-03-10T10:00:00.000Z"));
  // Уже следующие сутки по Душанбе, хотя UTC-дата та же самая.
  await makeInteraction(agentAId, clientAId, "CALL", EARLY_NEXT_DAY);
});

afterAll(async () => {
  await prisma.interaction.deleteMany({ where: { notes: `Тест сводки ${runId}` } });
  await prisma.client.deleteMany({ where: { id: { in: [clientAId, clientBId] } } });
  await prisma.agent.deleteMany({ where: { id: { in: [adminId, agentAId, agentBId] } } });
});

function summary(token: string, query: string) {
  return request(app).get(`/api/v1/interactions/summary${query}`).set("Authorization", `Bearer ${token}`);
}

describe("Сводка активности за период", () => {
  it("пустой период — нули по всем типам, а не отсутствующие ключи", async () => {
    const res = await summary(adminToken, "?from=2019-01-01&to=2019-01-02");
    expect(res.status).toBe(200);
    expect(res.body.total).toBe(0);
    expect(res.body.byType).toMatchObject({
      CALL: 0,
      MESSAGE: 0,
      MEETING: 0,
      SHOWING: 0,
      STATUS_CHANGE: 0,
      SYSTEM: 0,
    });
  });

  it("обычный период: руководитель видит команду целиком, разбивка по типам сходится с total", async () => {
    const res = await summary(adminToken, `?from=${DAY}&to=${DAY}&agentId=${agentAId}`);
    expect(res.status).toBe(200);
    // Агент А за 10 марта по Душанбе: 2 звонка, 1 сообщение, 1 показ.
    // Звонок 00:30 одиннадцатого сюда НЕ входит.
    expect(res.body.byType.CALL).toBe(2);
    expect(res.body.byType.MESSAGE).toBe(1);
    expect(res.body.byType.SHOWING).toBe(1);
    expect(res.body.byType.MEETING).toBe(0);
    expect(res.body.total).toBe(4);
    const sum = Object.values(res.body.byType as Record<string, number>).reduce((a, b) => a + b, 0);
    expect(sum).toBe(res.body.total);
  });

  it("руководитель без фильтра по агенту видит и чужую встречу", async () => {
    const res = await summary(adminToken, `?from=${DAY}&to=${DAY}`);
    expect(res.status).toBe(200);
    expect(res.body.byType.MEETING).toBeGreaterThanOrEqual(1);
  });

  it("граница суток: событие в 00:30 по Душанбе принадлежит СЛЕДУЮЩЕМУ дню, а не UTC-дню записи", async () => {
    // 19:30 UTC десятого марта. Наивная граница (полночь UTC) отдала бы его
    // десятому числу и потеряла бы для одиннадцатого.
    const dayTen = await summary(adminToken, `?from=${DAY}&to=${DAY}&agentId=${agentAId}`);
    const dayEleven = await summary(adminToken, `?from=${NEXT_DAY}&to=${NEXT_DAY}&agentId=${agentAId}`);
    expect(dayTen.body.byType.CALL).toBe(2);
    expect(dayEleven.body.byType.CALL).toBe(1);
  });

  it("граница суток: последний день периода не обрезается — вечер 23:30 по Душанбе входит в `to`", async () => {
    const res = await summary(adminToken, `?to=${DAY}&from=${DAY}&agentId=${agentAId}`);
    // Событие LATE_ON_DAY (23:30 по Душанбе) уже посчитано выше в двух звонках;
    // проверяем отдельно, что оно не выпало вместе с концом суток.
    const late = await prisma.interaction.count({
      where: { agentId: agentAId, createdAt: LATE_ON_DAY },
    });
    expect(late).toBe(1);
    expect(res.body.total).toBe(4);
  });

  it("сводка совпадает с total ленты за тот же период", async () => {
    const s = await summary(adminToken, `?from=${DAY}&to=${DAY}&agentId=${agentAId}`);
    const feed = await request(app)
      .get(`/api/v1/interactions?from=${DAY}&to=${DAY}&agentId=${agentAId}`)
      .set("Authorization", `Bearer ${adminToken}`);
    expect(feed.status).toBe(200);
    expect(s.body.total).toBe(feed.body.total);
  });

  describe("права", () => {
    it("агент видит в сводке только свои события", async () => {
      const res = await summary(agentAToken, `?from=${DAY}&to=${DAY}`);
      expect(res.status).toBe(200);
      // Встреча агента Б в тот же день существует, но агенту А не принадлежит.
      expect(res.body.byType.MEETING).toBe(0);
      expect(res.body.total).toBe(4);
    });

    it("?agentId=<чужой> не открывает агенту чужие числа", async () => {
      const res = await summary(agentAToken, `?from=${DAY}&to=${DAY}&agentId=${agentBId}`);
      expect(res.status).toBe(200);
      // Не встреча агента Б (1) и не ноль «чужого фильтра» — ровно свои четыре.
      expect(res.body.byType.MEETING).toBe(0);
      expect(res.body.total).toBe(4);
    });

    it("без токена — 401", async () => {
      expect((await request(app).get("/api/v1/interactions/summary")).status).toBe(401);
    });
  });

  it("неразбираемая дата — понятный отказ, а не молча потерянный фильтр", async () => {
    expect((await summary(adminToken, "?from=вчера")).status).toBe(400);
  });

  it("agentId не из формата идентификатора отвергается", async () => {
    expect((await summary(adminToken, "?agentId=' OR 1=1--")).status).toBe(400);
  });

  it("возвращает границы, по которым посчитано, а не то, что попросили", async () => {
    const res = await summary(adminToken, `?from=${DAY}&to=${DAY}`);
    // Начало суток 10 марта по Душанбе = 19:00 UTC девятого.
    expect(res.body.from).toBe("2026-03-09T19:00:00.000Z");
    // Конец суток 10 марта по Душанбе = 18:59:59.999 UTC десятого.
    expect(res.body.to).toBe("2026-03-10T18:59:59.999Z");
  });
});
