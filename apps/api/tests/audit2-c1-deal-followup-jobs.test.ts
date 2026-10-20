import bcrypt from "bcrypt";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * АУДИТ CODEX 04.10.2026, ПАКЕТ C1: ЗАДАНИЯ ПОСЛЕ ЗАКРЫТИЯ СДЕЛКИ.
 *
 * JOB-01  deal-close-followup после аннулирования сделки не должен снова помечать
 *         объект проданным (ни на сайте, ни в хронологии продавца);
 * JOB-02  deal-review-ask не спрашивает «как всё прошло» о сделке, которую аннулировали;
 * JOB-03  временный отказ доставки вопроса не должен стать окончательной потерей:
 *         отметка «спрошено» снимается, задание бросает ошибку и повторится по backoff
 *         (окно Meta закрыто — осознанное решение 12.09, отметка остаётся).
 *
 * Внешнее (сайт, доставка в мессенджер, уведомление продавца) замокано.
 */
const syncPropertiesToSite = vi.hoisted(() => vi.fn());
vi.mock("../src/lib/siteSync.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/lib/siteSync.js")>()),
  syncPropertiesToSite,
}));

const notifySellerSideOfSale = vi.hoisted(() => vi.fn(async () => undefined));
vi.mock("../src/lib/sellerSaleNotice.js", () => ({ notifySellerSideOfSale }));

const findClientDeliveryTarget = vi.hoisted(() => vi.fn());
const deliverToConversation = vi.hoisted(() => vi.fn());
vi.mock("../src/lib/conversationDelivery.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/lib/conversationDelivery.js")>()),
  findClientDeliveryTarget,
  deliverToConversation,
}));

import { prisma } from "../src/db.js";
import { dealCloseFollowupJob } from "../src/jobs/dealCloseFollowup.js";
import { dealReviewAskJob } from "../src/jobs/dealReviewAsk.js";

const runId = Date.now();
let districtId = "";
let agentId = "";
let buyerId = "";
let propertyId = "";
let dealId = "";

beforeAll(async () => {
  const passwordHash = await bcrypt.hash("testpass123", 10);
  districtId = (await prisma.district.create({ data: { name: `Тест-район-c1-сделки-${runId}` } })).id;
  agentId = (
    await prisma.agent.create({
      data: { fullName: `Агент c1-сделки ${runId}`, phone: `+992971${String(runId).slice(-9)}`, role: "AGENT", passwordHash },
    })
  ).id;
  buyerId = (
    await prisma.client.create({
      data: {
        fullName: `Покупатель c1 ${runId}`,
        phone: `+992972${String(runId).slice(-9)}`,
        source: "PHONE_CALL",
        assignedAgentId: agentId,
        acceptedAt: new Date(),
      },
    })
  ).id;
  propertyId = (
    await prisma.property.create({
      data: {
        title: `Объект c1-сделки ${runId}`,
        type: "APARTMENT",
        areaSqm: 55,
        price: 100000,
        currency: "TJS",
        districtId,
        address: "Тестовая, c1",
        condition: "GOOD",
        intakeAgentId: agentId,
        status: "SOLD",
        publishedOnSite: true,
      },
    })
  ).id;
  dealId = (await prisma.deal.create({ data: { clientId: buyerId, propertyId, agentId, stage: "COMPLETED" } })).id;
});

afterAll(async () => {
  await prisma.$executeRaw`DELETE FROM "DealReview" WHERE "dealId" = ${dealId}`;
  await prisma.deal.deleteMany({ where: { id: dealId } });
  await prisma.client.deleteMany({ where: { id: buyerId } });
  await prisma.property.deleteMany({ where: { id: propertyId } });
  await prisma.agent.deleteMany({ where: { id: agentId } });
  await prisma.district.deleteMany({ where: { id: districtId } });
  await prisma.$disconnect();
});

/** Живая закрытая сделка и проданный объект — исходное состояние каждого теста. */
async function resetClosed() {
  await prisma.deal.update({ where: { id: dealId }, data: { stage: "COMPLETED", annulledAt: null } });
  await prisma.property.update({ where: { id: propertyId }, data: { status: "SOLD" } });
  await prisma.$executeRaw`DELETE FROM "DealReview" WHERE "dealId" = ${dealId}`;
}

/** То, что делает lib/dealAnnul.ts: сделка отменена, объект вернулся в продажу. */
async function annul() {
  await prisma.deal.update({ where: { id: dealId }, data: { stage: "CANCELLED", annulledAt: new Date() } });
  await prisma.property.update({ where: { id: propertyId }, data: { status: "AVAILABLE" } });
}

const closePayload = () => ({ dealId, propertyId, closedById: agentId, buyerName: "Покупатель" });

beforeEach(async () => {
  syncPropertiesToSite.mockReset();
  syncPropertiesToSite.mockResolvedValue({ ok: true, results: [{ ok: true }] });
  notifySellerSideOfSale.mockClear();
  findClientDeliveryTarget.mockReset();
  deliverToConversation.mockReset();
  await resetClosed();
});

describe("JOB-01: deal-close-followup после аннулирования", () => {
  it("сделка аннулирована между попытками: ни «sold» на сайт, ни запись о продаже продавцу", async () => {
    await annul();
    await expect(dealCloseFollowupJob.run(closePayload())).resolves.toBeUndefined();
    expect(syncPropertiesToSite).not.toHaveBeenCalled();
    expect(notifySellerSideOfSale).not.toHaveBeenCalled();
  });

  it("гонка: первая попытка упала на сайте, сделку аннулировали, вторая ничего не шлёт", async () => {
    syncPropertiesToSite.mockResolvedValueOnce({ ok: false, error: "сайт недоступен" });
    await expect(dealCloseFollowupJob.run(closePayload())).rejects.toThrow();
    expect(syncPropertiesToSite).toHaveBeenCalledTimes(1);

    await annul();
    syncPropertiesToSite.mockClear();
    notifySellerSideOfSale.mockClear();
    await expect(dealCloseFollowupJob.run(closePayload())).resolves.toBeUndefined();
    expect(syncPropertiesToSite).not.toHaveBeenCalled();
    expect(notifySellerSideOfSale).not.toHaveBeenCalled();
  });

  it("живая закрытая сделка и проданный объект: работает как раньше", async () => {
    await dealCloseFollowupJob.run(closePayload());
    expect(notifySellerSideOfSale).toHaveBeenCalledOnce();
    expect(syncPropertiesToSite).toHaveBeenCalledOnce();
    expect(syncPropertiesToSite.mock.calls[0][1]).toBe("sold");
  });
});

describe("JOB-02: deal-review-ask после аннулирования", () => {
  it("сделка аннулирована: вопрос не уходит и отметка не создаётся", async () => {
    findClientDeliveryTarget.mockResolvedValue({ kind: "telegram", id: "c1" });
    deliverToConversation.mockResolvedValue({ ok: true });
    await annul();
    await expect(dealReviewAskJob.run({ dealId })).resolves.toBeUndefined();
    expect(deliverToConversation).not.toHaveBeenCalled();
    const rows = await prisma.$queryRaw<{ id: string }[]>`SELECT "id" FROM "DealReview" WHERE "dealId" = ${dealId}`;
    expect(rows).toHaveLength(0);
  });

  it("закрытая живая сделка: вопрос уходит покупателю", async () => {
    findClientDeliveryTarget.mockResolvedValue({ kind: "telegram", id: "c1" });
    deliverToConversation.mockResolvedValue({ ok: true });
    await dealReviewAskJob.run({ dealId });
    expect(deliverToConversation).toHaveBeenCalledOnce();
  });
});

describe("JOB-03: отказ доставки вопроса об отзыве", () => {
  const rowsCount = async () =>
    (await prisma.$queryRaw<{ id: string }[]>`SELECT "id" FROM "DealReview" WHERE "dealId" = ${dealId}`).length;

  it("временный отказ (не окно Meta): задание бросает, отметка снята, повтор отправляет", async () => {
    findClientDeliveryTarget.mockResolvedValue({ kind: "telegram", id: "c1" });
    deliverToConversation.mockResolvedValueOnce({ ok: false, status: 502, error: "транспорт" });

    await expect(dealReviewAskJob.run({ dealId })).rejects.toThrow();
    expect(await rowsCount()).toBe(0);

    deliverToConversation.mockResolvedValueOnce({ ok: true });
    await expect(dealReviewAskJob.run({ dealId })).resolves.toBeUndefined();
    expect(deliverToConversation).toHaveBeenCalledTimes(2);
    expect(await rowsCount()).toBe(1);
  });

  it("окно Meta закрыто: осознанное решение 12.09, отметка остаётся, задание не бросает", async () => {
    findClientDeliveryTarget.mockResolvedValue({ kind: "telegram", id: "c1" });
    deliverToConversation.mockResolvedValueOnce({ ok: false, status: 400, error: "окно", code: "window_closed" });
    await expect(dealReviewAskJob.run({ dealId })).resolves.toBeUndefined();
    expect(await rowsCount()).toBe(1);
  });
});
