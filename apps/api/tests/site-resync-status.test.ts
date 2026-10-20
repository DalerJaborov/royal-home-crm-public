import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * ДОСЫЛКА НА САЙТ СМОТРИТ НА СТАТУС ОБЪЕКТА (глубокая проверка 02.10.2026, D3).
 *
 * `runSiteResyncAttempt` (тело задания site-resync) всегда слал «publish», если
 * у объекта стояла отметка publishedOnSite. Снятие с сайта при уходе с продажи —
 * одна попытка без повтора, и отметка сбрасывается только при её успехе. Сайт
 * был недоступен в эту секунду → отметка осталась → любая следующая правка
 * карточки (фото, описание) возвращала СНЯТЫЙ объект на royalhome.tj живым
 * объявлением. Тот же исход у досылки, ушедшей на повтор до снятия.
 *
 * Здесь же D10: порядок фото на сайте — по `order`, а не по порядку строк из
 * базы (у части вызывающих не было ORDER BY, и обложка на сайте менялась).
 */

const { propertyFindUnique, propertyUpdate } = vi.hoisted(() => ({
  propertyFindUnique: vi.fn(async () => null as Record<string, unknown> | null),
  propertyUpdate: vi.fn(async () => ({})),
}));

vi.mock("../src/db.js", () => ({
  prisma: {
    property: { findUnique: propertyFindUnique, update: propertyUpdate },
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

const sent: { action: string; data?: { sold?: boolean; imageUrls?: string[] } }[] = [];
const fetchMock = vi.fn(async (_url: string, init: { body: string }) => {
  const body = JSON.parse(init.body) as { items: { externalId: string; action: string; data?: { sold?: boolean } }[] };
  sent.push(...body.items);
  return new Response(JSON.stringify({ results: body.items.map((i) => ({ externalId: i.externalId, ok: true })) }), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
});
vi.stubGlobal("fetch", fetchMock);

const siteSync = await import("../src/lib/siteSync.js");

const property = (overrides: Record<string, unknown> = {}) => ({
  id: "prop-1",
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

beforeEach(() => {
  sent.length = 0;
  propertyFindUnique.mockReset();
  propertyUpdate.mockClear();
});

afterAll(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe("D3: досылка снятого объекта снимает его с сайта, а не публикует", () => {
  it('facts repair never republishes or sends listing content', async () => {
    const p = property({ floor: 16, totalFloors: 18, condition: 'NEW_BUILDING', stage: 'SHELL', marketType: 'NEW_BUILD', urgent: false });
    await siteSync.syncPropertiesToSite([p as unknown as Parameters<typeof siteSync.syncPropertiesToSite>[0][number]], 'facts');
    const body = JSON.parse(fetchMock.mock.calls.at(-1)![1].body);
    expect(body.items[0]).toMatchObject({ action: 'facts', facts: { floor: '16/18', repair: 'Без отделки' } });
    expect(body.items[0].data).toBeUndefined();
    expect(body.items[0].facts).not.toHaveProperty('price');
    expect(body.items[0].facts).not.toHaveProperty('imageUrls');
  });
  it.each([{ offSite: true }, { deletedAt: new Date() }, { publishedOnSite: false }, { status: 'WITHDRAWN' }])('does not disclose facts of ineligible properties %j', async overrides => {
    fetchMock.mockClear();
    const p = property(overrides) as unknown as Parameters<typeof siteSync.syncPropertiesToSite>[0][number];
    expect((await siteSync.syncPropertiesToSite([p], 'facts')).ok).toBe(false);
    expect(fetchMock).not.toHaveBeenCalled();
  });
  it('sends floor and condition facts with a routine resync', async () => {
    propertyFindUnique.mockResolvedValue(property({ floor: 16, totalFloors: 18, condition: 'NEW_BUILDING', stage: 'SHELL', marketType: 'NEW_BUILD', urgent: false }));
    await siteSync.runSiteResyncAttempt('prop-1', 'correct website facts');
    expect(sent[0]?.data).toMatchObject({ floor: '16/18', totalFloors: 18, repair: 'Без отделки', stage: 'Коробка, черновые не сделаны', type: 'Новостройки' });
  });
  for (const status of ["WITHDRAWN", "PENDING_REVIEW", "AWAITING_PHOTOS", "AWAITING_VIDEO", "EDITING"]) {
    it(`${status}: уходит unpublish и отметка «на сайте» снимается`, async () => {
      propertyFindUnique.mockResolvedValue(property({ status }));
      await siteSync.runSiteResyncAttempt("prop-1", "правка карточки");
      expect(sent.map((s) => s.action)).toEqual(["unpublish"]);
      expect(propertyUpdate).toHaveBeenCalledWith({ where: { id: "prop-1" }, data: { publishedOnSite: false } });
    });
  }

  it("AVAILABLE и RESERVED публикуются как прежде, отметка не трогается", async () => {
    for (const status of ["AVAILABLE", "RESERVED"]) {
      propertyFindUnique.mockResolvedValue(property({ status }));
      await siteSync.runSiteResyncAttempt("prop-1", "правка карточки");
    }
    expect(sent.map((s) => s.action)).toEqual(["publish", "publish"]);
    expect(sent.every((s) => s.data?.sold === false)).toBe(true);
    expect(propertyUpdate).not.toHaveBeenCalled();
  });

  it("SOLD остаётся на сайте с плашкой «Продано»", async () => {
    propertyFindUnique.mockResolvedValue(property({ status: "SOLD" }));
    await siteSync.runSiteResyncAttempt("prop-1", "правка карточки");
    expect(sent.map((s) => s.action)).toEqual(["publish"]);
    expect(sent[0].data?.sold).toBe(true);
  });
});

describe("D10: порядок фото для сайта", () => {
  it("siteImageUrls сортирует снимки по order сама, даже без ORDER BY у вызывающего", () => {
    const urls = siteSync.siteImageUrls(
      property({
        photos: [
          { url: "/uploads/third.webp", order: 2 },
          { url: "/uploads/cover.webp", order: 0 },
          { url: "/uploads/second.webp", order: 1 },
        ],
      }) as unknown as Parameters<typeof siteSync.siteImageUrls>[0]
    );
    expect(urls.map((u) => u.split("/").pop())).toEqual(["cover.webp", "second.webp", "third.webp"]);
  });
});
