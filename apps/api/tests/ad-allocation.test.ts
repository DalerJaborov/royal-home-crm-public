import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { prisma } from "../src/db.js";
import {
  adNeedsReview,
  allocateCents,
  loadAdAllocations,
  primaryOf,
  setAdProperties,
} from "../src/lib/ads/adAllocation.js";

/**
 * Деление денег объявления между объектами (lib/ads/adAllocation.ts).
 *
 * Инвариант, ради которого файл: СУММА ДОЛЕЙ РАВНА СУММЕ ОБЪЯВЛЕНИЯ ДО ЦЕНТА — при
 * любом числе объектов, любых весах и любой сумме. Иначе отчёт по объектам никогда
 * не сойдётся с кабинетом Meta.
 */

const ids = (n: number) => Array.from({ length: n }, (_, i) => `p${i}`);
const sum = (parts: { cents: number }[]) => parts.reduce((acc, p) => acc + p.cents, 0);

describe("allocateCents — чистая логика", () => {
  it("один объект забирает всё", () => {
    expect(allocateCents(12345, [{ propertyId: "a", weight: 1 }])).toEqual([{ propertyId: "a", weight: 1, cents: 12345 }]);
  });

  it("четыре объекта поровну с остатком: 1001 цент → 251/250/250/250, сумма точная", () => {
    const parts = allocateCents(
      1001,
      ids(4).map((propertyId) => ({ propertyId, weight: 1 }))
    );
    expect(sum(parts)).toBe(1001);
    expect(parts.map((p) => p.cents).sort((a, b) => b - a)).toEqual([251, 250, 250, 250]);
    // Лишний цент достаётся первому: порядок результата — порядок объектов.
    expect(parts[0].cents).toBe(251);
  });

  it("разные веса делят пропорционально и тоже без потерь", () => {
    const parts = allocateCents(1000, [
      { propertyId: "a", weight: 3 },
      { propertyId: "b", weight: 1 },
    ]);
    expect(parts.map((p) => p.cents)).toEqual([750, 250]);

    const odd = allocateCents(100, [
      { propertyId: "a", weight: 2 },
      { propertyId: "b", weight: 1 },
      { propertyId: "c", weight: 1 },
    ]);
    expect(sum(odd)).toBe(100);
    expect(odd.map((p) => p.cents)).toEqual([50, 25, 25]);
  });

  it("нулевой расход — нули, пустой список — пусто", () => {
    expect(allocateCents(0, ids(3).map((propertyId) => ({ propertyId, weight: 1 })))).toEqual(
      ids(3).map((propertyId) => ({ propertyId, weight: 1, cents: 0 }))
    );
    expect(allocateCents(500, [])).toEqual([]);
  });

  it("кривой вес не теряет деньги: некорректные пропускаются, а если годных нет — делим поровну", () => {
    const mixed = allocateCents(100, [
      { propertyId: "a", weight: 0 },
      { propertyId: "b", weight: Number.NaN },
      { propertyId: "c", weight: 1 },
    ]);
    expect(mixed.map((p) => p.cents)).toEqual([0, 0, 100]);

    const allBad = allocateCents(101, [
      { propertyId: "a", weight: 0 },
      { propertyId: "b", weight: -2 },
    ]);
    expect(sum(allBad)).toBe(101);
  });

  it("возврат (отрицательная сумма) тоже делится без потерь", () => {
    const parts = allocateCents(-101, ids(4).map((propertyId) => ({ propertyId, weight: 1 })));
    expect(sum(parts)).toBe(-101);
  });

  it("СВОЙСТВО: на любых случайных весах и суммах сумма долей всегда равна входу", () => {
    // Детерминированный генератор: упавший прогон воспроизводится.
    let seed = 20261003;
    const rand = () => {
      seed = (seed * 1664525 + 1013904223) % 4294967296;
      return seed / 4294967296;
    };
    for (let round = 0; round < 2000; round++) {
      const count = 1 + Math.floor(rand() * 12);
      const items = Array.from({ length: count }, (_, i) => ({
        propertyId: `p${i}`,
        // Веса с тремя знаками — как хранит колонка; изредка очень разные порядки.
        weight: Math.round((0.001 + rand() * (rand() < 0.2 ? 1000 : 5)) * 1000) / 1000,
      }));
      const total = Math.floor(rand() * 5_000_000);
      const parts = allocateCents(total, items);
      expect(sum(parts)).toBe(total);
      for (const p of parts) expect(p.cents).toBeGreaterThanOrEqual(0);
    }
  });
});

describe("primaryOf / adNeedsReview", () => {
  it("основной — первый по весу, при равных — первый в списке", () => {
    expect(primaryOf([{ weight: 1 }, { weight: 3 }, { weight: 3 }])).toEqual({ weight: 3 });
    expect(primaryOf([])).toBeNull();
    const first = { propertyId: "a", weight: 2 };
    expect(primaryOf([first, { propertyId: "b", weight: 2 }])).toBe(first);
  });

  it("взгляд человека нужен, когда объекта нет или материалов больше объектов — кроме ручной привязки и бренда", () => {
    expect(adNeedsReview({ assetCount: 1, matchSource: null, brand: false }, 0)).toBe(true);
    expect(adNeedsReview({ assetCount: 4, matchSource: "FEED_CAPTION", brand: false }, 2)).toBe(true);
    expect(adNeedsReview({ assetCount: 4, matchSource: "FEED_CAPTION", brand: false }, 4)).toBe(false);
    expect(adNeedsReview({ assetCount: 4, matchSource: "MANUAL", brand: false }, 1)).toBe(false);
    expect(adNeedsReview({ assetCount: 1, matchSource: null, brand: true }, 0)).toBe(false);
  });
});

describe("setAdProperties / loadAdAllocations — запись и чтение долей", () => {
  const runId = Date.now().toString(36);
  const propertyIds: string[] = [];
  const adIds: string[] = [];
  let districtId = "";

  async function makeProperty() {
    const p = await prisma.property.create({
      data: {
        title: `Тест-доли-${runId}-${propertyIds.length}`,
        type: "APARTMENT",
        rooms: 2,
        areaSqm: 50,
        price: 40000,
        currency: "USD",
        districtId,
        address: `Долевая, ${propertyIds.length}`,
        condition: "GOOD",
      },
    });
    propertyIds.push(p.id);
    return p;
  }
  async function makeAd(extra: Record<string, unknown> = {}) {
    const ad = await prisma.ad.create({
      data: {
        platform: "META",
        externalId: `alloc-${runId}-${adIds.length}`,
        name: `Тест-доли ${adIds.length}`,
        lastSyncedAt: new Date(),
        ...extra,
      },
    });
    adIds.push(ad.id);
    return ad;
  }

  beforeAll(async () => {
    districtId = (await prisma.district.create({ data: { name: `Тест-район-доли-${runId}` } })).id;
  });
  afterAll(async () => {
    await prisma.ad.deleteMany({ where: { id: { in: adIds } } });
    await prisma.property.deleteMany({ where: { id: { in: propertyIds } } });
    await prisma.district.deleteMany({ where: { id: districtId } });
  });

  it("пишет доли и основной объект в одной транзакции, основной — самый тяжёлый", async () => {
    const [a, b, c] = [await makeProperty(), await makeProperty(), await makeProperty()];
    const ad = await makeAd();

    const result = await setAdProperties(
      ad.id,
      [
        { propertyId: a.id, weight: 1 },
        { propertyId: b.id, weight: 2 },
        { propertyId: c.id, weight: 1, source: "ENTITY_NAME" },
      ],
      "FEED_CAPTION"
    );
    expect(result.propertyId).toBe(b.id);

    const saved = await prisma.ad.findUnique({ where: { id: ad.id }, select: { propertyId: true, matchSource: true } });
    expect(saved).toEqual({ propertyId: b.id, matchSource: "FEED_CAPTION" });

    const rows = await prisma.adProperty.findMany({ where: { adId: ad.id }, orderBy: { createdAt: "asc" } });
    expect(rows).toHaveLength(3);
    expect(rows.find((r) => r.propertyId === c.id)?.source).toBe("ENTITY_NAME");

    const loaded = await loadAdAllocations([ad.id]);
    expect(loaded.get(ad.id)?.map((i) => i.propertyId)).toEqual([b.id, a.id, c.id]);
  });

  it("повторная запись того же не пересоздаёт строки, замена списка убирает лишнее", async () => {
    const [a, b] = [await makeProperty(), await makeProperty()];
    const ad = await makeAd();
    await setAdProperties(ad.id, [{ propertyId: a.id, weight: 1 }, { propertyId: b.id, weight: 1 }], "POST_URL");
    const before = await prisma.adProperty.findMany({ where: { adId: ad.id }, select: { id: true } });

    await setAdProperties(ad.id, [{ propertyId: a.id, weight: 1 }, { propertyId: b.id, weight: 1 }], "POST_URL");
    const same = await prisma.adProperty.findMany({ where: { adId: ad.id }, select: { id: true } });
    expect(new Set(same.map((r) => r.id))).toEqual(new Set(before.map((r) => r.id)));

    await setAdProperties(ad.id, [{ propertyId: b.id, weight: 1 }], "MANUAL");
    const after = await prisma.adProperty.findMany({ where: { adId: ad.id } });
    expect(after.map((r) => r.propertyId)).toEqual([b.id]);
    expect(after[0].source).toBe("MANUAL");
    expect((await prisma.ad.findUnique({ where: { id: ad.id } }))?.propertyId).toBe(b.id);
  });

  it("пустой список снимает привязку и matchSource; повтор объекта схлопывается", async () => {
    const a = await makeProperty();
    const ad = await makeAd();
    await setAdProperties(ad.id, [{ propertyId: a.id, weight: 1 }, { propertyId: a.id, weight: 2 }], "POST_URL");
    const rows = await prisma.adProperty.findMany({ where: { adId: ad.id } });
    expect(rows).toHaveLength(1);
    expect(Number(rows[0].weight)).toBe(3);

    await setAdProperties(ad.id, [], "MANUAL");
    expect(await prisma.adProperty.count({ where: { adId: ad.id } })).toBe(0);
    expect(await prisma.ad.findUnique({ where: { id: ad.id }, select: { propertyId: true, matchSource: true } })).toEqual({
      propertyId: null,
      matchSource: null,
    });
  });

  it("запасной путь: объявление с propertyId без строк AdProperty читается как одна доля", async () => {
    const a = await makeProperty();
    const ad = await makeAd({ propertyId: a.id, matchSource: "POST_URL" });
    const loaded = await loadAdAllocations([ad.id]);
    expect(loaded.get(ad.id)).toEqual([{ propertyId: a.id, weight: 1 }]);
  });
});
