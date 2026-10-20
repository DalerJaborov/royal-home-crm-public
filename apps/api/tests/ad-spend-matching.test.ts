import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { prisma } from "../src/db.js";

/**
 * Привязка рекламного объявления к объекту и запись расходов.
 *
 * Проверяются ровно те инварианты, поломка которых стоит денег и доверия:
 *   1. три пути привязки (ссылка в карточке → лента Instagram → номер в названии);
 *   2. ручную привязку синхронизация НЕ переписывает;
 *   3. повторный прогон не удваивает расход за тот же день.
 *
 * Лента Instagram и рекламный кабинет мокаются: настоящий Graph API в тестах не
 * нужен и не должен вызываться.
 */

let feed: { id: string; permalink: string; caption?: string; mediaType: string }[] = [];

vi.mock("../src/messengers/instagramFeed.js", () => ({
  getAllOwnMedia: vi.fn(async () => feed),
  getInstagramMedia: vi.fn(async () => feed),
}));

let ads: {
  id: string;
  name: string;
  campaignId: string | null;
  campaignName: string | null;
  adsetId: string | null;
  adsetName: string | null;
  postUrl: string | null;
  mediaId: string | null;
  storyId: string | null;
  thumbnailUrl: string | null;
}[] = [];
let stats: {
  adId: string;
  date: string;
  spend: number;
  impressions: number;
  reach: number;
  clicks: number;
  conversations: number;
}[] = [];

vi.mock("../src/lib/ads/metaAdsApi.js", () => ({
  loadMetaAdsCredentials: vi.fn(async () => ({ enabled: true, token: "test-token", adAccountIds: ["act_1"] })),
  isMetaAdsConfigured: () => true,
  fetchMetaAds: vi.fn(async () => ads),
  fetchMetaAdSets: vi.fn(async () => ({ byId: new Map(), partial: false })),
  fetchMetaAdDailyStats: vi.fn(async () => stats),
  fetchAdAccountCurrency: vi.fn(async () => "USD" as const),
  fetchAccountSpendTotal: vi.fn(async () => 0),
  parseAdAccountIds: (raw: string | null) =>
    (raw ?? "").split(/[\s,;]+/).filter(Boolean).map((p) => `act_${p.replace(/\D/g, "")}`),
  MetaAdsTokenError: class MetaAdsTokenError extends Error {},
}));

const { buildAdMatcher } = await import("../src/lib/ads/adMatching.js");
const { syncMetaAds } = await import("../src/lib/ads/syncMetaAds.js");
const { buildAdSpendReport } = await import("../src/lib/ads/adSpendReport.js");

const runId = Date.now().toString(36);
let districtId = "";
const propertyIds: string[] = [];
const externalIds: string[] = [];

async function makeProperty(instagramUrl: string | null) {
  const p = await prisma.property.create({
    data: {
      title: `Тест-реклама-${runId}-${propertyIds.length}`,
      type: "APARTMENT",
      rooms: 2,
      areaSqm: 50,
      price: 40000,
      currency: "USD",
      districtId,
      address: `Рекламная, ${10 + propertyIds.length}`,
      condition: "GOOD",
      instagramUrl,
    },
  });
  propertyIds.push(p.id);
  return p;
}

beforeAll(async () => {
  districtId = (await prisma.district.create({ data: { name: `Тест-район-реклама-${runId}` } })).id;
});

afterAll(async () => {
  await prisma.adSpendDaily.deleteMany({ where: { ad: { externalId: { in: externalIds } } } });
  await prisma.ad.deleteMany({ where: { externalId: { in: externalIds } } });
  await prisma.property.deleteMany({ where: { id: { in: propertyIds } } });
  await prisma.district.deleteMany({ where: { id: districtId } });
});

describe("привязка объявления к объекту", () => {
  it("находит объект по ссылке из карточки, по подписи в ленте и по номеру в названии", async () => {
    const byLink = await makeProperty(`https://www.instagram.com/reel/link-${runId}/`);
    // У этой карточки ссылка испорчена — ровно случай 17 объектов на проде.
    const byFeed = await makeProperty("https://t.me/royalhome_tj/7");
    const byName = await makeProperty(null);

    feed = [
      {
        id: `media-feed-${runId}`,
        permalink: `https://www.instagram.com/reel/feed-${runId}/`,
        caption: `Просторная квартира — №${byFeed.shortId}`,
        mediaType: "VIDEO",
      },
    ];

    const matcher = await buildAdMatcher();

    expect(await matcher.match({ postUrl: `https://www.instagram.com/reel/link-${runId}/` })).toEqual({
      propertyId: byLink.id,
      source: "POST_URL",
    });

    expect(await matcher.match({ postUrl: `https://www.instagram.com/reel/feed-${runId}/` })).toEqual({
      propertyId: byFeed.id,
      source: "FEED_CAPTION",
    });

    expect(await matcher.match({ name: `Лето #${byName.shortId}`, campaignName: "Вовлечённость" })).toEqual({
      propertyId: byName.id,
      source: "ENTITY_NAME",
    });

    // Чужая публикация и название без номера — объекта нет, и выдумывать его нельзя.
    expect(await matcher.match({ postUrl: "https://www.instagram.com/reel/CHUZHOY/" })).toBeNull();
    expect(await matcher.match({ name: "Новое объявление с целью Вовлечённость" })).toBeNull();
  });

  it("чинит ссылку в карточке, когда связь доказана лентой", async () => {
    const broken = await makeProperty("https://t.me/royalhome_tj/8");
    const permalink = `https://www.instagram.com/reel/heal-${runId}/`;
    feed = [{ id: `media-heal-${runId}`, permalink, caption: `Дом — №${broken.shortId}`, mediaType: "VIDEO" }];

    const matcher = await buildAdMatcher();
    const match = await matcher.match({ postUrl: permalink });

    expect(match?.source).toBe("FEED_CAPTION");
    expect(matcher.healedCount()).toBe(1);
    const after = await prisma.property.findUnique({ where: { id: broken.id }, select: { instagramUrl: true } });
    expect(after?.instagramUrl).toBe(permalink);
  });
});

describe("синхронизация расходов", () => {
  it("не удваивает расход за тот же день и не трогает ручную привязку", async () => {
    const auto = await makeProperty(`https://www.instagram.com/reel/sync-${runId}/`);
    const manual = await makeProperty(null);

    const externalId = `ad-${runId}-1`;
    externalIds.push(externalId);
    feed = [];
    ads = [
      {
        id: externalId,
        name: "Новое объявление с целью Вовлечённость",
        campaignId: "camp-1",
        campaignName: "Вовлечённость",
        adsetId: "set-1",
        adsetName: "Группа 1",
        postUrl: `https://www.instagram.com/reel/sync-${runId}/`,
        mediaId: null,
        storyId: null,
        thumbnailUrl: "https://example.invalid/thumb.jpg",
      },
    ];
    stats = [
      { adId: externalId, date: "2026-08-19", spend: 12.5, impressions: 1000, reach: 800, clicks: 30, conversations: 4 },
    ];

    const first = await syncMetaAds();
    expect(first.ads).toBe(1);
    expect(first.matched).toBe(1);
    expect(first.spendRows).toBe(1);

    const saved = await prisma.ad.findUnique({
      where: { platform_externalId: { platform: "META", externalId } },
      select: { id: true, propertyId: true, matchSource: true, postShortcode: true },
    });
    expect(saved?.propertyId).toBe(auto.id);
    expect(saved?.matchSource).toBe("POST_URL");
    expect(saved?.postShortcode).toBe(`sync-${runId}`);

    // Человек перепривязал объявление на другой объект.
    await prisma.ad.update({ where: { id: saved!.id }, data: { propertyId: manual.id, matchSource: "MANUAL" } });

    // Второй прогон с теми же данными: расход не удваивается, привязка держится.
    const second = await syncMetaAds();
    expect(second.spendRows).toBe(1);

    const rows = await prisma.adSpendDaily.findMany({ where: { adId: saved!.id } });
    expect(rows).toHaveLength(1);
    expect(Number(rows[0].spend)).toBe(12.5);

    const afterSecond = await prisma.ad.findUnique({
      where: { id: saved!.id },
      select: { propertyId: true, matchSource: true },
    });
    expect(afterSecond?.propertyId).toBe(manual.id);
    expect(afterSecond?.matchSource).toBe("MANUAL");
  });
});

describe("отчёт по объектам", () => {
  it("складывает расход на объект и держит непривязанное отдельной строкой", async () => {
    const withProperty = await makeProperty(`https://www.instagram.com/reel/report-${runId}/`);
    const linkedId = `ad-${runId}-report-linked`;
    const strayId = `ad-${runId}-report-stray`;
    externalIds.push(linkedId, strayId);

    feed = [];
    ads = [
      {
        id: linkedId,
        name: "Публикация объекта",
        campaignId: "camp-2",
        campaignName: "Квартиры август",
        adsetId: null,
        adsetName: null,
        postUrl: `https://www.instagram.com/reel/report-${runId}/`,
        mediaId: null,
        storyId: null,
        thumbnailUrl: null,
      },
      {
        // Реклама чужого бизнеса из того же кабинета — объекта у неё нет и не будет.
        id: strayId,
        name: "Офлайн десерты",
        campaignId: "camp-3",
        campaignName: "Десерты",
        adsetId: null,
        adsetName: null,
        postUrl: null,
        mediaId: null,
        storyId: null,
        thumbnailUrl: "https://example.invalid/dessert.jpg",
      },
    ];
    stats = [
      { adId: linkedId, date: "2026-08-18", spend: 10, impressions: 500, reach: 400, clicks: 20, conversations: 3 },
      { adId: linkedId, date: "2026-08-19", spend: 5.5, impressions: 300, reach: 250, clicks: 10, conversations: 1 },
      { adId: strayId, date: "2026-08-18", spend: 7, impressions: 200, reach: 150, clicks: 5, conversations: 0 },
    ];

    await syncMetaAds();
    const report = await buildAdSpendReport("2026-08");

    const row = report.rows.find((r) => r.property?.id === withProperty.id);
    expect(row).toBeTruthy();
    // Два дня одного объявления складываются в одну строку объекта.
    expect(row!.spendOriginal).toBeCloseTo(15.5, 2);
    expect(row!.conversations).toBe(4);
    expect(row!.campaigns).toContain("Квартиры август");

    const stray = report.rows.find((r) => r.property === null);
    expect(stray).toBeTruthy();
    expect(stray!.spendOriginal).toBeGreaterThanOrEqual(7);
    // Строка без объекта всегда последняя — это остаток, а не участник рейтинга.
    expect(report.rows[report.rows.length - 1].property).toBeNull();
  });
});

describe("чужая реклама в общем кабинете", () => {
  it("не попадает в отчёт, пока человек не скажет «это наше»", async () => {
    const ours = await makeProperty(`https://www.instagram.com/reel/mine-${runId}/`);
    const mineId = `ad-${runId}-mine`;
    const alienId = `ad-${runId}-alien`;
    externalIds.push(mineId, alienId);

    // Лента наших публикаций: в ней есть только наш пост.
    feed = [
      {
        id: `media-mine-${runId}`,
        permalink: `https://www.instagram.com/reel/mine-${runId}/`,
        caption: `Квартира — №${ours.shortId}`,
        mediaType: "VIDEO",
      },
    ];
    ads = [
      {
        id: mineId,
        name: "Наш объект",
        campaignId: null,
        campaignName: "Квартиры",
        adsetId: null,
        adsetName: null,
        postUrl: `https://www.instagram.com/reel/mine-${runId}/`,
        mediaId: null,
        storyId: null,
        thumbnailUrl: null,
      },
      {
        // Другой клиент подрядчика: публикация не наша, Страница не наша.
        id: alienId,
        name: "Стоматология «Улыбка»",
        campaignId: null,
        campaignName: "Импланты",
        adsetId: null,
        adsetName: null,
        postUrl: "https://www.instagram.com/reel/ALIEN123/",
        mediaId: null,
        storyId: "999999_888888",
        thumbnailUrl: null,
      },
    ];
    stats = [
      { adId: mineId, date: "2026-07-10", spend: 9, impressions: 100, reach: 90, clicks: 4, conversations: 2 },
      { adId: alienId, date: "2026-07-10", spend: 100, impressions: 900, reach: 800, clicks: 40, conversations: 9 },
    ];

    const result = await syncMetaAds();
    expect(result.foreign).toBe(1);

    const report = await buildAdSpendReport("2026-07");
    // Сто долларов стоматологии не имеют к нашим квартирам никакого отношения.
    expect(report.totals.spendOriginal).toBeCloseTo(9, 2);
    expect(report.rows.every((r) => r.campaigns.every((c) => c !== "Импланты"))).toBe(true);

    // Человек говорит «нет, это наше» — расход возвращается в отчёт и держится
    // против следующей синхронизации.
    const alien = await prisma.ad.findUnique({
      where: { platform_externalId: { platform: "META", externalId: alienId } },
      select: { id: true },
    });
    await prisma.ad.update({ where: { id: alien!.id }, data: { excluded: false } });
    await syncMetaAds();

    const after = await prisma.ad.findUnique({ where: { id: alien!.id }, select: { excluded: true } });
    expect(after?.excluded).toBe(false);
    const reportAfter = await buildAdSpendReport("2026-07");
    expect(reportAfter.totals.spendOriginal).toBeCloseTo(109, 2);
  });
});

describe("автоматическая строка в Финансах", () => {
  it("создаётся при сверке, обновляется без дублей и не воскресает после удаления", async () => {
    const { upsertAdExpenses } = await import("../src/lib/ads/adExpenseSync.js");
    const { dushanbeWallClock } = await import("../src/lib/dushanbeTime.js");

    /**
     * МЕСЯЦ БЕРЁТСЯ ОТ СЕГОДНЯШНЕГО ДНЯ, А НЕ ЗАШИТ (07.09.2026).
     *
     * Здесь стояла дата «2026-08-05» и ключ «ads:META:2026-08». Но syncMetaAds
     * пересчитывает расходы только за месяцы, которых касаются последние
     * REFRESH_DAYS=7 дней (recentMonths в lib/ads/adExpenseSync.ts) — то есть
     * зашитый август попадал в окно лишь до 06.09 включительно. В полночь по
     * Душанбе 07.09 окно сузилось до одного сентября, строка за август
     * перестала создаваться, и тест начал падать САМ ПО СЕБЕ — на любой ветке,
     * блокируя все мержи и выкаты. Локально он при этом проходил: в рабочей
     * базе строка оставалась от прежних прогонов, а в CI база чистая.
     *
     * Часы берём той же функцией, что и прод-код (dushanbeWallClock), поэтому
     * тест согласован с окном по построению, а не по совпадению.
     */
    const wall = dushanbeWallClock();
    const pad = (n: number) => String(n).padStart(2, "0");
    const month = `${wall.getUTCFullYear()}-${pad(wall.getUTCMonth() + 1)}`;
    const statDate = `${month}-${pad(wall.getUTCDate())}`;
    const autoKey = `ads:META:${month}`;

    const prop = await makeProperty(`https://www.instagram.com/reel/fin-${runId}/`);
    const extId = `ad-${runId}-fin`;
    externalIds.push(extId);
    feed = [];
    ads = [{
      id: extId, name: "Финансы", campaignId: null, campaignName: "Тест",
      adsetId: null, adsetName: null,
      postUrl: `https://www.instagram.com/reel/fin-${runId}/`, mediaId: null, storyId: null, thumbnailUrl: null,
    }];
    stats = [{ adId: extId, date: statDate, spend: 20, impressions: 10, reach: 10, clicks: 1, conversations: 1 }];
    await syncMetaAds();

    const row = await prisma.expense.findUnique({ where: { autoKey } });
    expect(row).toBeTruthy();
    expect(row!.category).toBe("ADVERTISING");
    expect(Number(row!.amount)).toBeGreaterThanOrEqual(20);

    // Повторный прогон не создаёт вторую строку.
    await upsertAdExpenses([month]);
    const count = await prisma.expense.count({ where: { autoKey } });
    expect(count).toBe(1);

    // Человек удалил строку — пересчёт её не воскрешает.
    await prisma.expense.update({ where: { autoKey }, data: { deletedAt: new Date() } });
    await upsertAdExpenses([month]);
    const after = await prisma.expense.findUnique({ where: { autoKey } });
    expect(after?.deletedAt).not.toBeNull();
    void prop;
  });
});

describe("привязка по тексту публикации", () => {
  it("связывает пост с объектом по адресу и цене, но молчит при ничьей", async () => {
    const prop = await prisma.property.create({
      data: {
        title: `Тест-текст-${runId}`,
        type: "APARTMENT",
        rooms: 3,
        areaSqm: 90,
        price: 105000,
        currency: "USD",
        districtId,
        address: "Рудаки 45",
        condition: "GOOD",
      },
    });
    propertyIds.push(prop.id);

    const permalink = `https://www.instagram.com/p/caption-${runId}/`;
    feed = [
      {
        id: `media-caption-${runId}`,
        permalink,
        caption: "Продаётся квартира на Рудаки, 3 комнаты, цена 105000 долларов",
        mediaType: "IMAGE",
      },
    ];

    const matcher = await buildAdMatcher({ heal: false });
    const hit = await matcher.match({ postUrl: permalink });
    expect(hit).toEqual({ propertyId: prop.id, source: "FEED_CAPTION" });

    // Текст без опознавательных признаков — привязки быть не должно.
    feed = [
      { id: `media-vague-${runId}`, permalink: `https://www.instagram.com/p/vague-${runId}/`, caption: "Скоро новые объекты!", mediaType: "IMAGE" },
    ];
    const vague = await buildAdMatcher({ heal: false });
    expect(await vague.match({ postUrl: `https://www.instagram.com/p/vague-${runId}/` })).toBeNull();
  });
});
