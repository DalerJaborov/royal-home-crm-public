import { afterAll, beforeAll, describe, expect, it } from "vitest";
import request from "supertest";
import { isMarketRealtorListing, MARKET_REALTOR_MIN_LISTINGS } from "@royal-home/shared";
import { app } from "../src/app.js";
import { prisma } from "../src/db.js";
import { loadRealtorSellerKeys } from "../src/lib/market/ownerFilter.js";
import { deleteAgentsWithTraces } from "./helpers/cleanupAgents.js";
import { makeAgent } from "./helpers/marketFixtures.js";
import { catalogRaw } from "./helpers/somonPage.js";

/**
 * «Только собственники» в подборе покупателю (14.11.2026): объявление агентства (isAgency) и продавца с 3 и больше
 * активными объявлениями отсеиваются, продавец с 1-2 остаётся, рубильник выключен: показываются все. Строка над
 * списком честно говорит «N из M». Медиана рынка агентства по-прежнему учитывает.
 */

const runId = `${Date.now()}`.slice(-8);
const DISTRICT = `Тест-собственники-${runId}`;
const agentIds: string[] = [];
const clientIds: string[] = [];
const listingIds: string[] = [];
let districtId = "";
let buyerId = "";
let token = "";
let savedFlag: boolean | null = null;

async function listing(key: string, over: Record<string, unknown>) {
  const price = (over.priceTjs as number | undefined) ?? 500_000;
  const area = (over.areaSqm as number | undefined) ?? 60;
  const { priceTjs: _p, areaSqm: _a, ...rest } = over;
  void _p; void _a;
  const l = await prisma.marketListing.create({
    data: {
      source: "somon.tj", sourceId: `${runId}-${key}`, sourceUrl: `https://somon.tj/adv/${runId}-${key}`, dealType: "SALE", propertyType: "APARTMENT",
      city: "Душанбе", districtName: DISTRICT, rooms: 2, areaSqm: area, floor: 3, price, currency: "TJS", priceTjs: price,
      pricePerSqmTjs: Math.round(price / area), title: `Объявление ${key}`, isActive: true, lastSeenAt: new Date(), raw: catalogRaw({}), ...rest,
    },
  });
  listingIds.push(l.id);
  return l;
}

async function setOwnersOnly(on: boolean) {
  await prisma.settings.upsert({ where: { id: "singleton" }, update: { marketOwnersOnly: on }, create: { id: "singleton", marketOwnersOnly: on } });
}
const get = () => request(app).get(`/api/v1/clients/${buyerId}/market-listings`).set("Authorization", `Bearer ${token}`);
const urls = (body: { listings: { sourceUrl: string }[] }) => body.listings.map((l) => l.sourceUrl.split("/").pop());

beforeAll(async () => {
  savedFlag = (await prisma.settings.findUnique({ where: { id: "singleton" }, select: { marketOwnersOnly: true } }))?.marketOwnersOnly ?? null;
  const agent = await makeAgent(runId, "6");
  agentIds.push(agent.id);
  token = (await request(app).post("/api/v1/auth/login").send({ phone: agent.phone, password: "testpass123" })).body.accessToken;
  districtId = (await prisma.district.create({ data: { name: DISTRICT } })).id;
  const buyer = await prisma.client.create({
    data: {
      fullName: `Покупатель собственники ${runId}`, phone: `+992997${runId.slice(-7)}`, source: "PHONE_CALL", kind: "BUYER", assignedAgentId: agent.id,
      acceptedAt: new Date(), currency: "TJS", budgetMax: 600_000, desiredDistrictId: districtId, desiredRooms: 2,
    },
  });
  buyerId = buyer.id;
  clientIds.push(buyer.id);

  await listing("owner1", { sellerId: `own1-${runId}`, areaSqm: 55, priceTjs: 450_000, floor: 1 });
  // Продавец с двумя объявлениями: ещё собственник (порог 3).
  await listing("two-a", { sellerId: `two-${runId}`, areaSqm: 58, priceTjs: 470_000, floor: 2 });
  await listing("two-b", { sellerId: `two-${runId}`, areaSqm: 64, priceTjs: 520_000, floor: 4 });
  // Продавец с тремя активными объявлениями: риелтор (одно из них даже не подходит по цене, но считается).
  await listing("three-a", { sellerId: `three-${runId}`, areaSqm: 61, priceTjs: 480_000, floor: 5 });
  await listing("three-b", { sellerId: `three-${runId}`, areaSqm: 67, priceTjs: 540_000, floor: 6 });
  await listing("three-c", { sellerId: `three-${runId}`, areaSqm: 90, priceTjs: 2_000_000, floor: 7 });
  // Агентство по пометке площадки, хотя объявление у продавца одно.
  await listing("agency", { sellerId: `agency-${runId}`, isAgency: true, areaSqm: 70, priceTjs: 560_000, floor: 8 });
  // Без id продавца: по числу не проверить, остаётся.
  await listing("noseller", { areaSqm: 52, priceTjs: 440_000, floor: 9 });
});

afterAll(async () => {
  if (savedFlag === null) await prisma.settings.updateMany({ where: { id: "singleton" }, data: { marketOwnersOnly: true } });
  else await setOwnersOnly(savedFlag);
  await prisma.marketListing.deleteMany({ where: { id: { in: listingIds } } });
  await prisma.interaction.deleteMany({ where: { clientId: { in: clientIds } } });
  await prisma.client.deleteMany({ where: { id: { in: clientIds } } });
  await deleteAgentsWithTraces(agentIds);
  await prisma.district.deleteMany({ where: { id: districtId } });
});

describe("подбор «только собственники»", () => {
  it("включён: агентство и продавец с тремя объявлениями отсеяны, с одним и двумя остались; N из M честно", async () => {
    await setOwnersOnly(true);
    const res = await get();
    expect(res.status).toBe(200);
    const shown = urls(res.body).map((u) => String(u).replace(`${runId}-`, ""));
    expect(shown.sort()).toEqual(["noseller", "owner1", "two-a", "two-b"]);
    // Подходящих по запросу семь (риелтор даёт два, агентство одно; третье объявление риелтора не по цене), осталось четыре.
    expect(res.body.ownersOnly).toEqual({ enabled: true, kept: 4, total: 7 });
  });

  it("рубильник выключен: показываются все, ownersOnly.enabled = false", async () => {
    await setOwnersOnly(false);
    const res = await get();
    expect(urls(res.body)).toHaveLength(7);
    expect(res.body.ownersOnly).toMatchObject({ enabled: false, kept: 7, total: 7 });
  });

  it("колонка по умолчанию включена (новая и существующая строка Settings)", async () => {
    const col = await prisma.$queryRaw<{ column_default: string }[]>`SELECT column_default FROM information_schema.columns WHERE table_name = 'Settings' AND column_name = 'marketOwnersOnly'`;
    expect(col[0].column_default).toBe("true");
  });

  it("медиана рынка агентства учитывает: цифры строки рынка те же при любом положении рубильника", async () => {
    await setOwnersOnly(true);
    const on = (await get()).body.market;
    await setOwnersOnly(false);
    const off = (await get()).body.market;
    expect(on).toEqual(off);
  });
});

describe("правило риелтора (одна функция в shared) и ключи продавцов", () => {
  it("порог 3: ключ продавца с тремя активными объявлениями попал в набор, с двумя нет", async () => {
    expect(MARKET_REALTOR_MIN_LISTINGS).toBe(3);
    const keys = await loadRealtorSellerKeys();
    expect(keys.has(`somon.tj|three-${runId}`)).toBe(true);
    expect(keys.has(`somon.tj|two-${runId}`)).toBe(false);
    expect(keys.has(`somon.tj|own1-${runId}`)).toBe(false);
  });

  it("isMarketRealtorListing: пометка агентства или ключ продавца; без id продавца только пометка; другая площадка не смешивается", () => {
    const keys = new Set(["somon.tj|s1"]);
    expect(isMarketRealtorListing({ isAgency: true, source: "paydo.tj", sellerId: null }, keys)).toBe(true);
    expect(isMarketRealtorListing({ isAgency: false, source: "somon.tj", sellerId: "s1" }, keys)).toBe(true);
    expect(isMarketRealtorListing({ isAgency: false, source: "paydo.tj", sellerId: "s1" }, keys)).toBe(false);
    expect(isMarketRealtorListing({ isAgency: false, source: "somon.tj", sellerId: null }, keys)).toBe(false);
    expect(isMarketRealtorListing({ isAgency: false, source: "somon.tj", sellerId: "" }, keys)).toBe(false);
  });
});
