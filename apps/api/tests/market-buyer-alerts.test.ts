import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { prisma } from "../src/db.js";
import {
  BUYER_ALERT_MAX_PUSHES_PER_DAY, BUYER_ALERT_PER_PUSH, buyerAlertText, planBuyerAlerts, runBuyerMarketAlerts,
  type AlertBuyer, type AlertListing,
} from "../src/lib/market/buyerAlerts.js";
import { DEFAULT_MATCH_POLICY } from "../src/lib/matchPolicy.js";
import { catalogRaw } from "./helpers/somonPage.js";
import { deleteAgentsWithTraces } from "./helpers/cleanupAgents.js";
import { makeAgent } from "./helpers/marketFixtures.js";

const { sendPushToAgent } = vi.hoisted(() => ({ sendPushToAgent: vi.fn(async () => 1) }));
vi.mock("../src/push.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/push.js")>()),
  sendPushToAgent,
}));

/**
 * Оповещение агента о новом объявлении под его покупателя (14.11.2026, lib/market/buyerAlerts.ts).
 * Что держим: рубильник выключен — тишина и ни одной записи; один пуш на пару клиент+объявление, повторный
 * прогон молчит; чужой район и дорогое не шлём; двойник на второй площадке и объявление, которое мы
 * уже отправляли, повторного пуша не дают; не больше 3 пушей на клиента за сутки; упавший пуш снимает
 * записи (уйдёт со следующим прогоном); в тексте пуша нет телефона продавца и текста объявления.
 */

const runId = `${Date.now()}`.slice(-8);
const DISTRICT = `Тест-новое-${runId}`;
const OTHER_DISTRICT = `Тест-другое-${runId}`;
const agentIds: string[] = [];
const clientIds: string[] = [];
const listingIds: string[] = [];
const districtIds: string[] = [];
let buyerId: string;
let buyerShortId: number;
let agentId: string;

/** Включённый рубильник с отметкой включения два часа назад: «новое» считается от неё (первый прогон иначе лишь ставит отметку). */
async function setFlag(on: boolean, enabledAt: Date | null = on ? new Date(Date.now() - 2 * 3600_000) : null) {
  const data = { marketBuyerAlertsEnabled: on, marketBuyerAlertsEnabledAt: enabledAt };
  await prisma.settings.upsert({ where: { id: "singleton" }, update: data, create: { id: "singleton", ...data } });
}

async function listing(key: string, over: Record<string, unknown> = {}) {
  const priceTjs = (over.priceTjs as number | undefined) ?? 500_000;
  const areaSqm = (over.areaSqm as number | undefined) ?? 60;
  const { priceTjs: _p, areaSqm: _a, ...rest } = over;
  void _p; void _a;
  const l = await prisma.marketListing.create({
    data: {
      source: "somon.tj", sourceId: `${runId}-${key}`, sourceUrl: `https://somon.tj/adv/${runId}-${key}`, dealType: "SALE",
      propertyType: "APARTMENT", city: "Душанбе", districtName: DISTRICT, rooms: 2, areaSqm, floor: 4, price: priceTjs, currency: "TJS", priceTjs,
      pricePerSqmTjs: Math.round(priceTjs / areaSqm), title: `Телефон +992900000077 ${key}`, isActive: true, lastSeenAt: new Date(),
      raw: catalogRaw(rest), sellerPhone: "+992900000077", ...rest,
    },
  });
  listingIds.push(l.id);
  return l;
}

const alertsOf = () => prisma.buyerMarketAlert.findMany({ where: { clientId: buyerId } });
const pushesForBuyer = () => sendPushToAgent.mock.calls.filter(([id]) => id === agentId);

beforeAll(async () => {
  const agent = await makeAgent(runId, "3");
  agentId = agent.id;
  agentIds.push(agent.id);
  for (const name of [DISTRICT, OTHER_DISTRICT]) districtIds.push((await prisma.district.create({ data: { name } })).id);
  const buyer = await prisma.client.create({
    data: {
      fullName: `Покупатель новое ${runId}`, phone: `+992995${runId.slice(-7)}`, source: "PHONE_CALL", kind: "BUYER", assignedAgentId: agent.id,
      acceptedAt: new Date(), lastContactAt: new Date(), currency: "TJS", budgetMax: 600_000, desiredDistrictId: districtIds[0], desiredRooms: 2,
    },
  });
  buyerId = buyer.id;
  buyerShortId = buyer.shortId;
  clientIds.push(buyer.id);
});

beforeEach(async () => {
  sendPushToAgent.mockReset();
  sendPushToAgent.mockImplementation(async () => 1);
  await prisma.buyerMarketAlert.deleteMany({ where: { clientId: buyerId } });
  await prisma.marketListing.deleteMany({ where: { id: { in: listingIds } } });
  listingIds.length = 0;
});

afterAll(async () => {
  await setFlag(false);
  await prisma.marketListing.deleteMany({ where: { id: { in: listingIds } } });
  await prisma.buyerMarketAlert.deleteMany({ where: { clientId: { in: clientIds } } });
  await prisma.interaction.deleteMany({ where: { clientId: { in: clientIds } } });
  await prisma.client.deleteMany({ where: { id: { in: clientIds } } });
  await deleteAgentsWithTraces(agentIds);
  await prisma.district.deleteMany({ where: { id: { in: districtIds } } });
});

describe("runBuyerMarketAlerts", () => {
  it("рубильник выключен (по умолчанию): ни пуша, ни записи", async () => {
    await setFlag(false);
    await listing("a");
    const stats = await runBuyerMarketAlerts();
    expect(stats.enabled).toBe(false);
    expect(pushesForBuyer()).toHaveLength(0);
    expect(await alertsOf()).toHaveLength(0);
  });

  it("новое подходящее объявление: один пуш агенту покупателя, ссылка на карточку, без телефона продавца", async () => {
    await setFlag(true);
    await listing("a");
    const stats = await runBuyerMarketAlerts();
    expect(stats.enabled).toBe(true);
    const calls = pushesForBuyer();
    expect(calls).toHaveLength(1);
    const payload = calls[0][1] as { title: string; body: string; url: string; kind: string };
    expect(payload.url).toBe(`/clients/${buyerShortId}`);
    expect(payload.kind).toBe("market_buyer");
    expect(payload.body).toContain("Somon");
    expect(payload.body).toContain("2 к");
    expect(payload.body).not.toContain("992900000077");
    expect(payload.body).not.toContain("Телефон");
    expect(await alertsOf()).toHaveLength(1);
  });

  it("повторный прогон по тем же объявлениям молчит: пара уходит один раз", async () => {
    await setFlag(true);
    await listing("a");
    await runBuyerMarketAlerts();
    sendPushToAgent.mockClear();
    await runBuyerMarketAlerts();
    expect(pushesForBuyer()).toHaveLength(0);
    expect(await alertsOf()).toHaveLength(1);
  });

  it("чужой район, не по бюджету, чужое число комнат (допуск ±1) и старое объявление не шлются", async () => {
    await setFlag(true);
    await listing("otherDistrict", { districtName: OTHER_DISTRICT });
    await listing("tooExpensive", { priceTjs: 900_000 });
    await listing("fiveRooms", { rooms: 5, areaSqm: 130, priceTjs: 520_000 });
    await listing("oldOnSite", { publishedAt: new Date(Date.now() - 30 * 24 * 3600_000) });
    await listing("notNew", { firstSeenAt: new Date(Date.now() - 3 * 24 * 3600_000) });
    await listing("inactive", { isActive: false });
    await runBuyerMarketAlerts();
    expect(pushesForBuyer()).toHaveLength(0);
  });

  it("двойник на второй площадке уже отправленного объявления повторного пуша не даёт", async () => {
    await setFlag(true);
    await listing("a");
    await runBuyerMarketAlerts();
    sendPushToAgent.mockClear();
    // Тот же объект на Paydo: площадь ±1 м², цена ±3%, тот же этаж.
    await listing("dup", { source: "paydo.tj", areaSqm: 61, priceTjs: 510_000 });
    await runBuyerMarketAlerts();
    expect(pushesForBuyer()).toHaveLength(0);
  });

  it("в одном пуше не больше трёх объявлений, остальные не теряются, а ждут следующего прогона", async () => {
    await setFlag(true);
    for (let i = 0; i < 5; i++) await listing(`m${i}`, { areaSqm: 50 + i * 5, priceTjs: 400_000 + i * 30_000, floor: 1 + i });
    await runBuyerMarketAlerts();
    expect(pushesForBuyer()).toHaveLength(1);
    expect(await alertsOf()).toHaveLength(BUYER_ALERT_PER_PUSH);
    await runBuyerMarketAlerts();
    expect(pushesForBuyer()).toHaveLength(2);
    expect(await alertsOf()).toHaveLength(5);
  });

  it("не больше трёх пушей на АГЕНТА за сутки по Душанбе, даже если пуши ушли по другим его клиентам", async () => {
    await setFlag(true);
    const old = await listing("old", { areaSqm: 40, priceTjs: 410_000, floor: 8 });
    const todayStart = new Date(Date.now() - 60_000);
    // Три пуша уже ушли «сегодня» (разное время): предел исчерпан.
    for (let i = 0; i < BUYER_ALERT_MAX_PUSHES_PER_DAY; i++) {
      const l = await listing(`done${i}`, { areaSqm: 80 + i * 7, priceTjs: 560_000 + i * 20_000, floor: 2 + i });
      await prisma.buyerMarketAlert.create({ data: { clientId: buyerId, listingId: l.id, agentId, notifiedAt: new Date(todayStart.getTime() + i * 1000) } });
    }
    void old;
    await runBuyerMarketAlerts();
    expect(pushesForBuyer()).toHaveLength(0);
  });

  it("предел считается по агенту: три пуша по ДРУГОМУ клиенту этого агента закрывают суточный предел и этому покупателю", async () => {
    await setFlag(true);
    const other = await prisma.client.create({
      data: { fullName: `Другой покупатель ${runId}`, phone: `+992996${runId.slice(-7)}`, source: "PHONE_CALL", kind: "BUYER", assignedAgentId: agentId, acceptedAt: new Date() },
    });
    clientIds.push(other.id);
    await listing("fresh", { areaSqm: 45, priceTjs: 430_000, floor: 7 });
    const t0 = Date.now() - 60_000;
    for (let i = 0; i < BUYER_ALERT_MAX_PUSHES_PER_DAY; i++) {
      const l = await listing(`otherDone${i}`, { areaSqm: 90 + i * 9, priceTjs: 700_000 + i * 50_000, floor: 2 + i });
      await prisma.buyerMarketAlert.create({ data: { clientId: other.id, listingId: l.id, agentId, notifiedAt: new Date(t0 + i * 1000) } });
    }
    await runBuyerMarketAlerts();
    expect(pushesForBuyer()).toHaveLength(0);
    await prisma.buyerMarketAlert.deleteMany({ where: { clientId: other.id } });
  });

  it("граница суток по Душанбе: пуши до 19:00 UTC (полночь Душанбе) уже вчерашние и предела не занимают", async () => {
    await setFlag(true, new Date("2026-11-14T10:00:00.000Z"));
    // «Сейчас» 15.11 00:30 по Душанбе (19:30 UTC 14.11); три пуша в 23:00 по Душанбе (18:00 UTC) были ВЧЕРА.
    const now = new Date("2026-11-14T19:30:00.000Z");
    await listing("fresh", { firstSeenAt: new Date(now.getTime() - 10 * 60_000), lastSeenAt: now });
    const yesterday = new Date("2026-11-14T18:00:00.000Z");
    for (let i = 0; i < BUYER_ALERT_MAX_PUSHES_PER_DAY; i++) {
      const l = await listing(`y${i}`, { areaSqm: 90 + i * 9, priceTjs: 700_000 + i * 50_000, floor: 2 + i, firstSeenAt: new Date(now.getTime() - 3600_000) });
      await prisma.buyerMarketAlert.create({ data: { clientId: buyerId, listingId: l.id, agentId, notifiedAt: new Date(yesterday.getTime() + i * 1000) } });
    }
    await runBuyerMarketAlerts(now);
    expect(pushesForBuyer()).toHaveLength(1);
    // Запись пуша несёт момент «сейчас» из параметра, а не часы машины.
    const written = await prisma.buyerMarketAlert.findMany({ where: { clientId: buyerId, notifiedAt: now } });
    expect(written.length).toBeGreaterThan(0);
  });

  it("при первом включении всплеска нет: прогон лишь ставит отметку, объявления до неё не уходят, после неё уходят", async () => {
    await setFlag(true, null);
    await listing("before", { firstSeenAt: new Date(Date.now() - 3 * 3600_000) });
    const first = await runBuyerMarketAlerts();
    expect(first.enabled).toBe(true);
    expect(pushesForBuyer()).toHaveLength(0);
    const marker = (await prisma.settings.findUniqueOrThrow({ where: { id: "singleton" } })).marketBuyerAlertsEnabledAt;
    expect(marker).not.toBeNull();
    // Объявление, увиденное до отметки, не новое; увиденное после неё, новое.
    await runBuyerMarketAlerts();
    expect(pushesForBuyer()).toHaveLength(0);
    await listing("after", { areaSqm: 66, priceTjs: 520_000, floor: 6, firstSeenAt: new Date(Date.now() + 1000) });
    await runBuyerMarketAlerts(new Date(Date.now() + 5000));
    expect(pushesForBuyer()).toHaveLength(1);
  });

  it("выключили рубильник: отметка включения сбрасывается, следующее включение снова не шлёт прошлое", async () => {
    await setFlag(true);
    await setFlag(false, new Date());
    await runBuyerMarketAlerts();
    expect((await prisma.settings.findUniqueOrThrow({ where: { id: "singleton" } })).marketBuyerAlertsEnabledAt).toBeNull();
  });

  it("покупатель только с бюджетом, без района, пушей не получает", async () => {
    await setFlag(true);
    await prisma.client.update({ where: { id: buyerId }, data: { desiredDistrictId: null } });
    await listing("a");
    await runBuyerMarketAlerts();
    expect(pushesForBuyer()).toHaveLength(0);
    await prisma.client.update({ where: { id: buyerId }, data: { desiredDistrictId: districtIds[0] } });
  });

  it("пуш уходит отдельным видом market_buyer, а не общим market (его можно выключить отдельно от «объект на площадках»)", async () => {
    await setFlag(true);
    await listing("a");
    await runBuyerMarketAlerts();
    expect((pushesForBuyer()[0][1] as { kind: string }).kind).toBe("market_buyer");
  });

  it("упавший пуш снимает записи: объявление уйдёт со следующим прогоном", async () => {
    await setFlag(true);
    await listing("a");
    sendPushToAgent.mockImplementationOnce(async () => {
      throw new Error("push down");
    });
    const failed = await runBuyerMarketAlerts();
    expect(failed.failed).toBe(1);
    expect(await alertsOf()).toHaveLength(0);
    await runBuyerMarketAlerts();
    expect(pushesForBuyer()).toHaveLength(2);
    expect(await alertsOf()).toHaveLength(1);
  });

  it("покупатель без принятия агентом или без района и бюджета не получает пушей", async () => {
    await setFlag(true);
    await listing("a");
    await prisma.client.update({ where: { id: buyerId }, data: { acceptedAt: null } });
    await runBuyerMarketAlerts();
    expect(pushesForBuyer()).toHaveLength(0);
    await prisma.client.update({ where: { id: buyerId }, data: { acceptedAt: new Date() } });
  });
});

describe("planBuyerAlerts и текст (чистая часть)", () => {
  const wants = (over = {}) => ({
    districtName: "Сино", city: "Душанбе", rooms: 2, propertyType: null, areaMin: null, budgetMinTjs: null, budgetMaxTjs: 600_000,
    policy: DEFAULT_MATCH_POLICY, ...over,
  });
  const buyer = (id: string): AlertBuyer => ({ clientId: id, shortId: 7, kind: "BUYER", agentId: "ag", wants: wants() });
  const lst = (id: string, over: Partial<AlertListing> = {}): AlertListing => ({
    id, source: "somon.tj", sourceUrl: `u${id}`, title: "t", priceTjs: 500_000, pricePerSqmTjs: 8_300, areaSqm: 60, rooms: 2, floor: 4, totalFloors: 9,
    districtName: "Сино", firstSeenAt: new Date(), publishedAt: null, city: "Душанбе", repair: null, ...over,
  });
  const base = { alreadyAlerted: new Set<string>(), previousByClient: new Map(), pushesTodayByAgent: new Map<string, number>() };

  it("район и допуски — через одну дверь подбора; уже отправленная пара и исчерпанный предел исключаются", () => {
    const listings = [lst("1"), lst("2", { districtName: "Другой", floor: 5, areaSqm: 70 }), lst("3", { priceTjs: 900_000, pricePerSqmTjs: 12_000, floor: 6 })];
    const plan = planBuyerAlerts({ ...base, buyers: [buyer("c1")], listings });
    expect(plan).toHaveLength(1);
    expect(plan[0].listings.map((l) => l.id)).toEqual(["1"]);
    expect(planBuyerAlerts({ ...base, buyers: [buyer("c1")], listings, alreadyAlerted: new Set(["c1|1"]) })).toHaveLength(0);
    expect(planBuyerAlerts({ ...base, buyers: [buyer("c1")], listings, pushesTodayByAgent: new Map([["ag", BUYER_ALERT_MAX_PUSHES_PER_DAY]]) })).toHaveLength(0);
  });

  it("два покупателя одного агента в одном прогоне вместе не дают больше предела; без района покупатель исключён", () => {
    const listings = [lst("1"), lst("2", { floor: 5, areaSqm: 70, priceTjs: 530_000 })];
    const buyers = ["c1", "c2", "c3", "c4"].map((id) => buyer(id));
    const plan = planBuyerAlerts({ ...base, buyers, listings });
    expect(plan).toHaveLength(BUYER_ALERT_MAX_PUSHES_PER_DAY);
    const noDistrict: AlertBuyer = { ...buyer("c9"), wants: wants({ districtName: null }) };
    expect(planBuyerAlerts({ ...base, buyers: [noDistrict], listings })).toHaveLength(0);
  });

  it("текст: код клиента, площадка, цена, район; несколько объявлений — «Ещё подходящих»; без «—»", () => {
    const one = buyerAlertText({ shortId: 7, kind: "BUYER" }, [lst("1")]);
    expect(one.body).toContain("Somon");
    expect(one.body).toContain("500 000 сомони");
    expect(one.body).toContain("Сино");
    expect(one.title + one.body).not.toContain("—");
    const many = buyerAlertText({ shortId: 7, kind: "BUYER" }, [lst("1"), lst("2")]);
    expect(many.body).toContain("Ещё подходящих: 1.");
    expect(many.title).toContain("Новые объявления");
  });
});
