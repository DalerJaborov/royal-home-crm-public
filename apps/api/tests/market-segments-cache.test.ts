import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { prisma } from "../src/db.js";
import {
  findSegmentsCached,
  resetSegmentsCache,
  SEGMENTS_CACHE_MAX_KEYS,
  SEGMENTS_CACHE_MS,
  segmentsCacheKey,
} from "../src/lib/market/segments.js";

/**
 * Кэш «Рынок: цены» (17.11.2026, аудит скорости P1): повторное открытие экрана с тем же
 * фильтром в течение 10 минут не идёт в базу и не разбирает заново тысячи объявлений.
 */

const DISTRICT = `Тест-кэш-сегментов-${Date.now()}-${process.pid}`;

beforeEach(() => resetSegmentsCache());
afterEach(() => {
  vi.restoreAllMocks();
  resetSegmentsCache();
});

describe("findSegmentsCached", () => {
  it("второй вызов с тем же фильтром не идёт в базу", async () => {
    const spy = vi.spyOn(prisma.marketListing, "findMany");
    const t0 = 1_000_000;
    const first = await findSegmentsCached({ city: "Душанбе", districtName: DISTRICT }, t0);
    const second = await findSegmentsCached({ city: "Душанбе", districtName: DISTRICT }, t0 + 60_000);
    expect(spy).toHaveBeenCalledTimes(1);
    expect(second).toBe(first);
  });

  it("другой фильтр — свой расчёт; срок вышел — снова база", async () => {
    const spy = vi.spyOn(prisma.marketListing, "findMany");
    const t0 = 2_000_000;
    await findSegmentsCached({ city: "Душанбе", districtName: DISTRICT }, t0);
    await findSegmentsCached({ city: "Душанбе", districtName: DISTRICT, rooms: 2 }, t0);
    expect(spy).toHaveBeenCalledTimes(2);
    await findSegmentsCached({ city: "Душанбе", districtName: DISTRICT }, t0 + SEGMENTS_CACHE_MS);
    expect(spy).toHaveBeenCalledTimes(3);
  });

  it("одновременные запросы делят один расчёт", async () => {
    const spy = vi.spyOn(prisma.marketListing, "findMany");
    const q = { city: "Душанбе", districtName: DISTRICT, building: "new" as const };
    const [a, b, c] = await Promise.all([findSegmentsCached(q, 3_000_000), findSegmentsCached(q, 3_000_000), findSegmentsCached(q, 3_000_000)]);
    expect(spy).toHaveBeenCalledTimes(1);
    expect(b).toBe(a);
    expect(c).toBe(a);
  });

  it("ключ — все поля запроса и не зависит от порядка", () => {
    expect(segmentsCacheKey({ city: "Душанбе", rooms: 2, districtName: "Сино" })).toBe(
      segmentsCacheKey({ districtName: "Сино", city: "Душанбе", rooms: 2 })
    );
    expect(segmentsCacheKey({ city: "Душанбе", rooms: 2 })).not.toBe(segmentsCacheKey({ city: "Душанбе", rooms: 3 }));
    expect(segmentsCacheKey({ city: "Душанбе", repair: "WHITE" })).not.toBe(segmentsCacheKey({ city: "Душанбе" }));
  });

  it("число ключей ограничено: свободный текст района не раздувает память", async () => {
    const spy = vi.spyOn(prisma.marketListing, "findMany").mockResolvedValue([]);
    for (let i = 0; i < SEGMENTS_CACHE_MAX_KEYS + 5; i++) {
      await findSegmentsCached({ city: "Душанбе", districtName: `${DISTRICT}-${i}` }, 4_000_000);
    }
    expect(spy).toHaveBeenCalledTimes(SEGMENTS_CACHE_MAX_KEYS + 5);
    spy.mockClear();
    // Последний — в кэше, самый первый — вытеснен.
    await findSegmentsCached({ city: "Душанбе", districtName: `${DISTRICT}-${SEGMENTS_CACHE_MAX_KEYS + 4}` }, 4_000_001);
    expect(spy).toHaveBeenCalledTimes(0);
    await findSegmentsCached({ city: "Душанбе", districtName: `${DISTRICT}-0` }, 4_000_001);
    expect(spy).toHaveBeenCalledTimes(1);
  });
});
