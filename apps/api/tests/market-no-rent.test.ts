import { afterAll, describe, expect, it } from "vitest";
import { prisma } from "../src/db.js";
import { catalogRaw } from "./helpers/somonPage.js";
import { saveListings } from "../src/lib/market/marketStore.js";
import { isReadableCatalogRow, marketCatalogWhere, SOMON_REAL_ESTATE_RUBRICS } from "../src/lib/market/somonRubrics.js";
import { countRent, deleteRent, exportRent } from "../src/lib/market/purgeMarketRent.js";
import { findSegments } from "../src/lib/market/segments.js";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { existsSync, readFileSync, rmSync } from "node:fs";

/**
 * Аренды в каталоге нет (владелец 14.11.2026): ни сборщик её не пишет, ни один запрос не читает;
 * строки, оставшиеся в базе, удаляет разовый скрипт purgeMarketRent (просмотр, выгрузка, пачки).
 */

const runId = `${Date.now()}`.slice(-8);
const DISTRICT = `Тест-аренда-${runId}`;

async function make(key: string, source: string, dealType: string, over: Record<string, unknown> = {}) {
  return prisma.marketListing.create({
    data: {
      source, sourceId: `${runId}-${key}`, sourceUrl: `https://${source}/adv/${runId}-${key}`, dealType, propertyType: "APARTMENT",
      city: "Душанбе", districtName: DISTRICT, rooms: 2, areaSqm: 60, price: 600_000, currency: "TJS", priceTjs: 600_000,
      pricePerSqmTjs: 10_000, title: `Тест ${key}`, isActive: true, lastSeenAt: new Date(),
      raw: source === "somon.tj" ? catalogRaw({ dealType: "SALE" }) : {},
      ...over,
    },
  });
}

afterAll(async () => {
  await prisma.marketListing.deleteMany({ where: { sourceId: { startsWith: `${runId}-` } } });
});

describe("аренды в каталоге нет", () => {
  it("в списке рубрик нет ни одной аренды", () => {
    expect(SOMON_REAL_ESTATE_RUBRICS.every((r) => r.dealType === "SALE")).toBe(true);
  });

  it("строка RENT не читается ни у Somon, ни у Paydo (даже с «правильным» сырьём)", () => {
    expect(isReadableCatalogRow({ source: "paydo.tj", raw: {}, dealType: "RENT", propertyType: "APARTMENT" })).toBe(false);
    expect(isReadableCatalogRow({ source: "somon.tj", raw: { rubric: { id: 2831 } }, dealType: "RENT", propertyType: "APARTMENT" })).toBe(false);
    expect(isReadableCatalogRow({ source: "paydo.tj", raw: {}, dealType: "SALE", propertyType: "APARTMENT" })).toBe(true);
  });

  it("запрос с marketCatalogWhere не отдаёт аренду; сегменты её не считают", async () => {
    await make("sale-somon", "somon.tj", "SALE");
    await make("rent-somon", "somon.tj", "RENT");
    // Площадь и цена другие, чем у Somon: иначе дубль между площадками склеится в одно объявление.
    await make("sale-paydo", "paydo.tj", "SALE", { areaSqm: 95, price: 1_200_000, priceTjs: 1_200_000, pricePerSqmTjs: 12_631, floor: 7 });
    await make("rent-paydo", "paydo.tj", "RENT");
    const rows = await prisma.marketListing.findMany({
      where: { sourceId: { startsWith: `${runId}-` }, AND: [marketCatalogWhere()] },
      select: { sourceId: true },
    });
    expect(rows.map((r) => r.sourceId.slice(runId.length + 1)).sort()).toEqual(["sale-paydo", "sale-somon"]);
    const seg = await findSegments({ city: "Душанбе", districtName: DISTRICT });
    expect(seg.segments.reduce((s, x) => s + x.count, 0)).toBe(2);
  });

  it("сборщик не пишет аренду: последняя дверь saveListings отбрасывает всё, что не продажа", async () => {
    const base = {
      sourceUrl: "https://paydo.tj/x", propertyType: "APARTMENT", city: "Душанбе", districtName: DISTRICT, landmark: null, rooms: 2, areaSqm: 50,
      floor: 2, totalFloors: 5, price: 500_000, currency: "TJS", negotiable: false, sellerId: null, sellerName: null, isAgency: false,
      title: "t", photoCount: 0, hasVideo: false, isPromoted: false, publishedText: null, raw: {},
    };
    const stats = await saveListings("paydo.tj", [
      { ...base, sourceId: `${runId}-w-sale`, dealType: "SALE" },
      { ...base, sourceId: `${runId}-w-rent`, dealType: "RENT" },
    ] as never);
    expect(stats.created).toBe(1);
    expect(stats.skipped).toBe(1);
    expect(await prisma.marketListing.count({ where: { sourceId: `${runId}-w-rent` } })).toBe(0);
  });

  it("скрипт чистки: просмотр считает, выгрузка пишет файл, удаление убирает только аренду", async () => {
    const before = await countRent();
    expect(before.total).toBeGreaterThanOrEqual(2);
    expect(before.bySource.some((g) => g.dealType === "RENT")).toBe(true);

    const file = join(tmpdir(), `rent-backup-${runId}.jsonl`);
    const exported = await exportRent(file, `${runId}-`);
    expect(exported).toBe(2);
    expect(existsSync(file)).toBe(true);
    const lines = readFileSync(file, "utf8").trim().split("\n").map((l) => JSON.parse(l) as { dealType: string });
    expect(lines.map((l) => l.dealType)).toEqual(["RENT", "RENT"]);
    rmSync(file, { force: true });

    expect(await deleteRent(1, `${runId}-`)).toBe(2);
    expect(await prisma.marketListing.count({ where: { sourceId: { startsWith: `${runId}-` }, dealType: "RENT" } })).toBe(0);
    expect(await prisma.marketListing.count({ where: { sourceId: { startsWith: `${runId}-` }, dealType: "SALE" } })).toBeGreaterThanOrEqual(2);
    expect(await deleteRent(500, `${runId}-`)).toBe(0);
  });
});
