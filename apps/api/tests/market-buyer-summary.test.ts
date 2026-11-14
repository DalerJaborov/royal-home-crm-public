import { afterAll, beforeAll, describe, expect, it } from "vitest";
import request from "supertest";
import { app } from "../src/app.js";
import { prisma } from "../src/db.js";
import { buyerBudgetForComparison, findBuyerMarketSummary, percentVs } from "../src/lib/market/buyerMarket.js";
import { buildBuyerWants } from "../src/lib/market/buyerMatch.js";
import { buildMarketIndex, lookupMarketSegment, type SegmentRow } from "../src/lib/market/segments.js";
import { DEFAULT_MATCH_POLICY } from "../src/lib/matchPolicy.js";
import { deleteAgentsWithTraces } from "./helpers/cleanupAgents.js";
import { makeAgent, medianOf, seedMarketListings, segmentListingSpec } from "./helpers/marketFixtures.js";

/**
 * Строка рынка под запросом клиента (14.11.2026): GET /clients/:id/market-listings отдаёт поле `market` с
 * медианой по району и комнатам покупателя и сравнением бюджета с ней. Правила: порог 8 (ниже чисел нет),
 * бюджет в процентах округляется по модулю, дом/без района и комнат — без чисел.
 */

const runId = `${Date.now()}`.slice(-8);
const DISTRICT_OK = `Тест-строка-${runId}`;
const DISTRICT_FEW = `Тест-мало-${runId}`;
const agentIds: string[] = [];
const clientIds: string[] = [];
const listingIds: string[] = [];
const districtIds: string[] = [];
let token: string;

const SAMPLE = 10;
const prices = Array.from({ length: SAMPLE }, (_, i) => segmentListingSpec(i).priceTjs);
const perSqm = Array.from({ length: SAMPLE }, (_, i) => segmentListingSpec(i).pricePerSqm);
const MEDIAN_PRICE = Math.round(medianOf(prices));
const MEDIAN_PER_SQM = Math.round(medianOf(perSqm));

async function makeBuyer(over: Record<string, unknown>, tag: string): Promise<string> {
  const c = await prisma.client.create({
    data: {
      fullName: `Покупатель ${tag} ${runId}`,
      phone: `+99299${tag}${runId.slice(-7)}`,
      source: "PHONE_CALL",
      kind: "BUYER",
      assignedAgentId: agentIds[0],
      acceptedAt: new Date(),
      currency: "TJS",
      ...over,
    },
  });
  clientIds.push(c.id);
  return c.id;
}

const get = (id: string) => request(app).get(`/api/v1/clients/${id}/market-listings`).set("Authorization", `Bearer ${token}`);

beforeAll(async () => {
  const agent = await makeAgent(runId, "1");
  agentIds.push(agent.id);
  token = (await request(app).post("/api/v1/auth/login").send({ phone: agent.phone, password: "testpass123" })).body.accessToken;
  for (const name of [DISTRICT_OK, DISTRICT_FEW]) districtIds.push((await prisma.district.create({ data: { name } })).id);
  listingIds.push(...(await seedMarketListings(runId, DISTRICT_OK, 2, SAMPLE)));
  // Три объявления на сегмент: ниже порога 8.
  listingIds.push(...(await seedMarketListings(runId, DISTRICT_FEW, 2, 3)));
});

afterAll(async () => {
  await prisma.marketListing.deleteMany({ where: { id: { in: listingIds } } });
  await prisma.interaction.deleteMany({ where: { clientId: { in: clientIds } } });
  await prisma.client.deleteMany({ where: { id: { in: clientIds } } });
  await deleteAgentsWithTraces(agentIds);
  await prisma.district.deleteMany({ where: { id: { in: districtIds } } });
});

describe("строка рынка в GET /clients/:id/market-listings", () => {
  it("даёт медиану за м² и за квартиру по району и комнатам и бюджет выше медианы в процентах", async () => {
    const budget = MEDIAN_PRICE + 100_000;
    const id = await makeBuyer({ desiredDistrictId: districtIds[0], desiredRooms: 2, budgetMax: budget }, "1");
    const res = await get(id);
    expect(res.status).toBe(200);
    expect(res.body.market).toMatchObject({
      status: "ok", districtName: DISTRICT_OK, rooms: 2, count: SAMPLE, minSample: 8,
      medianPriceTjs: MEDIAN_PRICE, medianPerSqmTjs: MEDIAN_PER_SQM, budgetTjs: budget,
      budgetVsMedianPercent: Math.round(((budget - MEDIAN_PRICE) * 100) / MEDIAN_PRICE),
    });
    expect(res.body.market.budgetVsMedianPercent).toBeGreaterThan(0);
  });

  it("бюджет ниже медианы — отрицательный процент; вилка бюджета сравнивается серединой", async () => {
    const id = await makeBuyer({ desiredDistrictId: districtIds[0], desiredRooms: 2, budgetMin: 300_000, budgetMax: 400_000 }, "2");
    const res = await get(id);
    expect(res.body.market.budgetTjs).toBe(350_000);
    expect(res.body.market.budgetVsMedianPercent).toBe(Math.round(((350_000 - MEDIAN_PRICE) * 100) / MEDIAN_PRICE));
    expect(res.body.market.budgetVsMedianPercent).toBeLessThan(0);
  });

  it("мало объявлений (меньше порога): статус insufficient, чисел нет вовсе", async () => {
    const id = await makeBuyer({ desiredDistrictId: districtIds[1], desiredRooms: 2, budgetMax: 600_000 }, "3");
    const res = await get(id);
    expect(res.body.market).toMatchObject({
      status: "insufficient", count: 3, medianPriceTjs: null, medianPerSqmTjs: null, budgetVsMedianPercent: null,
    });
  });

  it("без числа комнат или с желанием «дом» сравнивать не с чем: no_segment, без чисел", async () => {
    const noRooms = await makeBuyer({ desiredDistrictId: districtIds[0], budgetMax: 600_000 }, "4");
    expect((await get(noRooms)).body.market).toMatchObject({ status: "no_segment", medianPriceTjs: null, budgetVsMedianPercent: null });
    const house = await makeBuyer({ desiredDistrictId: districtIds[0], desiredRooms: 2, desiredType: "HOUSE", budgetMax: 600_000 }, "5");
    expect((await get(house)).body.market.status).toBe("no_segment");
  });

  it("без пожеланий (no_criteria) строки рынка нет: market = null", async () => {
    const id = await makeBuyer({}, "6");
    const res = await get(id);
    expect(res.body.status).toBe("no_criteria");
    expect(res.body.market).toBeNull();
  });
});

describe("чистые части строки рынка", () => {
  it("процент округляется по модулю: граница симметрична", () => {
    expect(percentVs(110, 100)).toBe(10);
    expect(percentVs(90, 100)).toBe(-10);
    expect(percentVs(100, 100)).toBe(0);
    expect(percentVs(110.5, 100)).toBe(11);
    expect(percentVs(89.5, 100)).toBe(-11);
  });

  it("бюджет для сравнения: середина вилки, иначе единственная граница, иначе null", () => {
    expect(buyerBudgetForComparison({ budgetMinTjs: 300_000, budgetMaxTjs: 500_000 })).toBe(400_000);
    expect(buyerBudgetForComparison({ budgetMinTjs: null, budgetMaxTjs: 500_000 })).toBe(500_000);
    expect(buyerBudgetForComparison({ budgetMinTjs: 300_000, budgetMaxTjs: null })).toBe(300_000);
    expect(buyerBudgetForComparison({ budgetMinTjs: null, budgetMaxTjs: null })).toBeNull();
  });

  it("findBuyerMarketSummary по желанию в районе без данных: insufficient с нулём объявлений", async () => {
    const wants = buildBuyerWants(
      { currency: "TJS", budgetMin: null, budgetMax: 500_000, desiredDistrictId: null, desiredRooms: 2 },
      { name: `Нет-такого-${runId}`, city: "Душанбе" },
      { usdToTjs: 11 } as never,
      DEFAULT_MATCH_POLICY
    );
    expect(await findBuyerMarketSummary(wants)).toMatchObject({ status: "insufficient", count: 0, medianPriceTjs: null });
  });

  it("индекс рынка: сначала сегмент с ремонтом (если в нём достаточно), иначе «все ремонты»; мало — null", () => {
    const row = (i: number, repair: string | null): SegmentRow => {
      const s = segmentListingSpec(i);
      return {
        source: "somon.tj", districtName: "Сино", rooms: 2, repair, areaSqm: s.areaSqm, priceTjs: s.priceTjs, pricePerSqmTjs: s.pricePerSqm,
        floor: s.floor, firstSeenAt: new Date(), lastSeenAt: new Date(), sellerId: null,
      };
    };
    const rows = [...Array.from({ length: 10 }, (_, i) => row(i, "RENOVATED")), ...Array.from({ length: 3 }, (_, i) => row(i + 10, "SHELL"))];
    const index = buildMarketIndex(rows);
    expect(lookupMarketSegment(index, "Сино", 2, "RENOVATED")?.byRepair).toBe(true);
    // «Коробка»: 3 объявления, ниже порога, значит берём «все ремонты» (13 объявлений).
    const shell = lookupMarketSegment(index, "Сино", 2, "SHELL");
    expect(shell?.byRepair).toBe(false);
    expect(shell?.stat.count).toBe(13);
    expect(lookupMarketSegment(index, "Сино", 3, null)).toBeNull();
    expect(lookupMarketSegment(buildMarketIndex(rows.slice(0, 3)), "Сино", 2, null)).toBeNull();
  });
});
