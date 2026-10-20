import { afterAll, beforeAll, describe, expect, it } from "vitest";
import bcrypt from "bcrypt";
import request from "supertest";
import { app } from "../src/app.js";
import { prisma } from "../src/db.js";
import { allocateCents } from "../src/lib/ads/adAllocation.js";
import { setAdProperties } from "../src/lib/ads/adAllocation.js";

/**
 * GET /properties/:id/voice — деньги и сделки по ПРАВАМ экранов-источников
 * (аудит «голоса рынка» 03.10.2026) и доли «гибкого» объявления.
 *
 *  • реклама: суммы только с finance.view или ролью MARKETING (как GET /ads/property/:id);
 *    у остальных — spendTjs/spendOriginal = null, `ads.moneyHidden`, в диагнозе нет строки расхода;
 *  • сделки: без deals.viewAll — только свои (scopeDealsToOwnAgent); цену чужой сделки без
 *    finance.view не получает никто (SECURITY видит факт сделки, но не цену);
 *  • showingFeedback — только с dashboard.analytics;
 *  • объявление на 4 объекта: у каждого в /voice своя доля, сумма долей = расходу объявления.
 */

const runId = Date.now();
const password = "testpass123";

const tokens: Record<string, string> = {};
const agentIds: Record<string, string> = {};
let districtId = "";
const propertyIds: string[] = [];
const propertyShortIds: number[] = [];
let adId = "";
const clientIds: string[] = [];
const dealIds: string[] = [];

/** Веса объявления по четырём объектам и расход объявления в целых сотых (1000,00 сомони). */
const WEIGHTS = [4, 3, 2, 1];
const AD_TOTAL_CENTS = 100_000;
const SECRET_SOLD_PRICE = 85_123;
const OWN_SOLD_PRICE = 91_234;

async function login(phone: string) {
  const res = await request(app).post("/api/v1/auth/login").send({ phone, password });
  expect(res.status).toBe(200);
  return res.body.accessToken as string;
}

async function voice(role: string, index = 0) {
  const res = await request(app)
    .get(`/api/v1/properties/${propertyShortIds[index]}/voice`)
    .set("Authorization", `Bearer ${tokens[role]}`);
  expect(res.status).toBe(200);
  return res.body;
}

beforeAll(async () => {
  const passwordHash = await bcrypt.hash(password, 10);
  districtId = (await prisma.district.create({ data: { name: `Тест-район-права-голоса-${runId}` } })).id;
  const roles: [string, "AGENT" | "DIRECTOR" | "MARKETING" | "SECURITY", string][] = [
    ["agentA", "AGENT", "983"],
    ["agentB", "AGENT", "984"],
    ["director", "DIRECTOR", "985"],
    ["marketing", "MARKETING", "986"],
    ["security", "SECURITY", "987"],
  ];
  for (const [key, role, prefix] of roles) {
    agentIds[key] = (
      await prisma.agent.create({
        data: { fullName: `Права голоса ${key}`, phone: `+992${prefix}${runId}`, role, passwordHash },
      })
    ).id;
    tokens[key] = await login(`+992${prefix}${runId}`);
  }

  for (let i = 0; i < WEIGHTS.length; i++) {
    const p = await prisma.property.create({
      data: {
        title: `Объект прав голоса ${i} ${runId}`,
        type: "APARTMENT",
        areaSqm: 55,
        rooms: 2,
        price: 400_000,
        currency: "TJS",
        districtId,
        address: `Тестовая права, ${i}`,
        condition: "GOOD",
        status: "AVAILABLE",
        assignedAgentId: agentIds.agentA,
      },
    });
    propertyIds.push(p.id);
    propertyShortIds.push(p.shortId);
  }

  // «Гибкое» объявление на четыре объекта; расход — три строки, сумма ровно 1000,00 сомони.
  const ad = await prisma.ad.create({
    data: {
      platform: "META",
      externalId: `voice-rights-${runId}`,
      name: `Гибкое права голоса ${runId}`,
      lastSyncedAt: new Date(),
    },
  });
  adId = ad.id;
  await setAdProperties(
    adId,
    propertyIds.map((propertyId, i) => ({ propertyId, weight: WEIGHTS[i] })),
    "FEED_CAPTION"
  );
  await prisma.adSpendDaily.createMany({
    data: [
      { adId, date: new Date("2025-03-01"), spend: 400, currency: "TJS", impressions: 500, clicks: 11, conversations: 0 },
      { adId, date: new Date("2025-03-02"), spend: 333.33, currency: "TJS", impressions: 300, clicks: 7, conversations: 0 },
      { adId, date: new Date("2025-03-03"), spend: 266.67, currency: "TJS", impressions: 201, clicks: 5, conversations: 0 },
    ],
  });

  // Сделки по объекту 0: чужая (агент B) с ценой, своя у агента A.
  for (const phoneTail of ["1", "2"]) {
    clientIds.push(
      (
        await prisma.client.create({
          data: {
            fullName: `Покупатель права голоса ${phoneTail}`,
            phone: `+99274${phoneTail}${String(runId).slice(-6)}`,
            source: "PHONE_CALL",
            assignedAgentId: agentIds.agentA,
          },
        })
      ).id
    );
  }
  dealIds.push(
    (
      await prisma.deal.create({
        data: {
          clientId: clientIds[0],
          propertyId: propertyIds[0],
          agentId: agentIds.agentB,
          stage: "COMPLETED",
          soldPrice: SECRET_SOLD_PRICE,
          currency: "TJS",
          closedAt: new Date(),
        },
      })
    ).id,
    (
      await prisma.deal.create({
        data: {
          clientId: clientIds[1],
          propertyId: propertyIds[0],
          agentId: agentIds.agentA,
          stage: "PENDING_APPROVAL",
          soldPrice: OWN_SOLD_PRICE,
          currency: "TJS",
        },
      })
    ).id
  );

  await prisma.showingSurveyCall.create({
    data: {
      interactionId: `rights-survey-${runId}`,
      clientId: `rights-client-${runId}`,
      agentId: agentIds.agentA,
      propertyId: propertyIds[0],
      redFlags: [{ category: "agent_rude", detail: "секретная жалоба" }],
    },
  });
});

afterAll(async () => {
  await prisma.showingSurveyCall.deleteMany({ where: { propertyId: { in: propertyIds } } });
  await prisma.deal.deleteMany({ where: { id: { in: dealIds } } });
  await prisma.client.deleteMany({ where: { id: { in: clientIds } } });
  await prisma.ad.deleteMany({ where: { id: adId } });
  await prisma.property.deleteMany({ where: { id: { in: propertyIds } } });
  await prisma.agent.deleteMany({ where: { id: { in: Object.values(agentIds) } } });
  await prisma.district.deleteMany({ where: { id: districtId } });
  await prisma.$disconnect();
});

describe("GET /properties/:id/voice — права на деньги и сделки", () => {
  it("агент без прав: сумм рекламы нет ни в полях, ни в тексте диагноза; «суммы скрыты», а не «не шла»", async () => {
    const body = await voice("agentA");
    expect(body.ads.moneyHidden).toBe(true);
    expect(body.ads.spendTjs).toBeNull();
    expect(body.ads.spendOriginal).toBeNull();
    expect(body.ads.currency).toBeNull();
    // Реклама была (объявление привязано): число объявлений остаётся, чтобы экран не писал «не шла».
    expect(body.ads.adsCount).toBe(1);
    const text = JSON.stringify(body);
    expect(text).not.toMatch(/Расход/);
    expect(body.diagnosis.map((d: { code: string }) => d.code)).not.toContain("ADS_NO_RESPONSE");
    // Нет и закрытого раздела опросов после показа.
    expect("showingFeedback" in body).toBe(false);
    expect(text).not.toContain("секретная жалоба");
  });

  it("агент видит только свои сделки: цена чужой сделки и сама сделка в ответ не попадают", async () => {
    const body = await voice("agentA");
    expect(body.bargaining.dealsOwnOnly).toBe(true);
    expect(body.bargaining.deals).toHaveLength(1);
    expect(body.bargaining.deals[0]).toMatchObject({ stage: "PENDING_APPROVAL", soldPrice: OWN_SOLD_PRICE, listCurrency: "TJS" });
    expect(JSON.stringify(body)).not.toContain(String(SECRET_SOLD_PRICE));

    // Агент B видит только свою сделку (свою цену) — не сделку агента A.
    const other = await voice("agentB");
    expect(other.bargaining.deals).toHaveLength(1);
    expect(other.bargaining.deals[0]).toMatchObject({ stage: "COMPLETED", soldPrice: SECRET_SOLD_PRICE });
    expect(JSON.stringify(other)).not.toContain(String(OWN_SOLD_PRICE));
  });

  it("служба безопасности видит факт всех сделок, но цену чужой без finance.view — нет", async () => {
    const body = await voice("security");
    expect(body.bargaining.dealsOwnOnly).toBe(false);
    expect(body.bargaining.deals).toHaveLength(2);
    for (const d of body.bargaining.deals) {
      expect(d.soldPrice).toBeNull();
      expect(d.discountPct).toBeNull();
    }
    const text = JSON.stringify(body);
    expect(text).not.toContain(String(SECRET_SOLD_PRICE));
    expect(text).not.toContain(String(OWN_SOLD_PRICE));
    expect(body.ads.moneyHidden).toBe(true);
  });

  it("директор получает всё: суммы рекламы, цены всех сделок, опросы после показа", async () => {
    const body = await voice("director");
    expect(body.ads.moneyHidden).toBe(false);
    expect(body.ads.spendTjs).not.toBeNull();
    expect(body.bargaining.dealsOwnOnly).toBe(false);
    const prices = body.bargaining.deals.map((d: { soldPrice: number }) => d.soldPrice).sort();
    expect(prices).toEqual([SECRET_SOLD_PRICE, OWN_SOLD_PRICE].sort());
    expect(body.showingFeedback.calls).toBe(1);
    // Расход ≥ порога, обращений нет — диагноз со строкой «Расход» есть только у того, кто видит деньги.
    const adsDiag = body.diagnosis.find((d: { code: string }) => d.code === "ADS_NO_RESPONSE");
    expect(adsDiag).toBeDefined();
    expect(adsDiag.evidence.join(" ")).toMatch(/Расход/);
  });

  it("маркетолог видит деньги рекламы по роли, но не чужие сделки", async () => {
    const body = await voice("marketing");
    expect(body.ads.moneyHidden).toBe(false);
    expect(body.ads.spendTjs).toBeGreaterThan(0);
    expect(body.bargaining.dealsOwnOnly).toBe(true);
    expect(body.bargaining.deals).toHaveLength(0);
  });
});

describe("GET /properties/:id/voice — «гибкое» объявление на несколько объектов", () => {
  it("у каждого из четырёх объектов своя доля, сумма долей равна расходу объявления", async () => {
    const expected = allocateCents(
      AD_TOTAL_CENTS,
      propertyIds.map((propertyId, i) => ({ propertyId, weight: WEIGHTS[i] }))
    );
    let sumCents = 0;
    let sumImpressions = 0;
    let sumClicks = 0;
    for (let i = 0; i < propertyIds.length; i++) {
      const body = await voice("director", i);
      expect(body.ads.adsCount).toBe(1);
      const cents = Math.round(body.ads.spendTjs * 100);
      expect(cents).toBe(expected[i].cents);
      // Основной объект (вес 4) НЕ получает всё: остальным не «реклама не шла».
      expect(body.ads.spendTjs).toBeGreaterThan(0);
      expect(body.ads.spendTjs).toBeLessThan(1000);
      sumCents += cents;
      sumImpressions += body.ads.impressions;
      sumClicks += body.ads.clicks;
    }
    expect(sumCents).toBe(AD_TOTAL_CENTS);
    expect(sumImpressions).toBe(1001);
    expect(sumClicks).toBe(23);
  });

  it("агент без прав на деньги видит у каждого объекта, что реклама была, но не сколько", async () => {
    for (let i = 0; i < propertyIds.length; i++) {
      const body = await voice("agentA", i);
      expect(body.ads).toMatchObject({ adsCount: 1, moneyHidden: true, spendTjs: null, spendOriginal: null });
    }
  });
});
