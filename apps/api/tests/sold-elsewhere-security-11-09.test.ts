import { afterAll, beforeAll, describe, expect, it } from "vitest";
import bcrypt from "bcrypt";
import {
  clientDeleteRequestSchema,
  DELETE_REQUEST_REASON_LABELS_SELLER,
  selectableDeleteReasonsFor,
} from "@royal-home/shared";
import { prisma } from "../src/db.js";
import { loadMorningNumbers } from "../src/lib/morningNumbers.js";

/**
 * Пачка 13, 11.09.2026 — «продано мимо агентства» и причины.
 *
 * п.1 (SOLD_ELSEWHERE ≥ 20 символов, автоматический вход в СБ) уже проверен в
 * seller-refusal-review.test.ts и property-delete-request.test.ts — здесь только
 * недостающая часть: причина CHANGED_MIND у карточки продавца и её отражение в
 * утренних числах отдельно от «пустышки» (NO_OBJECT).
 *
 * п.3 (Client.phoneLeakedAt) проверять нечего: поле уже удалено миграцией
 * 20260910060151_drop_unused_phone_leaked раньше этой пачки (см. отчёт агента).
 */

describe("CHANGED_MIND — причина «передумал продавать»", () => {
  it("предлагается продавцу", () => {
    const reasons = selectableDeleteReasonsFor("SELLER");
    expect(reasons).toContain("CHANGED_MIND");
  });

  it("покупателю не предлагается — это причина продавца", () => {
    const reasons = selectableDeleteReasonsFor("BUYER");
    expect(reasons).not.toContain("CHANGED_MIND");
  });

  it("у продавца подпись про продажу, а не общая заглушка", () => {
    expect(DELETE_REQUEST_REASON_LABELS_SELLER.CHANGED_MIND).toContain("продавать");
  });

  it("проходит валидацию без комментария — как и остальные причины, кроме OTHER", () => {
    const res = clientDeleteRequestSchema.safeParse({ reason: "CHANGED_MIND" });
    expect(res.success).toBe(true);
  });
});

describe("Утренние числа: СБ и причины отдельно за неделю", () => {
  const runId = Date.now();
  let agentId = "";
  let districtId = "";
  const clientIds: string[] = [];
  const propertyIds: string[] = [];

  beforeAll(async () => {
    agentId = (
      await prisma.agent.create({
        data: {
          fullName: `Агент пачки 13 ${runId}`,
          phone: `+992946${String(runId).slice(-7)}`,
          role: "AGENT",
          passwordHash: await bcrypt.hash("testpass123", 10),
        },
      })
    ).id;
    districtId = (await prisma.district.create({ data: { name: `Район пачки 13 ${runId}` } })).id;
  });

  afterAll(async () => {
    await prisma.propertyDeleteRequest.deleteMany({ where: { propertyId: { in: propertyIds } } });
    await prisma.property.deleteMany({ where: { id: { in: propertyIds } } });
    await prisma.clientDeleteRequest.deleteMany({ where: { clientId: { in: clientIds } } });
    await prisma.client.deleteMany({ where: { id: { in: clientIds } } });
    await prisma.agent.deleteMany({ where: { id: agentId } });
    await prisma.district.deleteMany({ where: { id: districtId } });
    await prisma.$disconnect();
  });

  async function makeSeller() {
    const seller = await prisma.client.create({
      data: {
        fullName: `Продавец пачки 13 ${runId}-${clientIds.length}`,
        phone: `+992947${runId}${clientIds.length}`,
        source: "PHONE_CALL",
        kind: "SELLER",
        assignedAgentId: agentId,
      },
    });
    clientIds.push(seller.id);
    return seller;
  }

  it("CHANGED_MIND и NO_OBJECT считаются раздельно, не штрафуя друг друга в одну кучу", async () => {
    const changedMindSeller = await makeSeller();
    const changedMindRequest = await prisma.clientDeleteRequest.create({
      data: { clientId: changedMindSeller.id, requestedById: agentId, reason: "CHANGED_MIND" },
    });
    await prisma.clientDeleteRequest.update({
      where: { id: changedMindRequest.id },
      data: { status: "APPROVED", decidedById: agentId, decidedAt: new Date() },
    });

    const emptySeller = await makeSeller();
    const emptyRequest = await prisma.clientDeleteRequest.create({
      data: { clientId: emptySeller.id, requestedById: agentId, reason: "NO_OBJECT" },
    });
    await prisma.clientDeleteRequest.update({
      where: { id: emptyRequest.id },
      data: { status: "APPROVED", decidedById: agentId, decidedAt: new Date() },
    });

    const numbers = await loadMorningNumbers();
    expect(numbers.changedMindWeek).toBeGreaterThanOrEqual(1);
    expect(numbers.emptySellerCardsWeek).toBeGreaterThanOrEqual(1);
  });

  it("PENDING заявки в недельный счёт не попадают — считаем только исполненное", async () => {
    const seller = await makeSeller();
    await prisma.clientDeleteRequest.create({
      data: { clientId: seller.id, requestedById: agentId, reason: "CHANGED_MIND" },
    });

    const before = await loadMorningNumbers();
    const seller2 = await makeSeller();
    const pending = await prisma.clientDeleteRequest.create({
      data: { clientId: seller2.id, requestedById: agentId, reason: "CHANGED_MIND" },
    });
    const after = await loadMorningNumbers();
    expect(after.changedMindWeek).toBe(before.changedMindWeek);
    // заявка правда осталась PENDING, а не молча одобрилась сама
    const stillPending = await prisma.clientDeleteRequest.findUnique({ where: { id: pending.id } });
    expect(stillPending?.status).toBe("PENDING");
  });

  it("«продано мимо агентства» за неделю считает одобренные SOLD_ELSEWHERE заявки объекта", async () => {
    const seller = await makeSeller();
    const property = await prisma.property.create({
      data: {
        title: `Объект пачки 13 ${runId}`,
        type: "APARTMENT",
        areaSqm: 40,
        price: 40000,
        currency: "TJS",
        districtId,
        address: "Тест пачка 13",
        condition: "GOOD",
        status: "WITHDRAWN",
        sellerClientId: seller.id,
      },
    });
    propertyIds.push(property.id);

    const before = await loadMorningNumbers();
    const req = await prisma.propertyDeleteRequest.create({
      data: {
        propertyId: property.id,
        requestedById: agentId,
        reason: "SOLD_ELSEWHERE",
        comment: "Продали через агентство «Соседний дом», подтвердили лично",
      },
    });
    await prisma.propertyDeleteRequest.update({
      where: { id: req.id },
      data: { status: "APPROVED", decidedById: agentId, decidedAt: new Date() },
    });
    const after = await loadMorningNumbers();
    expect(after.soldElsewhereWeek).toBe(before.soldElsewhereWeek + 1);
  });
});
