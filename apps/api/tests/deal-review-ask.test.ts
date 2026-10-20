import bcrypt from "bcrypt";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { prisma } from "../src/db.js";
import { createDealReviewAsk } from "../src/lib/dealReviews.js";

/**
 * НОЧНАЯ ПРОВЕРКА 24.09.2026: ПОВТОРНАЯ ПРОСЬБА ОЦЕНИТЬ СДЕЛКУ.
 *
 * `createDealReviewAsk` вставляет строку `ON CONFLICT ("dealId", "clientId")
 * DO NOTHING` и раньше всегда возвращала `true`, даже когда конфликт погасил
 * вставку (0 строк) — jobs/dealReviewAsk.ts читал это как «только что создано»
 * и слал клиенту вопрос «оцените нас от 1 до 5» второй раз при повторном
 * исполнении задания очереди. Приём как в messengers/phoneRetryClaim.ts —
 * возвращать `changed > 0`.
 */
const runId = Date.now();
const password = "testpass123";

let districtId = "";
let agentId = "";
let clientId = "";
let propertyId = "";
let dealId = "";

beforeAll(async () => {
  const passwordHash = await bcrypt.hash(password, 10);
  districtId = (await prisma.district.create({ data: { name: `Тест-район-отзыв-сделки-${runId}` } })).id;
  agentId = (
    await prisma.agent.create({
      data: { fullName: `Агент отзыв-сделки ${runId}`, phone: `+992964${runId}`, role: "AGENT", passwordHash },
    })
  ).id;
  clientId = (
    await prisma.client.create({
      data: {
        fullName: `Клиент отзыв-сделки ${runId}`,
        phone: `+992965${runId}`,
        source: "PHONE_CALL",
        assignedAgentId: agentId,
        acceptedAt: new Date(),
      },
    })
  ).id;
  propertyId = (
    await prisma.property.create({
      data: {
        title: `Объект отзыв-сделки ${runId}`,
        type: "APARTMENT",
        areaSqm: 55,
        price: 100000,
        currency: "TJS",
        districtId,
        address: "Тестовая, отзыв сделки",
        condition: "GOOD",
        intakeAgentId: agentId,
      },
    })
  ).id;
  dealId = (
    await prisma.deal.create({
      data: { clientId, propertyId, agentId, stage: "COMPLETED" },
    })
  ).id;
});

afterAll(async () => {
  await prisma.dealReview.deleteMany({ where: { dealId } });
  await prisma.deal.deleteMany({ where: { id: dealId } });
  await prisma.client.deleteMany({ where: { id: clientId } });
  await prisma.property.deleteMany({ where: { id: propertyId } });
  await prisma.agent.deleteMany({ where: { id: agentId } });
  await prisma.district.deleteMany({ where: { id: districtId } });
  await prisma.$disconnect();
});

describe("createDealReviewAsk", () => {
  it("первый раз на пару (сделка, клиент) — true, повтор на ту же пару — false", async () => {
    const first = await createDealReviewAsk({ dealId, clientId, channel: "whatsapp" });
    expect(first).toBe(true);

    const second = await createDealReviewAsk({ dealId, clientId, channel: "whatsapp" });
    expect(second).toBe(false);

    const rows = await prisma.dealReview.findMany({ where: { dealId, clientId } });
    expect(rows).toHaveLength(1);
  });
});
