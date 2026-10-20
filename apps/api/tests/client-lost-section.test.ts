import { afterAll, beforeAll, describe, expect, it } from "vitest";
import bcrypt from "bcrypt";
import request from "supertest";
import { app } from "../src/app.js";
import { prisma } from "../src/db.js";

/**
 * Раздел «Потерянные клиенты» (решение владельца 11.08.2026, свой раздел рядом
 * с «Горячими») и то, что его наполняет:
 *  - комментарий при закрытии карточки НЕОБЯЗАТЕЛЕН (упрощено 18.08.2026);
 *    Settings.refusalCommentMinLength оставлено в схеме, но не проверяется;
 *  - продавец идёт тем же путём, что и покупатель: предел передач, статус LOST,
 *    штраф Royal Score — раньше эта ветка не делала ничего из перечисленного;
 *  - refusalCount сбрасывается на закрытой сделке, иначе карточка навсегда
 *    остаётся «отказной» и делит комиссию 70/30 даже без вины агента.
 */

const runId = Date.now();
const password = "testpass123";

let directorId: string;
let directorToken: string;
let agentId: string;
let agentToken: string;
let districtId: string;
let propertyId: string;
const clientIds: string[] = [];
let savedMinLength: number | null = null;
let savedMaxTransfers: number | null = null;

async function refuse(clientId: string, body: Record<string, unknown>, token = agentToken) {
  return request(app)
    .post(`/api/v1/clients/${clientId}/refuse`)
    .set("Authorization", `Bearer ${token}`)
    .send(body);
}

/** «Завершить сделку» доступна покупателю только после показа (ТЗ п. 16, 12.08.2026). */
async function makeShowing(clientId: string) {
  return prisma.interaction.create({
    data: { clientId, agentId, type: "SHOWING", notes: "Показ объекта", completedAt: new Date() },
  });
}

async function makeClient(data: Record<string, unknown> = {}) {
  const c = await prisma.client.create({
    data: {
      fullName: `Клиент раздела ${clientIds.length} ${runId}`,
      phone: `+99290${clientIds.length}${runId}`,
      source: "PHONE_CALL",
      assignedAgentId: agentId,
      acceptedAt: new Date(),
      budgetMax: 300_000,
      ...data,
    },
  });
  clientIds.push(c.id);
  return c;
}

beforeAll(async () => {
  const passwordHash = await bcrypt.hash(password, 10);
  directorId = (
    await prisma.agent.create({
      data: { fullName: "Директор раздела", phone: `+992909${runId}`, role: "DIRECTOR", passwordHash },
    })
  ).id;
  agentId = (
    await prisma.agent.create({
      data: { fullName: "Агент раздела", phone: `+992908${runId}`, role: "AGENT", passwordHash },
    })
  ).id;

  const dirLogin = await request(app).post("/api/v1/auth/login").send({ phone: `+992909${runId}`, password });
  directorToken = dirLogin.body.accessToken;
  const agentLogin = await request(app).post("/api/v1/auth/login").send({ phone: `+992908${runId}`, password });
  agentToken = agentLogin.body.accessToken;

  districtId = (await prisma.district.create({ data: { name: `Тест-раздел-${runId}` } })).id;
  propertyId = (
    await prisma.property.create({
      data: {
        title: `Объект раздела ${runId}`,
        type: "APARTMENT",
        areaSqm: 50,
        price: 300_000,
        currency: "TJS",
        districtId,
        address: "Тестовая, 1",
        condition: "GOOD",
        status: "AVAILABLE",
      },
    })
  ).id;

  const settings = await prisma.settings.upsert({ where: { id: "singleton" }, update: {}, create: { id: "singleton" } });
  savedMinLength = settings.refusalCommentMinLength;
  savedMaxTransfers = settings.leadMaxTransfers;
  await prisma.settings.update({
    where: { id: "singleton" },
    data: { refusalCommentMinLength: 10, leadMaxTransfers: 2, autoRouteRefusedLeads: true },
  });
});

afterAll(async () => {
  if (savedMinLength !== null) {
    await prisma.settings.update({ where: { id: "singleton" }, data: { refusalCommentMinLength: savedMinLength } });
  }
  if (savedMaxTransfers !== null) {
    await prisma.settings.update({ where: { id: "singleton" }, data: { leadMaxTransfers: savedMaxTransfers } });
  }
  await prisma.settings.update({ where: { id: "singleton" }, data: { autoRouteRefusedLeads: false } });
  await prisma.deal.deleteMany({ where: { propertyId } });
  await prisma.royalScoreEvent.deleteMany({ where: { agentId: { in: [agentId, directorId] } } });
  await prisma.interaction.deleteMany({ where: { clientId: { in: clientIds } } });
  await prisma.client.deleteMany({ where: { id: { in: clientIds } } });
  await prisma.property.deleteMany({ where: { id: propertyId } });
  await prisma.agent.deleteMany({ where: { id: { in: [directorId, agentId] } } });
  await prisma.district.deleteMany({ where: { id: districtId } });
  await prisma.$disconnect();
});

describe("Комментарий необязателен (упрощение 18.08.2026)", () => {
  it("без комментария вовсе — отказ всё равно оформляется", async () => {
    const c = await makeClient();
    await makeShowing(c.id);
    const res = await refuse(c.id, { reason: "EXPENSIVE", initiator: "AGENT" });
    expect(res.status).toBe(200);
  });
});

describe("Раздел «Потерянные клиенты»", () => {
  it("клиент после исчерпания переносов виден со всей цепочкой причин", async () => {
    const c = await makeClient();
    await makeShowing(c.id);
    // EXPENSIVE больше не годится для этого сценария (04.09.2026): с задачи G
    // такая причина уходит в «Отложенные» (тот же агент, без передачи) —
    // цепочка передач тут проверяется на обычном отказе, CHANGED_MIND её не трогает.
    await refuse(c.id, { reason: "CHANGED_MIND", initiator: "AGENT", comment: "первый отказ, клиент передумал" });
    const afterFirst = await prisma.client.findUnique({ where: { id: c.id } });
    expect(afterFirst?.status).not.toBe("LOST");

    // Второй отказ — от того агента, кому клиента передали (лимит в тесте = 2).
    const secondAgentToken = await (async () => {
      const secondAgentId = afterFirst!.assignedAgentId;
      // Очередь пуста (на CI других агентов нет) — по решению владельца 03.09 (1б)
      // клиент снят с агента и ждёт руководителя; цепочку продолжаем нашим агентом.
      const secondAgent = secondAgentId ? await prisma.agent.findUnique({ where: { id: secondAgentId } }) : null;
      if (secondAgent?.id === directorId) return directorToken;
      // Пароль сидовых/директорских агентов нам неизвестен — переназначаем прямо
      // в базе на нашего тестового агента, чтобы завершить цепочку тем же токеном.
      await prisma.client.update({ where: { id: c.id }, data: { assignedAgentId: agentId, acceptedAt: new Date() } });
      return agentToken;
    })();

    const res = await refuse(
      c.id,
      { reason: "NO_TRUST", initiator: "AGENT", comment: "второй агент тоже не справился" },
      secondAgentToken
    );
    expect(res.status).toBe(200);
    expect(res.body.transferred).toBe(false);

    const after = await prisma.client.findUnique({ where: { id: c.id } });
    expect(after?.status).toBe("LOST");

    const list = await request(app).get("/api/v1/clients/lost").set("Authorization", `Bearer ${directorToken}`);
    expect(list.status).toBe(200);
    const row = (list.body.items as Array<{ id: string; refusalCount: number; chain: unknown[] }>).find(
      (i) => i.id === c.id
    );
    expect(row).toBeDefined();
    expect(row!.refusalCount).toBe(2);
    // Оба отказа видны — не только последний.
    expect(row!.chain.length).toBeGreaterThanOrEqual(2);
    expect(JSON.stringify(row!.chain)).toContain("клиент передумал");
    expect(JSON.stringify(row!.chain)).toContain("тоже не справился");
  });

  it("агент без права clients.assign раздел не видит", async () => {
    const res = await request(app).get("/api/v1/clients/lost").set("Authorization", `Bearer ${agentToken}`);
    expect(res.status).toBe(403);
  });

  it("маршрут /lost не перехватывается GET /:id", async () => {
    // Регресс-щит на порядок регистрации роутов: /lost зарегистрирован раньше
    // /:id намеренно, иначе Express считает «lost» идентификатором клиента.
    const res = await request(app).get("/api/v1/clients/lost").set("Authorization", `Bearer ${directorToken}`);
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.items)).toBe(true);
  });
});

describe("refusalCount сбрасывается на закрытой сделке", () => {
  it("после закрытия сделки клиент — снова обычный, а не вечно «отказной»", async () => {
    const c = await makeClient({ status: "HOT" });
    await prisma.client.update({ where: { id: c.id }, data: { refusalCount: 2 } });

    // Завершить сделку нельзя без проведённого показа этого объекта этому клиенту.
    await prisma.interaction.create({
      data: {
        clientId: c.id,
        propertyId,
        agentId,
        type: "SHOWING",
        notes: "Показ перед закрытием",
        completedAt: new Date(),
      },
    });

    const deal = await prisma.deal.create({
      data: {
        clientId: c.id,
        propertyId,
        agentId,
        stage: "NEGOTIATION",
        commissionAmount: 6000,
      },
    });

    const submitted = await request(app)
      .patch(`/api/v1/deals/${deal.id}`)
      .set("Authorization", `Bearer ${directorToken}`)
      .send({
        stage: "PENDING_APPROVAL",
        // Комиссия не может превышать цену продажи (PR #504, 18.09.2026) —
        // soldPrice поднят, чтобы 3000+3000 умещалось в цену, а не только в старую заглушку 1000.
        soldPrice: 100_000,
        commissionRealtorAmount: 3000,
        commissionCompanyAmount: 3000,
      });
    expect(submitted.status).toBe(200);

    const res = await request(app)
      .patch(`/api/v1/deals/${deal.id}`)
      .set("Authorization", `Bearer ${directorToken}`)
      .send({ stage: "COMPLETED" });
    expect(res.status).toBe(200);

    const after = await prisma.client.findUnique({ where: { id: c.id } });
    expect(after?.refusalCount).toBe(0);

    /**
     * Флаг «отказной лид» у НОВЫХ закрытий всегда false: правило 70/30 отменено
     * владельцем 09.09.2026. Отказ случался на стороне покупателя, а долю терял
     * интейкер — агент, принявший объект, который к тому отказу отношения не имел;
     * плюс счётчик отказов пожизненный, и один давний отказ стоил интейкеру доли
     * на каждой будущей сделке. Уже закрытые сделки при этом не переписываются —
     * их снапшоты остаются как были.
     */
    const closedDeal = await prisma.deal.findUnique({ where: { id: deal.id } });
    expect(closedDeal?.refusedLeadSplit).toBe(false);
  });
});
