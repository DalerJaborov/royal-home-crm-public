import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * НОМЕР КАРТОЧКИ (shortId) УХОДИТ НА САЙТ (19.10.2026).
 *
 * Сайт хранит shortId и шлёт его в Meta Pixel как content_ids; тот же номер —
 * home_listing_id фида каталога (lib/metaCatalogFeed.ts). Снимок объекта для сайта
 * собирает одна функция (toSitePayload), через неё идут ВСЕ пути: публикация,
 * досылка site-resync, массовая публикация. Второй блок — скрипт добора
 * `site:resync-short-ids` для уже опубликованных строк: по умолчанию ничего не шлёт.
 */

const { propertyFindUnique, propertyFindMany, propertyCount } = vi.hoisted(() => ({
  propertyFindUnique: vi.fn(async () => null as Record<string, unknown> | null),
  propertyFindMany: vi.fn(async () => [] as Record<string, unknown>[]),
  propertyCount: vi.fn(async () => 0),
}));

vi.mock("../src/db.js", () => ({
  prisma: {
    property: { findUnique: propertyFindUnique, findMany: propertyFindMany, count: propertyCount, update: vi.fn() },
    settings: { findUnique: vi.fn(async () => ({ usdToTjsRate: 11 })) },
    $disconnect: vi.fn().mockResolvedValue(undefined),
  },
}));
vi.mock("../src/lib/systemError.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/lib/systemError.js")>()),
  logSystemError: vi.fn(async () => {}),
}));

vi.stubEnv("SITE_SYNC_URL", "https://site.example/api/v1/crm");
vi.stubEnv("SITE_SYNC_API_KEY", "test-key");
vi.stubEnv("CRM_PUBLIC_URL", "https://crm.example");

const sent: { externalId: string; action: string; shortId?: number; data?: { shortId?: number } }[] = [];
const fetchMock = vi.fn(async (_url: string, init: { body: string }) => {
  const body = JSON.parse(init.body) as { items: typeof sent };
  sent.push(...body.items);
  return new Response(JSON.stringify({ results: body.items.map((i) => ({ externalId: i.externalId, ok: true })) }), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
});
vi.stubGlobal("fetch", fetchMock);

const siteSync = await import("../src/lib/siteSync.js");
const backfill = await import("../src/lib/backfillSiteShortIds.js");

const property = (overrides: Record<string, unknown> = {}) => ({
  id: "prop-1",
  shortId: 1234,
  title: "Квартира",
  type: "APARTMENT",
  rooms: 2,
  areaSqm: 60,
  price: 500000,
  currency: "TJS",
  description: "Светлая квартира",
  status: "AVAILABLE",
  offSite: false,
  siteListingId: null,
  publishedOnSite: true,
  deletedAt: null,
  lat: null,
  lng: null,
  instagramUrl: null,
  district: { name: "Сино", city: "Душанбе" },
  photos: [{ url: "/uploads/a.webp", order: 0 }],
  ...overrides,
});

type Syncable = Parameters<typeof siteSync.syncPropertiesToSite>[0][number];

beforeEach(() => {
  sent.length = 0;
  fetchMock.mockClear();
  propertyFindUnique.mockReset();
  propertyFindMany.mockReset();
  propertyCount.mockReset();
});

afterAll(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe("снимок объекта для сайта несёт shortId", () => {
  it("прямая публикация", async () => {
    await siteSync.syncPropertiesToSite([property() as unknown as Syncable], "publish");
    expect(sent[0]?.action).toBe("publish");
    // The deployed website reads item.shortId, not item.data.shortId.
    expect(sent[0]?.shortId).toBe(1234);
    expect(sent[0]?.data?.shortId).toBeUndefined();
  });

  it("досылка site-resync (runSiteResyncAttempt)", async () => {
    propertyFindUnique.mockResolvedValue(property({ shortId: 777 }));
    await siteSync.runSiteResyncAttempt("prop-1", "правка карточки");
    expect(sent[0]?.shortId).toBe(777);
  });

  it("объект, пришедший с сайта (siteListingId), тоже несёт номер", async () => {
    await siteSync.syncPropertiesToSite([property({ siteListingId: 55, shortId: 4321 }) as unknown as Syncable], "publish");
    expect(sent[0]?.shortId).toBe(4321);
  });

  it("снятие с публикации данных не шлёт — номер не нужен", async () => {
    await siteSync.syncPropertiesToSite([property() as unknown as Syncable], "unpublish");
    expect(sent[0]?.data).toBeUndefined();
    expect(sent[0]?.shortId).toBe(1234);
  });
});

describe("скрипт site:resync-short-ids", () => {
  const originalArgv = process.argv;
  const originalExitCode = process.exitCode;
  afterAll(() => {
    process.argv = originalArgv;
    process.exitCode = originalExitCode;
  });

  function arrange() {
    const rows = [property({ id: "a", shortId: 1 }), property({ id: "b", shortId: 2 }), property({ id: "c", shortId: 3 })];
    propertyCount.mockResolvedValue(rows.length);
    propertyFindMany.mockImplementation((async (args: { include?: unknown; where: { id?: { in?: string[] } } }) => {
      // Первый вызов — выборка кандидатов (select), дальше — загрузка партии (include).
      if (!args.include) return rows.map((r) => ({ id: r.id, shortId: r.shortId, title: r.title }));
      const ids = args.where.id?.in ?? [];
      return rows.filter((r) => ids.includes(r.id));
    }) as never);
  }

  it("без --apply (по умолчанию) ничего не отправляет", async () => {
    arrange();
    process.argv = ["node", "backfillSiteShortIds.ts"];
    await backfill.main();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("--apply шлёт publish со shortId, партиями по --batch", async () => {
    arrange();
    process.argv = ["node", "backfillSiteShortIds.ts", "--apply", "--batch", "2"];
    await backfill.main();
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(sent.map((s) => [s.externalId, s.action, s.shortId])).toEqual([
      ["a", "publish", 1],
      ["b", "publish", 2],
      ["c", "publish", 3],
    ]);
  });

  it("объект, ушедший с сайта за время прогона, в партию не попадает", async () => {
    propertyCount.mockResolvedValue(1);
    propertyFindMany.mockImplementation((async (args: { include?: unknown }) =>
      args.include ? [] : [{ id: "gone", shortId: 9, title: "Ушёл" }]) as never);
    process.argv = ["node", "backfillSiteShortIds.ts", "--apply"];
    await backfill.main();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("a missing website acknowledgement makes the backfill fail", async () => {
    arrange();
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({ results: [
      { externalId: "a", ok: true }, { externalId: "b", ok: true },
    ] }), { status: 200 }));
    process.argv = ["node", "backfillSiteShortIds.ts", "--apply"];
    process.exitCode = undefined;
    await backfill.main();
    expect(process.exitCode).toBe(1);
    process.exitCode = originalExitCode;
  });
});
