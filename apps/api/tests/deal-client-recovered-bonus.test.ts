import { afterAll, beforeAll, describe, expect, it } from "vitest";
import bcrypt from "bcrypt";
import request from "supertest";
import { app } from "../src/app.js";
import { prisma } from "../src/db.js";
import { Prisma } from "../src/generated/prisma/client.js";
import { CLIENT_RECOVERED_BONUS_POINTS, DEAL_CLOSED_POINTS } from "../src/lib/scoreJournal.js";
import { grantElevation } from "../src/lib/stepUp.js";

/**
 * Royal Score: бонус «подобрал брошенного» (client_recovered_bonus, 01.09.2026).
 *
 * Клиент, ранее слитый ОДНИМ агентом (был LOST, lastAgentId — прежний хозяин),
 * закрывается сделкой через ДРУГОГО агента — этому другому агенту, сверх обычного
 * deal_closed, начисляется отдельный бонус. См. routes/deals.ts (закрытие сделки)
 * и lib/scoreJournal.ts (DEFAULT_EVENT_POINTS.client_recovered_bonus = +3).
 */

const runId = Date.now();
const password = "testpass123";

let districtId: string;
let directorId: string;
let losingAgentId: string; // прежний хозяин, слил клиента
let recoveringAgentId: string; // довёл до сделки после
let token: string;
const clientIds: string[] = [];
const propertyIds: string[] = [];
const dealIds: string[] = [];

async function makeProperty() {
  const p = await prisma.property.create({
    data: {
      title: `Объект возврата ${runId}-${propertyIds.length}`,
      type: "APARTMENT",
      areaSqm: 50,
      price: 100000,
      currency: "TJS",
      districtId,
      address: "Тестовая, 2",
      condition: "GOOD",
    },
  });
  propertyIds.push(p.id);
  return p;
}

/** Клиент, который когда-то был LOST у losingAgentId — lostAt проставлен, как
 *  и сделал бы promoteToLost/CLIENT_REFUSE, и lastAgentId указывает на прежнего
 *  агента (см. lib/clientWorkStatus.ts, services/leads/intake.ts). Статус к
 *  моменту закрытия сделки уже НЕ LOST — так же, как после реального возврата
 *  клиента (intake.ts: `if (existing.status === "LOST") enrich.status = "NEW"`). */
async function makeRecoveredClient(agentId: string) {
  const c = await prisma.client.create({
    data: {
      fullName: `Возвращённый клиент ${runId}-${clientIds.length}`,
      phone: `+99295${clientIds.length}${runId}`,
      source: "PHONE_CALL",
      assignedAgentId: agentId,
      acceptedAt: new Date(),
      status: "NEW",
      lostAt: new Date(Date.now() - 30 * 24 * 60 * 60 * 1000),
      lastAgentId: losingAgentId,
    },
  });
  clientIds.push(c.id);
  return c;
}

/** Обычный клиент, никогда не терявшийся — контрольная группа. */
async function makeOrdinaryClient(agentId: string) {
  const c = await prisma.client.create({
    data: {
      fullName: `Обычный клиент ${runId}-${clientIds.length}`,
      phone: `+99296${clientIds.length}${runId}`,
      source: "PHONE_CALL",
      assignedAgentId: agentId,
      acceptedAt: new Date(),
      status: "NEW",
    },
  });
  clientIds.push(c.id);
  return c;
}

async function closeDeal(client: { id: string }, agentId: string, sums: { realtor: number; company: number }) {
  const property = await makeProperty();
  await prisma.interaction.create({
    data: {
      clientId: client.id,
      agentId,
      propertyId: property.id,
      type: "SHOWING",
      notes: "Показ",
      completedAt: new Date(),
    },
  });
  const created = await request(app)
    .post("/api/v1/deals")
    .set("Authorization", `Bearer ${token}`)
    .send({ clientId: client.id, propertyId: property.id, agentId });
  expect(created.status).toBe(201);
  dealIds.push(created.body.id);

  const submitted = await request(app)
    .patch(`/api/v1/deals/${created.body.id}`)
    .set("Authorization", `Bearer ${token}`)
    .send({
      stage: "PENDING_APPROVAL",
      soldPrice: Number(property.price),
      commissionRealtorAmount: sums.realtor,
      commissionCompanyAmount: sums.company,
    });
  expect(submitted.status).toBe(200);

  const closed = await request(app)
    .patch(`/api/v1/deals/${created.body.id}`)
    .set("Authorization", `Bearer ${token}`)
    .send({ stage: "COMPLETED" });
  expect(closed.status).toBe(200);

  return created.body.id as string;
}

beforeAll(async () => {
  const passwordHash = await bcrypt.hash(password, 10);
  districtId = (await prisma.district.create({ data: { name: `Тест-район-возврат-${runId}` } })).id;
  const director = await prisma.agent.create({
    data: { fullName: "Директор возврата", phone: `+992941${runId}`, role: "DIRECTOR", passwordHash },
  });
  directorId = director.id;
  losingAgentId = (
    await prisma.agent.create({
      data: { fullName: "Слил клиента", phone: `+992942${runId}`, role: "AGENT", passwordHash },
    })
  ).id;
  recoveringAgentId = (
    await prisma.agent.create({
      data: { fullName: "Довёл до сделки", phone: `+992943${runId}`, role: "AGENT", passwordHash },
    })
  ).id;

  const res = await request(app).post("/api/v1/auth/login").send({ phone: director.phone, password });
  expect(res.status).toBe(200);
  grantElevation(director.id);
  token = res.body.accessToken as string;
});

afterAll(async () => {
  await prisma.royalScoreEvent.deleteMany({ where: { agentId: { in: [losingAgentId, recoveringAgentId] } } });
  await prisma.deal.deleteMany({ where: { id: { in: dealIds } } });
  await prisma.interaction.deleteMany({ where: { clientId: { in: clientIds } } });
  await prisma.client.deleteMany({ where: { id: { in: clientIds } } });
  await prisma.property.deleteMany({ where: { id: { in: propertyIds } } });
  await prisma.agent.deleteMany({ where: { id: { in: [directorId, losingAgentId, recoveringAgentId] } } });
  await prisma.district.deleteMany({ where: { id: districtId } });
  await prisma.$disconnect();
});

describe("client_recovered_bonus — сделка с ранее LOST-клиентом другого агента", () => {
  it("начисляется тому, кто закрыл сделку с ранее LOST-клиентом ДРУГОГО агента", async () => {
    const client = await makeRecoveredClient(recoveringAgentId);
    const dealId = await closeDeal(client, recoveringAgentId, { realtor: 2000, company: 2000 });

    const events = await prisma.royalScoreEvent.findMany({
      where: { agentId: recoveringAgentId, sourceId: `client-recovered-${dealId}` },
    });
    expect(events).toHaveLength(1);
    expect(events[0].kind).toBe("client_recovered_bonus");
    expect(events[0].delta).toBe(CLIENT_RECOVERED_BONUS_POINTS);

    // deal_closed тоже должен был записаться отдельно — бонус не подменяет его.
    const dealClosed = await prisma.royalScoreEvent.findFirst({
      where: { agentId: recoveringAgentId, sourceId: dealId, kind: "deal_closed" },
    });
    expect(dealClosed?.delta).toBe(DEAL_CLOSED_POINTS);
  });

  it("НЕ начисляется на обычной сделке с клиентом, который никогда не был LOST", async () => {
    const client = await makeOrdinaryClient(recoveringAgentId);
    const dealId = await closeDeal(client, recoveringAgentId, { realtor: 2000, company: 2000 });

    const bonus = await prisma.royalScoreEvent.findFirst({
      where: { agentId: recoveringAgentId, sourceId: `client-recovered-${dealId}`, kind: "client_recovered_bonus" },
    });
    expect(bonus).toBeNull();
  });

  it("НЕ начисляется, если LOST-клиента довёл до сделки ТОТ ЖЕ агент, что его терял", async () => {
    const client = await makeRecoveredClient(losingAgentId);
    const dealId = await closeDeal(client, losingAgentId, { realtor: 2000, company: 2000 });

    const bonus = await prisma.royalScoreEvent.findFirst({
      where: { agentId: losingAgentId, sourceId: `client-recovered-${dealId}`, kind: "client_recovered_bonus" },
    });
    expect(bonus).toBeNull();
  });
});

/**
 * НАХОДКА АУДИТА 13.09.2026: переоценка ЗАКРЫТОЙ сделки до нулевой комиссии
 * (директор аннулирует сделку задним числом — мошенничество/ошибка) раньше
 * никак не трогала уже начисленные deal_closed/client_recovered_bonus — баллы
 * оставались висеть у агента навсегда. Записи журнала не удаляются
 * (lib/scoreJournal.ts) — компенсация начисляется ОТДЕЛЬНЫМ событием
 * («…_reversed») с тем же sourceId, что и оригинал.
 *
 * ПОЧЕМУ commissionRealtorAmount/commissionCompanyAmount, А НЕ commissionAmount:
 * последняя (и commissionPercent) в схеме — `moneyPositive()`/`z.number().
 * positive()` (packages/shared/src/schemas.ts), ноль они не пропускают вовсе.
 * Единственный реально достижимый способ обнулить комиссию закрытой сделки —
 * обе доли по нулю (moneyNonNegative() ноль разрешает) — см. isVoidingClosedDeal
 * в routes/deals.ts.
 */
describe("Переоценка закрытой сделки до нулевой комиссии отменяет её баллы", () => {
  it("deal_closed_reversed списывает баллы за закрытую сделку, ровно один раз", async () => {
    const client = await makeOrdinaryClient(recoveringAgentId);
    const dealId = await closeDeal(client, recoveringAgentId, { realtor: 2000, company: 2000 });

    const before = await prisma.royalScoreEvent.findFirst({
      where: { agentId: recoveringAgentId, sourceId: dealId, kind: "deal_closed" },
    });
    expect(before?.delta).toBe(DEAL_CLOSED_POINTS);

    const reprice = await request(app)
      .patch(`/api/v1/deals/${dealId}`)
      .set("Authorization", `Bearer ${token}`)
      .send({ commissionRealtorAmount: 0, commissionCompanyAmount: 0 });
    expect(reprice.status).toBe(200);

    const reversed = await prisma.royalScoreEvent.findFirst({
      where: { agentId: recoveringAgentId, sourceId: dealId, kind: "deal_closed_reversed" },
    });
    expect(reversed?.delta).toBe(-DEAL_CLOSED_POINTS);

    // Повторная переоценка до того же нуля (сеть моргнула, PATCH продублировался) —
    // не списывает баллы второй раз (unique(kind, sourceId, agentId), как и у самой
    // сделки выше).
    const repriceAgain = await request(app)
      .patch(`/api/v1/deals/${dealId}`)
      .set("Authorization", `Bearer ${token}`)
      .send({ commissionRealtorAmount: 0, commissionCompanyAmount: 0 });
    expect(repriceAgain.status).toBe(200);
    const reversedCount = await prisma.royalScoreEvent.count({
      where: { agentId: recoveringAgentId, sourceId: dealId, kind: "deal_closed_reversed" },
    });
    expect(reversedCount).toBe(1);

    // Оригинальная строка deal_closed остаётся в журнале нетронутой — компенсация,
    // а не удаление (lib/scoreJournal.ts, «ЗАПИСИ НЕ УДАЛЯЮТСЯ»).
    const original = await prisma.royalScoreEvent.findFirst({
      where: { agentId: recoveringAgentId, sourceId: dealId, kind: "deal_closed" },
    });
    expect(original?.delta).toBe(DEAL_CLOSED_POINTS);
  });

  it("client_recovered_bonus_reversed списывается вместе с deal_closed_reversed", async () => {
    const client = await makeRecoveredClient(recoveringAgentId);
    const dealId = await closeDeal(client, recoveringAgentId, { realtor: 2000, company: 2000 });

    const reprice = await request(app)
      .patch(`/api/v1/deals/${dealId}`)
      .set("Authorization", `Bearer ${token}`)
      .send({ commissionRealtorAmount: 0, commissionCompanyAmount: 0 });
    expect(reprice.status).toBe(200);

    const reversedBonus = await prisma.royalScoreEvent.findFirst({
      where: { agentId: recoveringAgentId, sourceId: `client-recovered-${dealId}`, kind: "client_recovered_bonus_reversed" },
    });
    expect(reversedBonus?.delta).toBe(-CLIENT_RECOVERED_BONUS_POINTS);
  });

  it("переоценка НЕ до нуля (комиссию просто поправили) баллы не трогает", async () => {
    const client = await makeOrdinaryClient(recoveringAgentId);
    const dealId = await closeDeal(client, recoveringAgentId, { realtor: 2000, company: 2000 });

    const reprice = await request(app)
      .patch(`/api/v1/deals/${dealId}`)
      .set("Authorization", `Bearer ${token}`)
      .send({ commissionRealtorAmount: 1750, commissionCompanyAmount: 1750 });
    expect(reprice.status).toBe(200);

    const reversed = await prisma.royalScoreEvent.findFirst({
      where: { agentId: recoveringAgentId, sourceId: dealId, kind: "deal_closed_reversed" },
    });
    expect(reversed).toBeNull();
  });
});

/**
 * Цена в журнале = цена, которой считается счёт (глубокая проверка 02.10.2026,
 * C11). Закрытие писало константу по умолчанию (+10, +3), а счёт брал цену из
 * Настроек: директор ставил «Сделка закрыта = 15» — агент видел «+10», счёт
 * прибавлял 15.
 */
describe("Начисления за сделку — по цене из каталога баллов (C11)", () => {
  it("цена «Сделка закрыта» и надбавки изменена в Настройках — журнал пишет её", async () => {
    const saved = await prisma.settings.findUnique({ where: { id: "singleton" }, select: { royalScoreEventPoints: true } });
    await prisma.settings.update({
      where: { id: "singleton" },
      data: { royalScoreEventPoints: { deal_closed: 15, client_recovered_bonus: 4 } },
    });
    try {
      const client = await makeRecoveredClient(recoveringAgentId);
      const dealId = await closeDeal(client, recoveringAgentId, { realtor: 2000, company: 2000 });
      const closed = await prisma.royalScoreEvent.findFirst({
        where: { agentId: recoveringAgentId, sourceId: dealId, kind: "deal_closed" },
      });
      expect(closed?.delta).toBe(15);
      const bonus = await prisma.royalScoreEvent.findFirst({
        where: { agentId: recoveringAgentId, sourceId: `client-recovered-${dealId}` },
      });
      expect(bonus?.delta).toBe(4);
    } finally {
      await prisma.settings.update({
        where: { id: "singleton" },
        data: { royalScoreEventPoints: (saved?.royalScoreEventPoints as Prisma.InputJsonValue | null) ?? Prisma.DbNull },
      });
    }
  });
});
