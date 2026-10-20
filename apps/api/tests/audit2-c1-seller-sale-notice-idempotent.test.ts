import bcrypt from "bcrypt";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * АУДИТ CODEX 04.10.2026, JOB-04: ПОВТОР deal-close-followup ДУБЛИРОВАЛ ИСТОРИЮ ПРОДАЖИ.
 *
 * Задание первым шагом зовёт notifySellerSideOfSale, вторым шлёт «sold» на сайт; отказ
 * сайта бросает ошибку и очередь повторяет ВСЁ задание. Без защиты повтор снова писал
 * продавцу «Объект №… продан» и снова пушил интейкеру. Теперь запись и пуш — один раз
 * на продажу (граница — Property.soldAt: повторная продажа после аннулирования
 * получает новый soldAt и честно пишется заново).
 */
const sendPushToAgent = vi.hoisted(() => vi.fn(async () => 1));
vi.mock("../src/push.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/push.js")>()),
  sendPushToAgent,
  sendPushToAgents: sendPushToAgent,
}));
vi.mock("../src/lib/sellerCardState.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/lib/sellerCardState.js")>()),
  recomputeSellerCardState: vi.fn(async () => ({ next: "KEEP", objectsInWork: 1 })),
}));

import { prisma } from "../src/db.js";
import { notifySellerSideOfSale } from "../src/lib/sellerSaleNotice.js";

const runId = Date.now();
let districtId = "";
let agentId = "";
let sellerId = "";
let propertyId = "";

const soldNotes = () =>
  prisma.interaction.findMany({
    where: { clientId: sellerId, propertyId, type: "SYSTEM", notes: { startsWith: "Объект №" } },
    orderBy: { createdAt: "asc" },
  });
const input = () => ({ propertyId, closedById: agentId, buyerName: "Покупатель" });

beforeAll(async () => {
  const passwordHash = await bcrypt.hash("testpass123", 10);
  districtId = (await prisma.district.create({ data: { name: `Тест-район-c1-продажа-${runId}` } })).id;
  agentId = (
    await prisma.agent.create({
      data: { fullName: `Агент c1-продажа ${runId}`, phone: `+992973${String(runId).slice(-9)}`, role: "AGENT", passwordHash },
    })
  ).id;
  sellerId = (
    await prisma.client.create({
      data: {
        fullName: `Продавец c1 ${runId}`,
        phone: `+992974${String(runId).slice(-9)}`,
        source: "PHONE_CALL",
        assignedAgentId: agentId,
        acceptedAt: new Date(),
      },
    })
  ).id;
  propertyId = (
    await prisma.property.create({
      data: {
        title: `Объект c1-продажа ${runId}`,
        type: "APARTMENT",
        areaSqm: 55,
        price: 100000,
        currency: "TJS",
        districtId,
        address: "Тестовая, c1 продажа",
        condition: "GOOD",
        intakeAgentId: agentId,
        sellerClientId: sellerId,
        status: "SOLD",
        soldAt: new Date(),
      },
    })
  ).id;
});

beforeEach(async () => {
  sendPushToAgent.mockClear();
  await prisma.interaction.deleteMany({ where: { clientId: sellerId } });
  await prisma.property.update({ where: { id: propertyId }, data: { soldAt: new Date() } });
});

afterAll(async () => {
  await prisma.interaction.deleteMany({ where: { clientId: sellerId } });
  await prisma.property.deleteMany({ where: { id: propertyId } });
  await prisma.client.deleteMany({ where: { id: sellerId } });
  await prisma.agent.deleteMany({ where: { id: agentId } });
  await prisma.district.deleteMany({ where: { id: districtId } });
  await prisma.$disconnect();
});

describe("notifySellerSideOfSale: повтор не дублирует историю продажи", () => {
  it("второй вызов на ту же продажу: одна запись в хронологии и один пуш", async () => {
    await notifySellerSideOfSale(input());
    await notifySellerSideOfSale(input());
    expect(await soldNotes()).toHaveLength(1);
    expect(sendPushToAgent).toHaveBeenCalledTimes(1);
  });

  it("повторная продажа после аннулирования (новый soldAt) пишется заново", async () => {
    await notifySellerSideOfSale(input());
    // Аннулировали и продали снова: dealAnnul обнуляет soldAt, закрытие ставит новый.
    await new Promise((r) => setTimeout(r, 20));
    await prisma.property.update({ where: { id: propertyId }, data: { soldAt: new Date() } });
    await notifySellerSideOfSale(input());
    expect(await soldNotes()).toHaveLength(2);
    expect(sendPushToAgent).toHaveBeenCalledTimes(2);
  });
});
