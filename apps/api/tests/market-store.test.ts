import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

// Курс меняем из теста: смена курса доллара не должна давать «снижений» цены.
const rate = vi.hoisted(() => ({ usdToTjs: 10 }));
vi.mock("../src/lib/money.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/lib/money.js")>()),
  loadMoneyContext: async () => ({ usdToTjs: rate.usdToTjs }),
}));

import { prisma } from "../src/db.js";
import { DISAPPEAR_AFTER_HOURS, markDisappeared, saveListings } from "../src/lib/market/marketStore.js";
import type { ParsedListing } from "../src/lib/market/somonParser.js";

const SOURCE = "test-market-store.example";

function listing(over: Partial<ParsedListing> = {}): ParsedListing {
  return {
    sourceId: "ms-1",
    sourceUrl: "https://example.test/adv/ms-1/",
    title: "2-комн. квартира, 50 м², 3/9 этаж",
    rooms: 2,
    areaSqm: 50,
    floor: 3,
    landmark: null,
    districtName: "Сино",
    city: "Душанбе",
    price: 100_000,
    currency: "USD",
    negotiable: false,
    sellerId: "s1",
    sellerName: "Продавец",
    isAgency: false,
    photoCount: 5,
    hasVideo: false,
    isPromoted: false,
    publishedText: "Сегодня",
    dealType: "SALE",
    propertyType: "APARTMENT",
    raw: { id: 1 } as never,
    ...over,
  };
}

const row = (sourceId = "ms-1") => prisma.marketListing.findUniqueOrThrow({ where: { source_sourceId: { source: SOURCE, sourceId } } });
const snapshots = async (sourceId = "ms-1") => prisma.marketPriceSnapshot.count({ where: { listing: { source: SOURCE, sourceId } } });

async function cleanup() {
  await prisma.marketListing.deleteMany({ where: { source: SOURCE } });
}

describe("saveListings: обновление не затирает сохранённое", () => {
  beforeEach(async () => {
    rate.usdToTjs = 10;
    await cleanup();
  });
  afterAll(cleanup);

  it("номер продавца, сохранённый кликом, переживает обновление без номера", async () => {
    await saveListings(SOURCE, [listing()]);
    await prisma.marketListing.update({ where: { source_sourceId: { source: SOURCE, sourceId: "ms-1" } }, data: { sellerPhone: "+992900000001" } });
    await saveListings(SOURCE, [listing({ title: "2-комн. квартира, 50 м², 3/9 этаж (срочно)" })]);
    const after = await row();
    expect(after.sellerPhone).toBe("+992900000001");
    expect(after.title).toContain("срочно");
    // а если разборщик номер дал — он обновляется
    await saveListings(SOURCE, [listing({ title: "новый заголовок", sellerPhone: "+992900000002" })]);
    expect((await row()).sellerPhone).toBe("+992900000002");
  });

  it("необязательные признаки (ремонт, тип дома, координаты, район) не затираются null; новые значения применяются", async () => {
    await saveListings(SOURCE, [listing({ repair: "RENOVATED", buildingType: "кирпичный", isNewBuilding: true, latitude: 38.55, longitude: 68.78 })]);
    // Somon этих признаков не отдаёт: приходит без них и без района
    await saveListings(SOURCE, [listing({ title: "изменён", districtName: null })]);
    const kept = await row();
    expect(kept).toMatchObject({ repair: "RENOVATED", buildingType: "кирпичный", isNewBuilding: true, districtName: "Сино", title: "изменён" });
    expect(Number(kept.latitude)).toBeCloseTo(38.55, 5);
    await saveListings(SOURCE, [listing({ repair: "WHITE" })]);
    expect((await row()).repair).toBe("WHITE");
  });

  it("создание записывает поля как есть", async () => {
    await saveListings(SOURCE, [listing({ repair: null, sellerPhone: null })]);
    expect(await row()).toMatchObject({ repair: null, sellerPhone: null });
  });
});

describe("saveListings: снимки цены", () => {
  beforeEach(async () => {
    rate.usdToTjs = 10;
    await cleanup();
  });

  it("смена курса доллара пересчитывает сомони, но снимок цены и «снижение» не пишет", async () => {
    await saveListings(SOURCE, [listing()]);
    expect(Number((await row()).priceTjs)).toBe(1_000_000);
    expect(await snapshots()).toBe(1);

    rate.usdToTjs = 9; // курс упал: в сомони цена «снизилась», у продавца — нет
    const stats = await saveListings(SOURCE, [listing()]);
    expect(stats.priceChanges).toBe(0);
    expect(await snapshots()).toBe(1);
    expect(Number((await row()).priceTjs)).toBe(900_000); // каталог при этом пересчитан
  });

  it("смена исходной цены или валюты пишет снимок", async () => {
    await saveListings(SOURCE, [listing()]);
    const lowered = await saveListings(SOURCE, [listing({ price: 95_000 })]);
    expect(lowered.priceChanges).toBe(1);
    expect(await snapshots()).toBe(2);
    const currency = await saveListings(SOURCE, [listing({ price: 950_000, currency: "TJS" })]);
    expect(currency.priceChanges).toBe(1);
    expect(await snapshots()).toBe(3);
  });
});

describe("saveListings: объявления без изменений", () => {
  beforeEach(async () => {
    rate.usdToTjs = 10;
    await cleanup();
  });

  it("повторная запись того же не переписывает строку, только отмечает «видели» и возвращает в активные", async () => {
    await saveListings(SOURCE, [listing(), listing({ sourceId: "ms-2", sourceUrl: "https://example.test/adv/ms-2/" })]);
    const old = new Date(Date.now() - 3 * 24 * 3600_000);
    await prisma.marketListing.updateMany({ where: { source: SOURCE }, data: { lastSeenAt: old } });
    const update = vi.spyOn(prisma.marketListing, "update");
    const updateMany = vi.spyOn(prisma.marketListing, "updateMany");

    const stats = await saveListings(SOURCE, [listing(), listing({ sourceId: "ms-2", sourceUrl: "https://example.test/adv/ms-2/" })]);
    expect(stats).toMatchObject({ created: 0, updated: 2, skipped: 0 });
    expect(update).not.toHaveBeenCalled(); // ни одной построчной записи
    expect(updateMany).toHaveBeenCalledTimes(1); // одним запросом на всю пачку
    expect((await row()).lastSeenAt.getTime()).toBeGreaterThan(old.getTime());
    vi.restoreAllMocks();

    await prisma.marketListing.update({ where: { source_sourceId: { source: SOURCE, sourceId: "ms-2" } }, data: { isActive: false, disappearedAt: new Date() } });
    await saveListings(SOURCE, [listing({ sourceId: "ms-2", sourceUrl: "https://example.test/adv/ms-2/" })]);
    expect(await row("ms-2")).toMatchObject({ isActive: true, disappearedAt: null });
  });

  it("а изменение любого значимого поля — полноценное обновление", async () => {
    await saveListings(SOURCE, [listing()]);
    const before = await row();
    await new Promise((resolve) => setTimeout(resolve, 15));
    await saveListings(SOURCE, [listing({ photoCount: 9 })]);
    const after = await row();
    expect(after.photoCount).toBe(9);
    expect(after.updatedAt.getTime()).toBeGreaterThan(before.updatedAt.getTime());
  });
});

describe("markDisappeared: порог в полтора интервала обхода", () => {
  beforeEach(cleanup);
  afterAll(cleanup);

  it("не видели 5 суток (один пропущенный недельный обход) — ещё активно; 12 суток (два) — снято", async () => {
    await saveListings(SOURCE, [listing(), listing({ sourceId: "ms-2", sourceUrl: "https://example.test/adv/ms-2/" })]);
    const ago = (days: number) => new Date(Date.now() - days * 24 * 3600_000);
    await prisma.marketListing.update({ where: { source_sourceId: { source: SOURCE, sourceId: "ms-1" } }, data: { lastSeenAt: ago(5) } });
    await prisma.marketListing.update({ where: { source_sourceId: { source: SOURCE, sourceId: "ms-2" } }, data: { lastSeenAt: ago(12) } });
    expect(DISAPPEAR_AFTER_HOURS).toBe(264);
    expect(await markDisappeared(SOURCE, DISAPPEAR_AFTER_HOURS)).toBe(1);
    expect((await row("ms-1")).isActive).toBe(true);
    expect(await row("ms-2")).toMatchObject({ isActive: false });
  });
});
