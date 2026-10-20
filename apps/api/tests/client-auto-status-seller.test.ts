import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { prisma } from "../src/db.js";

const { collectFactsForSeller, refreshClientStatus, refreshStatusesByTime } = await import(
  "../src/lib/clientAutoStatus.js"
);

/**
 * 15.09.2026 — движок автостатуса (lib/clientAutoStatus.ts) расширен с
 * buyer-only на покупателя И продавца (см. коммит «распространить движок на
 * продавца»). До этой правки refreshClientStatus выходил сразу же для
 * kind === "SELLER" (`return null`), и NEW/CONTACTED/HOT/COLD/UNRESPONSIVE/
 * ARCHIVED у продавца не двигал никто — ручной PATCH статуса продавцу уже
 * запрещён (fix/seller-card-manual-status-defer-15-09), а без этой правки
 * статус продавца просто замер бы навсегда.
 *
 * Терминальные DEAL_CLOSED/LOST по продавцу по-прежнему считает и пишет
 * ОТДЕЛЬНЫЙ модуль lib/sellerCardState.ts (см. tests/deal-closes-seller-status.test.ts) —
 * здесь их не трогаем, поэтому во всех фикстурах ниже статус продавца до
 * пересчёта NEW, а сделки, где они есть, не COMPLETED.
 */

const runId = Date.now();
let districtId: string;
let agentId: string;
const clientIds: string[] = [];
const propertyIds: string[] = [];
const dealIds: string[] = [];

async function makeSeller(overrides: Partial<{ lastContactAt: Date }> = {}) {
  const c = await prisma.client.create({
    data: {
      fullName: `Продавец автостатуса ${runId}-${clientIds.length}`,
      phone: `+992960${runId}${clientIds.length}`,
      kind: "SELLER",
      source: "PHONE_CALL",
      assignedAgentId: agentId,
      acceptedAt: new Date(),
      status: "NEW",
      ...overrides,
    },
  });
  clientIds.push(c.id);
  return c;
}

async function makeBuyer() {
  const c = await prisma.client.create({
    data: {
      fullName: `Покупатель автостатуса ${runId}-${clientIds.length}`,
      phone: `+992961${runId}${clientIds.length}`,
      source: "PHONE_CALL",
      assignedAgentId: agentId,
      acceptedAt: new Date(),
      status: "NEW",
    },
  });
  clientIds.push(c.id);
  return c;
}

async function makeProperty(sellerClientId: string) {
  const p = await prisma.property.create({
    data: {
      title: `Объект автостатуса ${runId}-${propertyIds.length}`,
      type: "APARTMENT",
      areaSqm: 50,
      price: 100000,
      currency: "TJS",
      districtId,
      address: "Тестовая, автостатус",
      condition: "GOOD",
      sellerClientId,
    },
  });
  propertyIds.push(p.id);
  return p;
}

beforeAll(async () => {
  districtId = (await prisma.district.create({ data: { name: `Тест-район-автостатус-продавец-${runId}` } })).id;
  const agent = await prisma.agent.create({
    data: {
      fullName: "Агент автостатуса продавца",
      phone: `+992946${runId}`,
      role: "AGENT",
      passwordHash: "x",
    },
  });
  agentId = agent.id;
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

describe("collectFactsForSeller: откуда берутся факты у продавца", () => {
  it("отвеченный звонок продавцу — talked=true", async () => {
    const seller = await makeSeller();
    await prisma.interaction.create({
      data: { clientId: seller.id, agentId, type: "CALL", outcome: "WAITING_CALL", notes: "Поговорили" },
    });

    const facts = await collectFactsForSeller(seller.id);
    expect(facts.talked).toBe(true);
    expect(facts.dealClosed).toBe(false);
  });

  it("встреча с продавцом (MEETING/SELLER_MEETING) — showing=true, а SHOWING-тип у продавца не считается", async () => {
    const seller = await makeSeller();
    // SHOWING — показ ОБЪЕКТА покупателю, у продавца такой интеракции не бывает;
    // если бы она всё же встретилась, showing не должна из-за неё стать true.
    await prisma.interaction.create({
      data: { clientId: seller.id, agentId, type: "SHOWING", notes: "Чужой показ, не должен считаться" },
    });
    let facts = await collectFactsForSeller(seller.id);
    expect(facts.showing).toBe(false);

    await prisma.interaction.create({
      data: { clientId: seller.id, agentId, type: "MEETING", outcome: "SELLER_MEETING", notes: "Встреча на объекте" },
    });
    facts = await collectFactsForSeller(seller.id);
    expect(facts.showing).toBe(true);
  });

  it("незавершённая сделка по объекту продавца — activeDeal=true, dealClosed всегда false", async () => {
    const seller = await makeSeller();
    const buyer = await makeBuyer();
    const property = await makeProperty(seller.id);
    const deal = await prisma.deal.create({
      data: { clientId: buyer.id, propertyId: property.id, agentId, stage: "NEGOTIATION" },
    });
    dealIds.push(deal.id);

    const facts = await collectFactsForSeller(seller.id);
    expect(facts.activeDeal).toBe(true);
    // Терминальные статусы продавца считает sellerCardState.ts, а не этот путь —
    // даже если бы сделка была COMPLETED, collectFactsForSeller не должен был бы
    // сообщать dealClosed:true (второй источник правды).
    expect(facts.dealClosed).toBe(false);
  });

  it("сделка по объекту ДРУГОГО продавца не считается — activeDeal=false", async () => {
    const seller = await makeSeller();
    const otherSeller = await makeSeller();
    const buyer = await makeBuyer();
    const otherProperty = await makeProperty(otherSeller.id);
    const deal = await prisma.deal.create({
      data: { clientId: buyer.id, propertyId: otherProperty.id, agentId, stage: "NEGOTIATION" },
    });
    dealIds.push(deal.id);

    const facts = await collectFactsForSeller(seller.id);
    expect(facts.activeDeal).toBe(false);
  });

  it("aiScore карточки продавца попадает в факты как есть", async () => {
    const seller = await makeSeller();
    await prisma.client.update({ where: { id: seller.id }, data: { aiScore: 82 } });

    const facts = await collectFactsForSeller(seller.id);
    expect(facts.aiScore).toBe(82);
  });

  it("aiScore не посчитан — факты отдают null, а не undefined/ошибку", async () => {
    const seller = await makeSeller();

    const facts = await collectFactsForSeller(seller.id);
    expect(facts.aiScore).toBeNull();
  });
});

describe("refreshClientStatus: движок теперь двигает статус продавца", () => {
  it("был ответивший звонок — статус уходит в «На контакте»", async () => {
    const seller = await makeSeller();
    await prisma.interaction.create({
      data: { clientId: seller.id, agentId, type: "CALL", outcome: "WAITING_CALL", notes: "Поговорили" },
    });

    const next = await refreshClientStatus(seller.id);
    expect(next).toBe("CONTACTED");

    const after = await prisma.client.findUnique({ where: { id: seller.id } });
    expect(after?.status).toBe("CONTACTED");

    // Запись в хронологию — тем же приёмом, что у покупателя: STATUS_CHANGE без
    // agentId-инициатора решения, но с ответственным агентом как автором записи.
    const history = await prisma.interaction.findFirst({
      where: { clientId: seller.id, type: "STATUS_CHANGE" },
    });
    expect(history?.notes).toContain("На контакте");
  });

  it("назначена встреча с продавцом или активная сделка — «Горячий»", async () => {
    const seller = await makeSeller();
    await prisma.interaction.create({
      data: { clientId: seller.id, agentId, type: "MEETING", outcome: "SELLER_MEETING", notes: "Встреча назначена" },
    });

    const next = await refreshClientStatus(seller.id);
    expect(next).toBe("HOT");

    const after = await prisma.client.findUnique({ where: { id: seller.id } });
    expect(after?.status).toBe("HOT");
  });

  it("активная сделка по объекту продавца без единого звонка — тоже «Горячий»", async () => {
    const seller = await makeSeller();
    const buyer = await makeBuyer();
    const property = await makeProperty(seller.id);
    const deal = await prisma.deal.create({
      data: { clientId: buyer.id, propertyId: property.id, agentId, stage: "NEGOTIATION" },
    });
    dealIds.push(deal.id);

    const next = await refreshClientStatus(seller.id);
    expect(next).toBe("HOT");
  });

  it("три недозвона подряд продавцу — «Не отвечает»", async () => {
    const seller = await makeSeller();
    const old = new Date(Date.now() - 2 * 86_400_000);
    for (let i = 0; i < 3; i++) {
      await prisma.interaction.create({
        data: { clientId: seller.id, agentId, type: "CALL", outcome: "NO_ANSWER", notes: "Недозвон", createdAt: old },
      });
    }

    const next = await refreshClientStatus(seller.id);
    expect(next).toBe("UNRESPONSIVE");
  });

  it("высокий aiScore без встречи и без сделки — тоже «Горячий» (16.09.2026)", async () => {
    const seller = await makeSeller();
    await prisma.client.update({ where: { id: seller.id }, data: { aiScore: 75 } });

    const next = await refreshClientStatus(seller.id);
    expect(next).toBe("HOT");
  });

  it("aiScore ниже порога (70) сам по себе «Горячий» не делает", async () => {
    const seller = await makeSeller();
    // Единственный недозвон — только чтобы lastEventAt было «сейчас», а не эпоха
    // (пустая хронология сама по себе не про aiScore, см. collectSharedFacts);
    // одного недозвона мало для UNRESPONSIVE (порог — 3 подряд).
    await prisma.interaction.create({
      data: { clientId: seller.id, agentId, type: "CALL", outcome: "NO_ANSWER", notes: "Недозвон" },
    });
    await prisma.client.update({ where: { id: seller.id }, data: { aiScore: 69 } });

    const next = await refreshClientStatus(seller.id);
    expect(next).toBeNull();
  });
});

describe("refreshStatusesByTime: ночной проход теперь подбирает и продавцов", () => {
  it("продавец с тремя недозвонами и старым lastContactAt пересчитывается ночным проходом", async () => {
    // Дата специально далеко в прошлом (до любых синтетических данных прогона),
    // чтобы гарантированно попасть в топ выборки `orderBy lastContactAt asc, take 500`
    // независимо от того, что уже лежит в общей тестовой базе.
    const veryOld = new Date("1995-01-01T00:00:00Z");
    const seller = await makeSeller({ lastContactAt: veryOld });
    for (let i = 0; i < 3; i++) {
      await prisma.interaction.create({
        data: { clientId: seller.id, agentId, type: "CALL", outcome: "NO_ANSWER", notes: "Недозвон", createdAt: veryOld },
      });
    }

    const { checked } = await refreshStatusesByTime();
    expect(checked).toBeGreaterThan(0);

    const after = await prisma.client.findUnique({ where: { id: seller.id } });
    expect(after?.status).toBe("UNRESPONSIVE");
  });
});
