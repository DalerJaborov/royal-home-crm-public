import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { actorFromAccess, FOREIGN_CLIENT_SCOPE_MESSAGE } from "../src/ai/assistant/actor.js";
import { findAssistantToolPlugin } from "../src/ai/assistant/tools/index.js";
import { budgetVsMarketText } from "../src/ai/assistant/tools/marketTools.js";
import { groupHiddenToolsForTests } from "../src/telegram/assistantBot.js";
import { prisma } from "../src/db.js";
import { deleteAgentsWithTraces } from "./helpers/cleanupAgents.js";
import { makeAgent, medianOf, seedMarketListings, segmentListingSpec } from "./helpers/marketFixtures.js";
import type { AssistantReadToolPlugin } from "../src/ai/assistant/tools/types.js";

/**
 * Инструменты Шабнам про рынок (14.11.2026): «рынок под запрос клиента» и «цена объекта против рынка».
 * Только чтение. Проверяем: регистрацию и закрытие первого в общей группе, доступ как у карточки клиента
 * (чужой клиент — отказ, продавец — not_buyer), честные «мало данных» без чисел, цену объекта по точному
 * номеру (адрес словами — отказ), и что телефона продавца и текста объявления в ответе нет.
 */

const runId = `${Date.now()}`.slice(-8);
const DISTRICT = `Тест-Шабнам-${runId}`;
const DISTRICT_FEW = `Тест-Шабнам-мало-${runId}`;
const SELLER_PHONE = "+992900000066";
const agentIds: string[] = [];
const clientIds: string[] = [];
const listingIds: string[] = [];
const propertyIds: string[] = [];
const districtIds: string[] = [];
let actor: ReturnType<typeof actorFromAccess>;
let otherActor: ReturnType<typeof actorFromAccess>;
const ids: Record<string, string> = {};
const propShort: Record<string, number> = {};

const tool = (name: string) => findAssistantToolPlugin(name) as AssistantReadToolPlugin;
const run = (name: string, args: Record<string, unknown>, who = actor) => tool(name).run(args, { actor: who }) as Promise<Record<string, unknown>>;

async function makeClient(key: string, over: Record<string, unknown> = {}) {
  const c = await prisma.client.create({
    data: {
      fullName: `Клиент ${key} ${runId}`, phone: `+99297${clientIds.length}${runId.slice(-7)}`, source: "PHONE_CALL", kind: "BUYER", assignedAgentId: agentIds[0],
      acceptedAt: new Date(), currency: "TJS", ...over,
    },
  });
  clientIds.push(c.id);
  ids[key] = c.id;
  return c;
}

async function makeProperty(key: string, over: Record<string, unknown> = {}) {
  const p = await prisma.property.create({
    data: {
      title: `Шабнам-${key}-${runId}`, type: "APARTMENT", areaSqm: 60, rooms: 2, price: 600_000, currency: "TJS", districtId: districtIds[0],
      address: "Тест", condition: "GOOD", assignedAgentId: agentIds[0], ownerContact: "+992900000092", status: "AVAILABLE", ...over,
    },
  });
  propertyIds.push(p.id);
  ids[key] = p.id;
  propShort[key] = p.shortId;
  return p;
}

const MEDIAN_PRICE = Math.round(medianOf(Array.from({ length: 10 }, (_, i) => segmentListingSpec(i).priceTjs)));

beforeAll(async () => {
  const [a, b] = [await makeAgent(runId, "4"), await makeAgent(runId, "5")];
  agentIds.push(a.id, b.id);
  actor = actorFromAccess(a.id, { role: "AGENT", permissions: new Set() });
  otherActor = actorFromAccess(b.id, { role: "AGENT", permissions: new Set() });
  for (const name of [DISTRICT, DISTRICT_FEW]) districtIds.push((await prisma.district.create({ data: { name } })).id);
  listingIds.push(...(await seedMarketListings(runId, DISTRICT, 2, 10, { sellerPhone: SELLER_PHONE, title: `Звоните ${SELLER_PHONE}` })));

  await makeClient("buyer", { desiredDistrictId: districtIds[0], desiredRooms: 2, budgetMax: MEDIAN_PRICE + 50_000 });
  await makeClient("seller", { kind: "SELLER" });
  await makeClient("empty", {});
  await makeClient("few", { desiredDistrictId: districtIds[1], desiredRooms: 2, budgetMax: 600_000 });

  await makeProperty("pricey", { price: Math.round(MEDIAN_PRICE * 1.6) });
  await makeProperty("fewData", { districtId: districtIds[1], price: 600_000 });
  await makeProperty("land", { type: "LAND", rooms: null });
});

afterAll(async () => {
  await prisma.property.deleteMany({ where: { id: { in: propertyIds } } });
  await prisma.marketListing.deleteMany({ where: { id: { in: listingIds } } });
  await prisma.interaction.deleteMany({ where: { clientId: { in: clientIds } } });
  await prisma.client.deleteMany({ where: { id: { in: clientIds } } });
  await deleteAgentsWithTraces(agentIds);
  await prisma.district.deleteMany({ where: { id: { in: districtIds } } });
});

describe("реестр и закрытие в группе", () => {
  it("оба инструмента зарегистрированы как чтение; рынок под клиента закрыт в общей группе, цена объекта нет", () => {
    for (const name of ["market_for_client", "market_property_price"]) {
      const t = tool(name);
      expect(t.level).toBe("A");
      expect(t.description.length).toBeGreaterThan(80);
    }
    expect(groupHiddenToolsForTests().has("market_for_client")).toBe(true);
    expect(groupHiddenToolsForTests().has("market_property_price")).toBe(false);
  });
});

describe("market_for_client", () => {
  it("отдаёт объявления и медиану района с бюджетом выше медианы; без телефонов и текста объявлений", async () => {
    const res = await run("market_for_client", { clientId: ids.buyer });
    expect(res.status).toBe("ok");
    const market = res.market as Record<string, unknown>;
    expect(market).toMatchObject({ status: "ok", district: DISTRICT, rooms: 2, listingsInSegment: 10, medianPriceTjs: MEDIAN_PRICE });
    expect(market.budgetVsMedianPercent).toBeGreaterThan(0);
    expect(String(market.budgetVsMedianText)).toContain("выше");
    expect((res.listings as unknown[]).length).toBeLessThanOrEqual(5);
    expect(String(res.note)).toContain("не цены сделок");
    const json = JSON.stringify(res);
    expect(json).not.toContain(SELLER_PHONE);
    expect(json).not.toContain("Звоните");
  });

  it("мало данных: чисел рынка нет, так и сказано", async () => {
    const res = await run("market_for_client", { clientId: ids.few });
    expect((res.market as Record<string, unknown>)).toMatchObject({ status: "insufficient", medianPriceTjs: null, budgetVsMedianPercent: null });
    expect(String((res.market as Record<string, unknown>).note)).toContain("меньше 8");
  });

  it("продавец — not_buyer; пустые пожелания — no_criteria; чужой клиент — отказ; неизвестный — не найден", async () => {
    expect((await run("market_for_client", { clientId: ids.seller })).status).toBe("not_buyer");
    expect((await run("market_for_client", { clientId: ids.empty })).status).toBe("no_criteria");
    expect((await run("market_for_client", { clientId: ids.buyer }, otherActor)).error).toBe(FOREIGN_CLIENT_SCOPE_MESSAGE);
    expect((await run("market_for_client", { clientId: "00000000-0000-4000-8000-000000000000" })).error).toBe("Клиент не найден");
    expect((await run("market_for_client", {})).error).toBe("Укажите клиента");
  });

  it("слова про бюджет: знак и модуль", () => {
    expect(budgetVsMarketText(12)).toBe("бюджет на 12% выше типичной цены объявлений");
    expect(budgetVsMarketText(-5)).toBe("бюджет на 5% ниже типичной цены объявлений");
    expect(budgetVsMarketText(0)).toContain("равен");
    expect(budgetVsMarketText(null)).toBeNull();
  });
});

describe("market_property_price", () => {
  it("объект выше рынка: вердикт, вилка, основание и похожие со ссылками, без телефонов", async () => {
    const res = await run("market_property_price", { propertyId: String(propShort.pricey) });
    expect(res.status).toBe("ok");
    expect(res.verdict).toBe("above");
    expect(res.verdictText).toBe("выше рынка");
    expect(res.diffPercent as number).toBeGreaterThan(10);
    expect(res.sampleSize as number).toBeGreaterThanOrEqual(8);
    expect(res.rangeLowTjs).not.toBeNull();
    expect((res.comparables as unknown[]).length).toBeLessThanOrEqual(3);
    expect(String(res.note)).toContain("не цены сделок");
    expect(JSON.stringify(res)).not.toContain(SELLER_PHONE);
  });

  it("то же через id объекта (источник — одна функция, что и у роута)", async () => {
    const res = await run("market_property_price", { propertyId: ids.pricey });
    expect(res.status).toBe("ok");
  });

  it("мало похожих: статус insufficient, ни вилки, ни ориентира", async () => {
    const res = await run("market_property_price", { propertyId: String(propShort.fewData) });
    expect(res.status).toBe("insufficient");
    expect(res).not.toHaveProperty("estimatedPriceTjs");
    expect(res).not.toHaveProperty("rangeLowTjs");
    expect(String(res.note)).toContain("цену рынка не называю");
  });

  it("участок не оценивается; адрес словами и неизвестный номер — «не найден», чужой «похожий» объект не подставляется", async () => {
    expect((await run("market_property_price", { propertyId: String(propShort.land) })).status).toBe("unsupported");
    expect(String((await run("market_property_price", { propertyId: `Шабнам-pricey-${runId}` })).error)).toContain("не найден");
    expect(String((await run("market_property_price", { propertyId: "99999999" })).error)).toContain("не найден");
  });
});
