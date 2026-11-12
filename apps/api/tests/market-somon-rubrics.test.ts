import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { prisma } from "../src/db.js";
import { detectCategory, parseHouseTitle, toListing } from "../src/lib/market/somonParser.js";
import { isReadableCatalogRow, marketCatalogWhere, somonRubricOf } from "../src/lib/market/somonRubrics.js";
import { deleteJunk, fixMisclassified, planFromCounts } from "../src/lib/market/purgeSomonJunk.js";
import { findSegments } from "../src/lib/market/segments.js";

/**
 * Каталог Somon — только рубрики недвижимости (12.11.2026). 11.11 общая лента Somon записала
 * ~13,5 тыс. автозапчастей, окон и услуг «квартирами»: здесь — что они не пишутся, не читаются
 * ни одним чтением каталога и вычищаются скриптом.
 */

const runId = `rub${Date.now().toString().slice(-7)}`;
const DISTRICT = `Тест-рубрики-${runId}`;

const ad = (id: number, rubricId: number | null, title = "2-комн. квартира, 3 этаж, 50 м², Сино") => ({
  id,
  title,
  url: `/adv/${id}_x/`,
  price_without_currency: "600000",
  ...(rubricId == null ? {} : { rubric: { id: rubricId, slug: `r${rubricId}`, ancestors: [{ slug: "transport" }] } }),
});

describe("тип объекта и сделки — только из рубрики", () => {
  it("рубрика не из недвижимости — не объявление каталога (прежде: «квартира на продажу»)", () => {
    // живые примеры общей ленты 12.11.2026: автосервис, ноутбуки, услуги сантехника
    for (const foreign of [155, 227, 3019]) {
      expect(detectCategory(ad(1, foreign))).toBeNull();
      expect(toListing(ad(1, foreign))).toBeNull();
    }
    expect(toListing(ad(1, null))).toBeNull();
  });

  it("рубрики недвижимости дают тип и сделку без угадывания по словам", () => {
    expect(detectCategory(ad(1, 2833))).toEqual({ dealType: "SALE", propertyType: "APARTMENT" });
    expect(detectCategory(ad(1, 218))).toEqual({ dealType: "SALE", propertyType: "HOUSE" });
    expect(detectCategory(ad(1, 2845))).toEqual({ dealType: "RENT", propertyType: "APARTMENT" });
    expect(detectCategory(ad(1, 220))).toEqual({ dealType: "RENT", propertyType: "COMMERCIAL" });
    expect(detectCategory(ad(1, 219))).toEqual({ dealType: "SALE", propertyType: "LAND" });
  });

  it("дом: этажность, комнаты, сотки (живые заголовки рубрики 218)", () => {
    expect(parseHouseTitle("3 этажн. 6-комн. дом, 3 соток, Конституция, Бозори Балх")).toEqual({ rooms: 6, totalFloors: 3, areaSqm: null, landSotki: 3, landmark: "Конституция" });
    expect(parseHouseTitle("1 этажн. 3-комн. дом, 1.60 сотки, Фирдавси")).toMatchObject({ rooms: 3, totalFloors: 1, landSotki: 1.6 });
    expect(parseHouseTitle("2 этажн. 5-комн. дом, 180 м², 4 сотка, Сино")).toMatchObject({ areaSqm: 180, landSotki: 4, landmark: "Сино" });
    const house = toListing(ad(5, 218, "2 этажн. 7-комн. дом, 3 сотки, Сино"))!;
    expect(house).toMatchObject({ propertyType: "HOUSE", floor: null, totalFloors: 2, rooms: 7, landSotki: 3 });
  });
});

describe("правило чтения каталога (одно место — marketCatalogWhere)", () => {
  it("в памяти: Somon — только своя рубрика с тем же типом; прочие площадки — как есть", () => {
    expect(isReadableCatalogRow({ source: "somon.tj", raw: { rubric: { id: 2831 } }, dealType: "SALE", propertyType: "APARTMENT" })).toBe(true);
    expect(isReadableCatalogRow({ source: "somon.tj", raw: { rubric: { id: 155 } }, dealType: "SALE", propertyType: "APARTMENT" })).toBe(false);
    expect(isReadableCatalogRow({ source: "somon.tj", raw: {}, dealType: "SALE", propertyType: "APARTMENT" })).toBe(false);
    // дом, записанный старым разбором «квартирой», в цены квартир не идёт
    expect(isReadableCatalogRow({ source: "somon.tj", raw: { rubric: { id: 218 } }, dealType: "SALE", propertyType: "APARTMENT" })).toBe(false);
    expect(isReadableCatalogRow({ source: "paydo.tj", raw: {}, dealType: "SALE", propertyType: "APARTMENT" })).toBe(true);
    expect(somonRubricOf({ rubric: { id: "2831" } })).toBeNull();
  });

  describe("в базе", () => {
    const made: string[] = [];
    async function make(key: string, source: string, raw: object, over: Record<string, unknown> = {}) {
      const l = await prisma.marketListing.create({
        data: {
          source, sourceId: `${runId}-${key}`, sourceUrl: `https://${source}/adv/${runId}-${key}`,
          dealType: "SALE", propertyType: "APARTMENT", city: "Душанбе", districtName: DISTRICT, rooms: 2, areaSqm: 50 + made.length,
          floor: 3 + made.length, price: 600_000, currency: "TJS", priceTjs: 600_000 + made.length * 1000, pricePerSqmTjs: 12_000,
          title: `Тест ${key}`, isActive: true, lastSeenAt: new Date(), raw, ...over,
        },
      });
      made.push(l.id);
      return l;
    }

    beforeAll(async () => {
      for (let i = 0; i < 8; i++) await make(`flat${i}`, "somon.tj", { rubric: { id: 2831 } });
      for (let i = 0; i < 6; i++) await make(`junk${i}`, "somon.tj", { rubric: { id: 155, slug: "avtoservis-i-remont" } });
      await make("norubric", "somon.tj", {});
      await make("houseAsFlat", "somon.tj", { id: 1, url: "/adv/1_x/", title: "2 этажн. 5-комн. дом, 2 соток, Сино", rubric: { id: 218 } }, { floor: 2 });
      await make("paydo", "paydo.tj", {});
    });
    afterAll(async () => {
      await prisma.marketListing.deleteMany({ where: { id: { in: made } } });
    });

    it("запрос с правилом видит только своё; мусор и дом-«квартира» не видны", async () => {
      const rows = await prisma.marketListing.findMany({
        where: { sourceId: { startsWith: `${runId}-` }, AND: [marketCatalogWhere()] },
        select: { sourceId: true },
      });
      const keys = rows.map((r) => r.sourceId.slice(runId.length + 1)).sort();
      expect(keys).toEqual([...Array.from({ length: 8 }, (_, i) => `flat${i}`), "paydo"].sort());
    });

    it("цены по сегментам не считают мусор: 8 квартир + Paydo, а не 15", async () => {
      const res = await findSegments({ city: "Душанбе", districtName: DISTRICT });
      const total = res.segments.reduce((s, x) => s + x.count, 0);
      expect(total).toBe(9);
    });

    it("чистка: просмотр ничего не меняет; --apply удаляет только чужие рубрики и переписывает дом", async () => {
      expect(await fixMisclassified(false, `${runId}-`)).toBe(1);
      expect(await prisma.marketListing.count({ where: { sourceId: { startsWith: `${runId}-` } } })).toBe(17);

      expect(await deleteJunk(4, `${runId}-`)).toBe(7);
      expect(await fixMisclassified(true, `${runId}-`)).toBe(1);
      const left = await prisma.marketListing.findMany({ where: { sourceId: { startsWith: `${runId}-` } }, select: { sourceId: true, propertyType: true, floor: true, totalFloors: true, landSotki: true } });
      expect(left).toHaveLength(10);
      const house = left.find((r) => r.sourceId.endsWith("houseAsFlat"))!;
      expect(house).toMatchObject({ propertyType: "HOUSE", floor: null, totalFloors: 2 });
      expect(Number(house.landSotki)).toBe(2);
      expect(await deleteJunk(4, `${runId}-`)).toBe(0); // повтор безопасен
    });
  });

  it("план чистки: что остаётся и что уходит", () => {
    const plan = planFromCounts([
      { rubricId: "2831", slug: "2-komnatnyie", count: 3000 },
      { rubricId: "786", slug: "avtozapchasti", count: 786 },
      { rubricId: null, slug: null, count: 5 },
      { rubricId: "218", slug: "prodazha-domov-havli-i-dach", count: 77 },
    ]);
    expect(plan).toMatchObject({ keep: 3077, junk: 791 });
    expect(plan.byRubric[0]).toMatchObject({ rubricId: "2831", keep: true });
  });
});
