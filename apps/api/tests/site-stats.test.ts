import { afterAll, beforeAll, afterEach, describe, expect, it, vi } from "vitest";

/**
 * СТАТИСТИКА САЙТА ROYALHOME.TJ В CRM (24.09.2026) — lib/siteStats.ts.
 *
 * Сеть подменяется: проверяем, что CRM правильно раскладывает ответ сайта —
 * объект находится и по id CRM, и по номеру объекта сайта; две строки одного
 * объекта за день складываются; повторный сбор ПЕРЕЗАПИСЫВАЕТ, а не удваивает;
 * посетители по часам попадают на тепловую карту срезом «site».
 */

const { prisma } = await import("../src/db.js");
const { collectSiteStats, dushanbeDayKeyToDate, storeSiteStats } = await import("../src/lib/siteStats.js");
const { loadHeatmapCells } = await import("../src/lib/audienceHeatmap.js");

const runId = Date.now();
const siteListingId = 900_000_000 + (runId % 90_000_000);
let districtId: string;
let crmBorn: string;
let siteBorn: string;
// Часы — трое суток назад, по минутам runId: свой час, чужих строк там нет.
const hourA = new Date(Math.floor((Date.now() - 3 * 86_400_000) / 3_600_000) * 3_600_000);
const hourB = new Date(hourA.getTime() + 3_600_000);

beforeAll(async () => {
  districtId = (await prisma.district.create({ data: { name: `Тест-район-site-stats-${runId}` } })).id;
  const base = { type: "APARTMENT" as const, areaSqm: 50, price: 40000, currency: "TJS" as const, districtId, address: "Тестовая, 1", condition: "GOOD" as const };
  crmBorn = (await prisma.property.create({ data: { ...base, title: `Из CRM ${runId}` } })).id;
  siteBorn = (await prisma.property.create({ data: { ...base, title: `С сайта ${runId}`, siteListingId } })).id;
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

afterAll(async () => {
  await prisma.siteVisitHour.deleteMany({ where: { hourStart: { in: [hourA, hourB] } } });
  await prisma.property.deleteMany({ where: { id: { in: [crmBorn, siteBorn] } } });
  await prisma.district.delete({ where: { id: districtId } }).catch(() => {});
  await prisma.$disconnect();
});

function listing(extra: Partial<{ listingId: number; externalId: string | null; day: string; views: number; whatsapp: number }>) {
  return {
    listingId: 1,
    externalId: null,
    day: "2026-09-20",
    views: 1,
    visitors: 1,
    phone: 0,
    whatsapp: 0,
    telegram: 0,
    share: 0,
    favorite: 0,
    ...extra,
  };
}

describe("dushanbeDayKeyToDate", () => {
  it("день по Душанбе — полночь Душанбе в UTC (19:00 предыдущих суток)", () => {
    expect(dushanbeDayKeyToDate("2026-09-24").toISOString()).toBe("2026-09-23T19:00:00.000Z");
  });
});

describe("storeSiteStats — раскладка ответа сайта", () => {
  it("находит объект по id CRM и по номеру сайта, складывает две строки дня, чужие считает", async () => {
    const res = await storeSiteStats({
      hours: [
        { hourStart: hourA.toISOString(), views: 12, visitors: 7 },
        { hourStart: hourB.toISOString(), views: 3, visitors: 2 },
      ],
      listings: [
        listing({ listingId: 55, externalId: crmBorn, views: 5, whatsapp: 1 }),
        // Та же квартира по старой странице с номером сайта — одна строка дня.
        listing({ listingId: 56, externalId: crmBorn, views: 2 }),
        listing({ listingId: siteListingId, externalId: null, views: 4 }),
        listing({ listingId: 1, externalId: "нет-такого-объекта", views: 9 }),
      ],
    });
    expect(res).toEqual({ hours: 2, days: 2, unmatched: 1 });

    const day = dushanbeDayKeyToDate("2026-09-20");
    const a = await prisma.sitePropertyDay.findUniqueOrThrow({ where: { propertyId_day: { propertyId: crmBorn, day } } });
    expect(a.views).toBe(7);
    expect(a.whatsappClicks).toBe(1);
    const b = await prisma.sitePropertyDay.findUniqueOrThrow({ where: { propertyId_day: { propertyId: siteBorn, day } } });
    expect(b.views).toBe(4);
  });

  it("повторный сбор того же дня и часа перезаписывает, а не удваивает", async () => {
    await storeSiteStats({
      hours: [{ hourStart: hourA.toISOString(), views: 20, visitors: 9 }],
      listings: [listing({ listingId: 55, externalId: crmBorn, views: 8 })],
    });
    const day = dushanbeDayKeyToDate("2026-09-20");
    const a = await prisma.sitePropertyDay.findUniqueOrThrow({ where: { propertyId_day: { propertyId: crmBorn, day } } });
    expect(a.views).toBe(8);
    const h = await prisma.siteVisitHour.findUniqueOrThrow({ where: { hourStart: hourA } });
    expect(h).toMatchObject({ views: 20, visitors: 9 });
  });

  it("посетители по часам — срез «Посетители сайта» на тепловой карте", async () => {
    const cells = await loadHeatmapCells({ signal: "site", channel: "ALL", days: 7 });
    const local = new Date(hourA.getTime() + 5 * 3_600_000);
    const cell = cells.find((c) => c.dow === local.getUTCDay() && c.hour === local.getUTCHours());
    expect(cell?.count ?? 0).toBeGreaterThanOrEqual(9);
    // У среза один источник — других каналов не бывает.
    expect(await loadHeatmapCells({ signal: "site", channel: "INSTAGRAM", days: 7 })).toEqual([]);
  });
});

describe("collectSiteStats — сеть", () => {
  it("связь с сайтом не настроена — тихий отказ, не поломка", async () => {
    vi.stubEnv("SITE_SYNC_URL", "");
    const res = await collectSiteStats();
    expect(res).toMatchObject({ ok: false, notConfigured: true });
  });

  it("сайт без выдачи статистики (404) — понятная причина", async () => {
    vi.stubEnv("SITE_SYNC_URL", "http://site.test/api/v1/crm");
    vi.stubEnv("SITE_SYNC_API_KEY", "k");
    vi.stubGlobal("fetch", vi.fn(async () => new Response("{}", { status: 404 })));
    const res = await collectSiteStats();
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toMatch(/ещё не выкачена/);
    // Отдельный признак — крон по нему напоминает раз в сутки, а не каждый час (25.09.2026).
    if (!res.ok) expect(res.siteNotDeployed).toBe(true);
  });

  it("ответ не того вида — отказ, в базу ничего", async () => {
    vi.stubEnv("SITE_SYNC_URL", "http://site.test/api/v1/crm");
    vi.stubEnv("SITE_SYNC_API_KEY", "k");
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ hours: "много" }), { status: 200 })));
    const res = await collectSiteStats();
    expect(res.ok).toBe(false);
  });

  it("шлёт ключ и окно, раскладывает ответ", async () => {
    vi.stubEnv("SITE_SYNC_URL", "http://site.test/api/v1/crm");
    vi.stubEnv("SITE_SYNC_API_KEY", "секрет");
    const fetchMock = vi.fn(async (_url: string, _init?: RequestInit) =>
      new Response(JSON.stringify({ hours: [{ hourStart: hourB.toISOString(), views: 4, visitors: 3 }], listings: [] }), { status: 200 })
    );
    vi.stubGlobal("fetch", fetchMock);
    const res = await collectSiteStats();
    expect(res).toEqual({ ok: true, hours: 1, days: 0, unmatched: 0 });
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toMatch(/^http:\/\/site\.test\/api\/v1\/crm\/stats\?since=.*&until=/);
    expect((init?.headers as Record<string, string>)["X-Api-Key"]).toBe("секрет");
    const h = await prisma.siteVisitHour.findUniqueOrThrow({ where: { hourStart: hourB } });
    expect(h.visitors).toBe(3);
  });
});
