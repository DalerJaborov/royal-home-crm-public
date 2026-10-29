import { afterAll, beforeAll, describe, expect, it } from "vitest";
import request from "supertest";
import { app } from "../src/app.js";
import { prisma } from "../src/db.js";
import { signAccessToken } from "../src/auth/jwt.js";
import { invalidateMissionControlCache } from "../src/lib/missionControlCache.js";
import { invalidatePultModuleCache } from "../src/lib/pultModules.js";
import { loadControlGaps } from "../src/lib/missionControlGaps.js";

/**
 * БЛОКИ ПУЛЬТА, КОТОРЫЕ ПОКАЗЫВАЛИ «НЕТ ДАННЫХ» (владелец 12.09.2026: «почему
 * некоторые разделы без данных? всё должно работать»).
 *
 * После переноса артефакта под добрую половину карточек пульта сервер не считал
 * ничего — они рисовались корпусом и честной заглушкой. Здесь проверяется ровно
 * то, ради чего блоки заводились:
 *  - поле в снимке ЕСТЬ (иначе фронт снова покажет «нет данных»);
 *  - когда данные есть, приходит число и список;
 *  - когда данных нет, приходит ПРИЧИНА пустоты, а не пустая строка: карточка
 *    обязана объяснять «за 30 дней публикаций не было», а не повторять вопрос
 *    владельца словами «нет данных»;
 *  - деньги (комиссия за 12 месяцев) закрыты правом finance.view.
 */

const runId = Date.now();
let adminToken = "";
let managerToken = "";
let adminId = "";
let managerId = "";
let agentId = "";
const clientIds: string[] = [];
const propertyIds: string[] = [];
let districtId = "";

async function zones(token: string) {
  invalidateMissionControlCache();
  return request(app).get("/api/v1/dashboard/mission-control/zones").set("Authorization", `Bearer ${token}`);
}

beforeAll(async () => {
  const admin = await prisma.agent.create({
    data: { fullName: `Админ Gaps ${runId}`, phone: `+99274${String(runId).slice(-7)}`, role: "ADMIN", passwordHash: "x" },
  });
  const manager = await prisma.agent.create({
    data: { fullName: `Менеджер Gaps ${runId}`, phone: `+99275${String(runId).slice(-7)}`, role: "MANAGER", passwordHash: "x" },
  });
  const agent = await prisma.agent.create({
    data: { fullName: `Агент Gaps ${runId}`, phone: `+99276${String(runId).slice(-7)}`, role: "AGENT", passwordHash: "x" },
  });
  adminId = admin.id;
  managerId = manager.id;
  agentId = agent.id;
  adminToken = signAccessToken({ sub: admin.id, role: "ADMIN" });
  managerToken = signAccessToken({ sub: manager.id, role: "MANAGER" });

  // Модули пульта включены — иначе секции просто отсутствуют в ответе.
  await prisma.pultModule.deleteMany({});
  invalidatePultModuleCache();

  const district = await prisma.district.findFirst({ select: { id: true } });
  districtId = district?.id ?? (await prisma.district.create({ data: { name: `Район Gaps ${runId}` } })).id;

  // Объект в продаже, которого нет ни в одном канале, — «Ждут публикации».
  const property = await prisma.property.create({
    data: {
      title: `Квартира Gaps ${runId}`,
      districtId,
      price: 100000,
      currency: "TJS",
      type: "APARTMENT",
      rooms: 2,
      areaSqm: 60,
      address: "Душанбе, тестовая 1",
      condition: "GOOD",
      status: "AVAILABLE",
      publishedChannels: [],
      intakeAgentId: agentId,
      createdById: agentId,
    } as never,
  });
  propertyIds.push(property.id);

  // Клиент с заявкой на удаление — «Заявки на удаление».
  const client = await prisma.client.create({
    data: {
      fullName: `Клиент Gaps ${runId}`,
      phone: `+99278${String(runId).slice(-7)}`,
      source: "WEBSITE",
      kind: "BUYER",
      assignedAgentId: agentId,
    },
  });
  clientIds.push(client.id);
  await prisma.clientDeleteRequest.create({
    data: { clientId: client.id, requestedById: agentId, reason: `Дубль ${runId}` },
  });
});

afterAll(async () => {
  await prisma.clientDeleteRequest.deleteMany({ where: { clientId: { in: clientIds } } });
  await prisma.interaction.deleteMany({ where: { clientId: { in: clientIds } } });
  await prisma.client.deleteMany({ where: { id: { in: clientIds } } });
  await prisma.property.deleteMany({ where: { id: { in: propertyIds } } });
  await prisma.agent.deleteMany({ where: { id: { in: [adminId, managerId, agentId] } } });
  invalidateMissionControlCache();
});

describe("Пульт: блоки, которые раньше всегда показывали «нет данных»", () => {
  it("контроль не считает задачи удалённого клиента и завершённого назначения", async () => {
    const now = new Date();
    const before = await loadControlGaps(now, "ADMIN");
    const client = await prisma.client.create({ data: {
      fullName: `Task scope ${runId}`, phone: `test-task-${runId}`, source: "WEBSITE", kind: "BUYER", assignedAgentId: agentId,
    } });
    clientIds.push(client.id);
    await prisma.interaction.create({ data: {
      clientId: client.id, agentId, type: "CALL", notes: "Test contact", nextAction: "Test followup",
      nextActionDate: new Date(now.getTime() - 86400000),
    } });
    expect((await loadControlGaps(now, "ADMIN")).overdueTasks.count).toBe(before.overdueTasks.count + 1);
    await prisma.client.update({ where: { id: client.id }, data: { assignmentCompletedAt: now } });
    expect((await loadControlGaps(now, "ADMIN")).overdueTasks.count).toBe(before.overdueTasks.count);
    await prisma.client.update({ where: { id: client.id }, data: { assignmentCompletedAt: null, deletedAt: now } });
    expect((await loadControlGaps(now, "ADMIN")).overdueTasks.count).toBe(before.overdueTasks.count);
  });

  it("«Ждут публикации», «Каналы» и «Пульс · 30 дней» приходят в секции маркетинга", async () => {
    const res = await zones(adminToken);
    expect(res.status).toBe(200);
    const m = res.body.marketing;
    expect(m.error).toBeUndefined();

    // Объект без каналов в базе есть — значит очередь публикаций не пуста и
    // причины пустоты быть не должно.
    expect(m.publishQueue.count).toBeGreaterThan(0);
    expect(m.publishQueue.reason).toBeNull();
    expect(m.publishQueue.items.length).toBeGreaterThan(0);
    expect(m.publishQueue.items[0]).toHaveProperty("waitingDays");

    // Каналы: список фиксированный, состояние читается из настроек.
    expect(m.channels.items.map((c: { id: string }) => c.id)).toEqual([
      "INSTAGRAM",
      "FACEBOOK",
      "TELEGRAM",
      "YOUTUBE",
      "TIKTOK",
      "THREADS",
    ]);
    expect(typeof m.channels.connectedCount).toBe("number");

    // Пульс — ровно 30 точек, по одной на день, в порядке возрастания даты.
    expect(m.pulse30.days).toHaveLength(30);
    const dates = m.pulse30.days.map((d: { date: string }) => d.date);
    expect([...dates].sort()).toEqual(dates);
  });

  it("пустой блок объясняет ПРИЧИНУ, а не молчит", async () => {
    const res = await zones(adminToken);
    const blocks: { reason: string | null }[] = [
      res.body.marketing.channels,
      res.body.marketing.pulse30,
      res.body.bot.attention.silent,
      res.body.bot.attention.waitingHuman,
      res.body.team.day,
      res.body.team.showingsToday,
      res.body.clientsZone.deleteRequests,
      res.body.clientsZone.returned,
      res.body.properties.extra.idle,
      res.body.properties.extra.districts,
      res.body.system.control.overdueTasks,
      res.body.system.control.atLimit,
      res.body.system.control.silentAfterShowing,
    ];
    for (const b of blocks) {
      // Либо данные есть (reason === null), либо есть внятная строка-объяснение.
      expect(b).toBeDefined();
      if (b.reason !== null) {
        expect(typeof b.reason).toBe("string");
        expect(b.reason!.length).toBeGreaterThan(10);
        expect(b.reason).not.toContain("нет данных");
      }
    }
  });

  it("«Бот замолчал» и «Клиент ждёт агента» — два разных среза одной выборки", async () => {
    const res = await zones(adminToken);
    const att = res.body.bot.attention;
    expect(typeof att.liveCount).toBe("number");
    expect(Array.isArray(att.silent.items)).toBe(true);
    expect(Array.isArray(att.waitingHuman.items)).toBe(true);
    // Списки не пересекаются: диалог либо ждёт бота, либо передан человеку.
    const ids = new Set(att.silent.items.map((d: { id: string }) => d.id));
    for (const d of att.waitingHuman.items) expect(ids.has(d.id)).toBe(false);
  });

  it("«Заявки на удаление» приходят числом и списком", async () => {
    const res = await zones(adminToken);
    const del = res.body.clientsZone.deleteRequests;
    expect(del.total).toBeGreaterThan(0);
    expect(del.clients).toBeGreaterThan(0);
    expect(del.reason).toBeNull();
    expect(del.items.some((i: { reason: string }) => i.reason.includes(String(runId)))).toBe(true);
  });

  it("«Карточка клиента» — один клиент и причина, почему именно он", async () => {
    const res = await zones(adminToken);
    const a = res.body.clientsZone.attentionClient;
    expect(a).toBeDefined();
    if (a.id) {
      expect(typeof a.why).toBe("string");
      expect(a.why.length).toBeGreaterThan(5);
    } else {
      expect(typeof a.reason).toBe("string");
    }
  });

  it("«День команды» считается на всю команду одной выборкой, без запроса на агента", async () => {
    const res = await zones(adminToken);
    const day = res.body.team.day;
    expect(Array.isArray(day.rows)).toBe(true);
    // Итоги — сумма по строкам, а не отдельный запрос: значит расходиться не могут.
    const sum = (f: (r: Record<string, number>) => number) => day.rows.reduce((s: number, r: Record<string, number>) => s + f(r), 0);
    expect(day.calls).toBe(sum((r) => r.calls));
    expect(day.showings).toBe(sum((r) => r.showings));
  });

  it("«Комиссия · 12 месяцев» — двенадцать точек админу и НИЧЕГО менеджеру без finance.view", async () => {
    const asAdmin = await zones(adminToken);
    expect(asAdmin.body.commission12.error).toBeUndefined();
    expect(asAdmin.body.commission12.months).toHaveLength(12);
    const labels = asAdmin.body.commission12.months.map((m: { month: string }) => m.month);
    expect([...labels].sort()).toEqual(labels);

    const asManager = await zones(managerToken);
    expect(asManager.body.seesMoney).toBe(false);
    // Ключа нет вовсе — не null и не нули: правило «никогда не показывать
    // нулевые данные в слоте цифры».
    expect(asManager.body.commission12).toBeUndefined();
  });
});
