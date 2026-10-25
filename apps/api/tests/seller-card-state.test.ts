import { afterAll, beforeAll, describe, expect, it } from "vitest";
import bcrypt from "bcrypt";
import { prisma } from "../src/db.js";
import { decideSellerCardState, recomputeSellerCardState } from "../src/lib/sellerCardState.js";

/**
 * Состояние карточки продавца пересчитывается, а не выбирается (владелец 09.09.2026).
 *
 * Главное, что здесь проверяется, — ДВА правила, каждое из которых закрывает
 * конкретную дыру:
 *
 *  «УСПЕХ ВАЖНЕЕ ОТКАЗА» — продавец, продавший одну квартиру и снявший с продажи
 *  вторую, уходит в «Завершённые сделки», а не в «Потерянные». Решать по последнему
 *  действию значило бы записать в потери человека, принёсшего компании деньги.
 *
 *  «ПОКА ЕСТЬ ОБЪЕКТЫ В РАБОТЕ — КАРТОЧКА ЖИВАЯ» — продажа ПЕРВОЙ из трёх квартир
 *  карточку не закрывает.
 */

const runId = Date.now();
let agentId: string;
let districtId: string;
const clientIds: string[] = [];
const propertyIds: string[] = [];
const dealIds: string[] = [];

beforeAll(async () => {
  const passwordHash = await bcrypt.hash("testpass123", 10);
  agentId = (
    await prisma.agent.create({
      data: { fullName: "Агент состояния", phone: `+992941${runId}`, role: "AGENT", passwordHash },
    })
  ).id;
  districtId = (await prisma.district.create({ data: { name: `Район-состояние-${runId}` } })).id;
});

afterAll(async () => {
  await prisma.deal.deleteMany({ where: { id: { in: dealIds } } });
  await prisma.interaction.deleteMany({ where: { clientId: { in: clientIds } } });
  await prisma.property.deleteMany({ where: { id: { in: propertyIds } } });
  await prisma.client.deleteMany({ where: { id: { in: clientIds } } });
  await prisma.agent.deleteMany({ where: { id: agentId } });
  await prisma.district.deleteMany({ where: { id: districtId } });
  await prisma.$disconnect();
});

async function makeSeller() {
  const c = await prisma.client.create({
    data: {
      fullName: `Продавец состояния ${runId}-${clientIds.length}`,
      phone: `+992942${runId}${clientIds.length}`,
      source: "PHONE_CALL",
      kind: "SELLER",
      assignedAgentId: agentId,
      workStatus: "ACTIVE",
    },
  });
  clientIds.push(c.id);
  return c;
}

async function makeProperty(sellerClientId: string, status: "AVAILABLE" | "SOLD" | "WITHDRAWN" | "EDITING") {
  const p = await prisma.property.create({
    data: {
      title: `Объект состояния ${runId}-${propertyIds.length}`,
      type: "APARTMENT",
      areaSqm: 50,
      price: 60000,
      currency: "TJS",
      districtId,
      address: "Тест",
      condition: "GOOD",
      status,
      sellerClientId,
      intakeAgentId: agentId,
    },
  });
  propertyIds.push(p.id);
  return p;
}

async function makeCompletedDeal(propertyId: string) {
  // Сделке нужен покупатель — по схеме клиент сделки всегда BUYER.
  const buyer = await prisma.client.create({
    data: {
      fullName: `Покупатель ${runId}-${clientIds.length}`,
      phone: `+992943${runId}${clientIds.length}`,
      source: "PHONE_CALL",
      kind: "BUYER",
    },
  });
  clientIds.push(buyer.id);
  const deal = await prisma.deal.create({
    data: { clientId: buyer.id, propertyId, agentId, stage: "COMPLETED", closedAt: new Date() },
  });
  dealIds.push(deal.id);
  return deal;
}

describe("Правило без базы", () => {
  it("работа не кончена — карточку не трогаем, даже если сделка уже была", () => {
    expect(decideSellerCardState({ hasCompletedDeal: true, objectsInWork: 1 })).toEqual({
      next: "KEEP",
      objectsInWork: 1,
    });
  });

  it("работа кончена и сделка была — завершённые сделки", () => {
    expect(decideSellerCardState({ hasCompletedDeal: true, objectsInWork: 0 })).toEqual({ next: "DEAL_CLOSED" });
  });

  it("есть объекты в работе — карточку не трогаем", () => {
    expect(decideSellerCardState({ hasCompletedDeal: false, objectsInWork: 2 })).toEqual({
      next: "KEEP",
      objectsInWork: 2,
    });
  });

  it("ни сделок, ни объектов — в потерянные с причиной", () => {
    expect(decideSellerCardState({ hasCompletedDeal: false, objectsInWork: 0, lostReason: "SOLD_ELSEWHERE" })).toEqual({
      next: "LOST",
      reason: "SOLD_ELSEWHERE",
    });
  });
});

describe("Пересчёт по базе", () => {
  it("снятие последнего объекта не завершает карточку с двойной ролью", async () => {
    const seller = await makeSeller();
    await prisma.client.update({ where: { id: seller.id }, data: { dualIntent: true } });
    await makeProperty(seller.id, "WITHDRAWN");
    expect(await recomputeSellerCardState({ sellerClientId: seller.id, lostReason: "OWNER_CANCELLED" })).toEqual({ next: "KEEP", objectsInWork: 0 });
    const after = await prisma.client.findUniqueOrThrow({ where: { id: seller.id } });
    expect(after.status).toBe(seller.status);
    expect(after.assignedAgentId).toBe(agentId);
  });
  it("снятие объекта не закрывает карточку с открытой сделкой", async () => {
    const seller = await makeSeller();
    const property = await makeProperty(seller.id, "WITHDRAWN");
    const deal = await prisma.deal.create({ data: { clientId: seller.id, propertyId: property.id, agentId, stage: "NEGOTIATION" } });
    dealIds.push(deal.id);
    expect(await recomputeSellerCardState({ sellerClientId: seller.id })).toEqual({ next: "KEEP", objectsInWork: 0 });
    expect((await prisma.client.findUniqueOrThrow({ where: { id: seller.id } })).status).toBe(seller.status);
  });
  it("продан ОДИН объект из трёх — карточка остаётся активной", async () => {
    const seller = await makeSeller();
    const sold = await makeProperty(seller.id, "SOLD");
    await makeProperty(seller.id, "AVAILABLE");
    await makeProperty(seller.id, "EDITING");
    await makeCompletedDeal(sold.id);

    const verdict = await recomputeSellerCardState({ sellerClientId: seller.id });
    expect(verdict).toEqual({ next: "KEEP", objectsInWork: 2 });

    const after = await prisma.client.findUnique({ where: { id: seller.id } });
    expect(after?.status).not.toBe("DEAL_CLOSED");
    expect(after?.assignedAgentId).toBe(agentId);
  });

  it("продан последний объект — карточка уходит в завершённые сделки", async () => {
    const seller = await makeSeller();
    const sold = await makeProperty(seller.id, "SOLD");
    await makeCompletedDeal(sold.id);

    const verdict = await recomputeSellerCardState({ sellerClientId: seller.id });
    expect(verdict).toEqual({ next: "DEAL_CLOSED" });

    const after = await prisma.client.findUnique({ where: { id: seller.id } });
    expect(after?.status).toBe("DEAL_CLOSED");
    // Агент остаётся: именно к нему продавец вернётся, если решит продавать снова.
    expect(after?.lastAgentId).toBe(agentId);
  });

  /** ТА САМАЯ ПРОВЕРКА, РАДИ КОТОРОЙ ПРАВИЛО И ПИСАЛОСЬ. */
  it("одна квартира продана, вторая снята с продажи — это ЗАВЕРШЁННАЯ СДЕЛКА, а не потеря", async () => {
    const seller = await makeSeller();
    const sold = await makeProperty(seller.id, "SOLD");
    await makeProperty(seller.id, "WITHDRAWN");
    await makeCompletedDeal(sold.id);

    const verdict = await recomputeSellerCardState({ sellerClientId: seller.id, lostReason: "OWNER_CANCELLED" });
    expect(verdict).toEqual({ next: "DEAL_CLOSED" });
    expect((await prisma.client.findUnique({ where: { id: seller.id } }))?.status).toBe("DEAL_CLOSED");
  });

  it("все объекты сняты, сделок не было — в потерянные, агент сохраняется, lastAgentId — след остаётся", async () => {
    const seller = await makeSeller();
    await makeProperty(seller.id, "WITHDRAWN");

    const verdict = await recomputeSellerCardState({ sellerClientId: seller.id, lostReason: "SOLD_ELSEWHERE" });
    expect(verdict).toEqual({ next: "LOST", reason: "SOLD_ELSEWHERE" });

    const after = await prisma.client.findUnique({ where: { id: seller.id } });
    expect(after?.status).toBe("LOST");
    expect(after?.assignedAgentId).toBe(agentId);
    expect(after?.lastAgentId).toBe(agentId);
    expect(after?.refusalReason).toBe("SOLD_ELSEWHERE");
  });

  /**
   * Счётчик тишины обязан встать при любом исходе: после продажи или оформленного
   * отказа агент законно может не звонить этому человеку несколько дней, и тревога
   * «агент забросил клиента» по нему — ложное обвинение.
   */
  it("счётчик тишины останавливается при любом исходе", async () => {
    const seller = await makeSeller();
    await makeProperty(seller.id, "AVAILABLE");
    const before = new Date(Date.now() - 60_000);
    await prisma.client.update({ where: { id: seller.id }, data: { lastAgentAttemptAt: before } });

    await recomputeSellerCardState({ sellerClientId: seller.id });

    const after = await prisma.client.findUnique({ where: { id: seller.id } });
    expect(after?.lastAgentAttemptAt).not.toBeNull();
    expect(after!.lastAgentAttemptAt!.getTime()).toBeGreaterThan(before.getTime());
  });

  it("архивную карточку автоматика не трогает", async () => {
    const seller = await makeSeller();
    await prisma.client.update({ where: { id: seller.id }, data: { status: "ARCHIVED" } });

    expect(await recomputeSellerCardState({ sellerClientId: seller.id })).toBeNull();
    expect((await prisma.client.findUnique({ where: { id: seller.id } }))?.status).toBe("ARCHIVED");
  });

  it("карточки продавца нет вовсе — молча ничего не делаем", async () => {
    expect(await recomputeSellerCardState({ sellerClientId: "00000000-0000-0000-0000-000000000000" })).toBeNull();
  });
});
