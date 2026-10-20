import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { prisma } from "../src/db.js";

/**
 * «Одно объявление — несколько объектов» (03.10.2026): матчер на все материалы,
 * запись долей синхронизацией, ручная привязка, неполные объявления и деньги по
 * объектам. Поводом стало «гибкое» объявление «Умед хонахо»: четыре ролика про
 * четыре квартиры, а весь расход лежал на одной.
 *
 * Graph и лента Instagram замоканы: сеть в тестах не нужна и не должна вызываться.
 */

vi.mock("../src/messengers/instagramFeed.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/messengers/instagramFeed.js")>()),
  getAllOwnMedia: vi.fn(async () => []),
  getInstagramMedia: vi.fn(async () => []),
}));

type Asset = { kind: "video" | "image" | "post" | "carousel_card"; id: string; text?: string; permalink?: string };
interface Entity {
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
  caption: string | null;
  assets: Asset[];
}
let entities: Entity[] = [];
/** Объявления, которых нет в списке /ads, но которые Graph отдаёт по номеру. */
let lazyEntities: Entity[] = [];
let stats: { adId: string; date: string; spend: number; impressions: number; reach: number; clicks: number; conversations: number }[] = [];

vi.mock("../src/lib/ads/metaAdsApi.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/lib/ads/metaAdsApi.js")>()),
  loadMetaAdsCredentials: vi.fn(async () => ({ enabled: true, token: "test-token", adAccountIds: ["act_1"] })),
  isMetaAdsConfigured: () => true,
  fetchMetaAds: vi.fn(async () => entities),
  // Одно объявление по номеру (ensureMetaAdKnown): отдаём из того же списка.
  fetchMetaAdById: vi.fn(async (_c: unknown, adId: string) => {
    const found = lazyEntities.find((e) => e.id === adId);
    return found ? { entity: found, adAccountId: "act_1" } : null;
  }),
  fetchMetaAdSets: vi.fn(async () => ({ byId: new Map(), partial: false })),
  fetchMetaAdDailyStats: vi.fn(async () => stats),
  fetchAdAccountCurrency: vi.fn(async () => "USD" as const),
  // Итог кабинета: нулевой — сверка с ним в этом файле не проверяется.
  fetchAccountSpendTotal: vi.fn(async () => 0),
  parseAdAccountIds: (raw: string | null) =>
    (raw ?? "").split(/[\s,;]+/).filter(Boolean).map((p) => `act_${p.replace(/\D/g, "")}`),
  MetaAdsTokenError: class MetaAdsTokenError extends Error {},
}));

const { buildAdMatcher } = await import("../src/lib/ads/adMatching.js");
const { syncMetaAds, ensureMetaAdKnown, resetLazyAdFetch } = await import("../src/lib/ads/syncMetaAds.js");
const { buildAdSpendReport } = await import("../src/lib/ads/adSpendReport.js");
const { buildReconcileReport } = await import("../src/lib/ads/adReconcile.js");
const { setAdProperties } = await import("../src/lib/ads/adAllocation.js");
const { adReferralPropertyId } = await import("../src/messengers/sharedMedia.js");
const { centsToTjs, loadMoneyContext, toCents } = await import("../src/lib/money.js");

const runId = Date.now().toString(36);
/** Только буквы: адрес в тексте ролика ищется подстрокой, цифры runId мешали бы. */
const letters = runId.replace(/[0-9]/g, (d) => "абвгдежзик"[Number(d)]);
let districtId = "";
const propertyIds: string[] = [];
const externalIds: string[] = [];

/** Счётчик объектов файла: у каждого своя улица и своя цена, иначе подписи двух ролей были бы ничьёй. */
let seq = 0;

/** Объект с уникальной улицей и уникальной ценой — так подпись ролика узнаёт ровно его. */
async function makeProperty(_label?: number) {
  const index = seq++;
  const suffix = String(index).replace(/[0-9]/g, (d) => "абвгдежзик"[Number(d)]);
  const street = `Мультиулица${letters}${suffix}`;
  const price = 71000 + index * 137;
  const p = await prisma.property.create({
    data: {
      title: `Тест-мульти-${runId}-${index}`,
      type: "APARTMENT",
      rooms: 2,
      areaSqm: 50,
      price,
      currency: "USD",
      districtId,
      address: `${street}, ${index + 1}`,
      condition: "GOOD",
    },
  });
  propertyIds.push(p.id);
  return { id: p.id, shortId: p.shortId, street, price };
}

function videoAbout(p: { street: string; price: number }, id: string): Asset {
  return { kind: "video", id, text: `Продаётся квартира на улице ${p.street}. Цена ${p.price} долларов` };
}

function entity(externalId: string, assets: Asset[], over: Partial<Entity> = {}): Entity {
  externalIds.push(externalId);
  return {
    id: externalId,
    name: `Умед хонахо ${runId}`,
    campaignId: "camp-m",
    campaignName: "Вовлечённость",
    adsetId: "set-m",
    adsetName: "Группа",
    postUrl: null,
    mediaId: null,
    storyId: null,
    thumbnailUrl: null,
    caption: null,
    assets,
    ...over,
  };
}

beforeAll(async () => {
  districtId = (await prisma.district.create({ data: { name: `Тест-район-мульти-${runId}` } })).id;
});

afterAll(async () => {
  await prisma.errorLog.deleteMany({ where: { source: "ads", message: { contains: runId } } });
  await prisma.ad.deleteMany({ where: { externalId: { in: externalIds } } });
  await prisma.property.deleteMany({ where: { id: { in: propertyIds } } });
  await prisma.district.deleteMany({ where: { id: districtId } });
});

describe("matchAll — материалы объявления", () => {
  it("«гибкое» объявление: четыре ролика про четыре квартиры → четыре объекта", async () => {
    const props = [await makeProperty(0), await makeProperty(1), await makeProperty(2), await makeProperty(3)];
    const matcher = await buildAdMatcher({ heal: false });
    const result = await matcher.matchAll(
      entity(`flex-${runId}-a`, props.map((p, i) => videoAbout(p, `v${i}`)))
    );

    expect(result.matches.map((m) => m.propertyId)).toEqual(props.map((p) => p.id));
    expect(result.matches.every((m) => m.source === "FEED_CAPTION")).toBe(true);
    expect(result.assetCount).toBe(4);
    // Каждый ролик знает свой объект — по этому видно, что именно привязано.
    expect(result.assets.map((a) => a.propertyId)).toEqual(props.map((p) => p.id));

    // Старый match() — тонкая обёртка: первый объект.
    expect((await matcher.match(entity(`flex-${runId}-a2`, props.map((p, i) => videoAbout(p, `v${i}`)))))?.propertyId).toBe(
      props[0].id
    );
  });

  it("опознаны два ролика из четырёх: объектов два, материалов четыре — объявление неполное", async () => {
    const [a, b] = [await makeProperty(4), await makeProperty(5)];
    const matcher = await buildAdMatcher({ heal: false });
    const result = await matcher.matchAll(
      entity(`flex-${runId}-b`, [
        videoAbout(a, "w0"),
        videoAbout(b, "w1"),
        { kind: "video", id: "w2", text: "Просто красивый ролик без адреса" },
        { kind: "video", id: "w3" },
      ])
    );
    expect(result.matches.map((m) => m.propertyId)).toEqual([a.id, b.id]);
    expect(result.assetCount).toBe(4);
    expect(result.assetCount).toBeGreaterThan(result.matches.length);
  });

  it("материалы про один и тот же объект считаются одним: пять фото одной квартиры — не «пять неизвестных»", async () => {
    const p = await makeProperty(6);
    const matcher = await buildAdMatcher({ heal: false });
    const result = await matcher.matchAll(
      entity(`flex-${runId}-c`, [0, 1, 2, 3, 4].map((i) => ({ ...videoAbout(p, `x${i}`), kind: "image" as const })))
    );
    expect(result.matches).toHaveLength(1);
    expect(result.assetCount).toBe(1);
  });

  it("все номера из названия: «№a и #b» → два объекта по ENTITY_NAME", async () => {
    const [a, b] = [await makeProperty(7), await makeProperty(3)];
    const matcher = await buildAdMatcher({ heal: false });
    const result = await matcher.matchAll(entity(`flex-${runId}-d`, [], { name: `Лето №${a.shortId} и #${b.shortId}` }));
    expect(result.matches.map((m) => [m.propertyId, m.source])).toEqual([
      [a.id, "ENTITY_NAME"],
      [b.id, "ENTITY_NAME"],
    ]);
  });

  it("без догадок: подпись с одним признаком (только цена) ничего не доказывает", async () => {
    const p = await makeProperty(2);
    const matcher = await buildAdMatcher({ heal: false });
    const result = await matcher.matchAll(
      entity(`flex-${runId}-e`, [{ kind: "video", id: "z0", text: `Цена ${p.price} долларов, звоните` }])
    );
    expect(result.matches).toEqual([]);
    expect(result.assetCount).toBe(1);
  });
});

describe("синхронизация: доли, ручная привязка, неполные объявления, деньги", () => {
  it("пишет доли всех объектов, сохраняет материалы и делит расход без потери цента", async () => {
    const props = [await makeProperty(0), await makeProperty(1), await makeProperty(2), await makeProperty(3)];
    const externalId = `flex-${runId}-sync`;
    entities = [entity(externalId, props.map((p, i) => videoAbout(p, `s${i}`)))];
    // 10.01 + 0.02 доллара: сумма в центах не делится на четыре — остаток обязан достаться кому-то.
    stats = [
      { adId: externalId, date: "2026-08-19", spend: 10.01, impressions: 1003, reach: 800, clicks: 31, conversations: 7 },
      { adId: externalId, date: "2026-08-20", spend: 0.02, impressions: 5, reach: 5, clicks: 1, conversations: 0 },
    ];

    const result = await syncMetaAds();
    expect(result.ads).toBe(1);
    expect(result.matched).toBe(1);
    expect(result.incomplete).toBe(0);

    const ad = await prisma.ad.findUniqueOrThrow({
      where: { platform_externalId: { platform: "META", externalId } },
      include: { properties: true },
    });
    expect(ad.properties.map((r) => r.propertyId).sort()).toEqual(props.map((p) => p.id).sort());
    // Основной объект — тот же, что первый по весу (веса равны → первый найденный).
    expect(ad.propertyId).toBe(props[0].id);
    expect(ad.assetCount).toBe(4);
    expect(Array.isArray(ad.creativeAssets) && ad.creativeAssets.length).toBe(4);

    // Деньги: сумма по четырём объектам равна расходу объявления ДО ЦЕНТА.
    const report = await buildAdSpendReport({ from: new Date("2026-08-19T00:00:00Z"), to: new Date("2026-08-20T00:00:00Z") });
    const mine = report.rows.filter((r) => r.property && props.some((p) => p.id === r.property!.id));
    expect(mine).toHaveLength(4);
    const money = await loadMoneyContext();
    const adCents = centsToTjs(toCents(10.03), "USD", money);
    expect(mine.reduce((acc, r) => acc + toCents(r.spendTjs), 0)).toBe(adCents);
    // Обращения и показы тоже делятся без потерь, а объявление в итоге одно.
    expect(mine.reduce((acc, r) => acc + r.conversations, 0)).toBe(7);
    expect(mine.reduce((acc, r) => acc + r.impressions, 0)).toBe(1008);
    expect(mine.every((r) => r.adsCount === 1)).toBe(true);
  });

  it("ручную привязку синхронизация НЕ перезаписывает никогда — даже когда машина нашла другое", async () => {
    const props = [await makeProperty(0), await makeProperty(1)];
    const manual = await makeProperty(4);
    const externalId = `flex-${runId}-manual`;
    entities = [entity(externalId, props.map((p, i) => videoAbout(p, `m${i}`)))];
    stats = [];

    await syncMetaAds();
    const ad = await prisma.ad.findUniqueOrThrow({ where: { platform_externalId: { platform: "META", externalId } } });
    expect(await prisma.adProperty.count({ where: { adId: ad.id } })).toBe(2);

    // Человек разложил объявление по-своему: один объект с весом 5.
    await setAdProperties(ad.id, [{ propertyId: manual.id, weight: 5 }], "MANUAL");

    await syncMetaAds();
    await syncMetaAds();
    const rows = await prisma.adProperty.findMany({ where: { adId: ad.id } });
    expect(rows.map((r) => [r.propertyId, Number(r.weight), r.source])).toEqual([[manual.id, 5, "MANUAL"]]);
    const after = await prisma.ad.findUniqueOrThrow({ where: { id: ad.id } });
    expect(after.propertyId).toBe(manual.id);
    expect(after.matchSource).toBe("MANUAL");
  });

  it("ASSETS_NOT_LINKED: 4 материала, найдено 2 — объявление неполное и попадает в сверку", async () => {
    const [a, b] = [await makeProperty(0), await makeProperty(1)];
    const externalId = `flex-${runId}-incomplete`;
    entities = [
      entity(externalId, [
        videoAbout(a, "i0"),
        videoAbout(b, "i1"),
        { kind: "video", id: "i2", text: "Без адреса" },
        { kind: "video", id: "i3" },
      ]),
    ];
    stats = [{ adId: externalId, date: "2026-08-19", spend: 4, impressions: 100, reach: 90, clicks: 3, conversations: 1 }];

    const result = await syncMetaAds();
    expect(result.incomplete).toBe(1);

    const ad = await prisma.ad.findUniqueOrThrow({
      where: { platform_externalId: { platform: "META", externalId } },
      include: { properties: true },
    });
    expect(ad.assetCount).toBe(4);
    expect(ad.properties).toHaveLength(2);

    const report = await buildReconcileReport(
      { from: new Date("2026-08-19T00:00:00Z"), to: new Date("2026-08-19T00:00:00Z") },
      { credentials: null }
    );
    const issue = report.issues.find((i) => i.adId === ad.id);
    expect(issue?.kind).toBe("ASSETS_NOT_LINKED");

    // Человек подтвердил раскладку — вопрос закрыт, сверка про это объявление молчит.
    await setAdProperties(ad.id, [{ propertyId: a.id, weight: 1 }, { propertyId: b.id, weight: 1 }], "MANUAL");
    const after = await buildReconcileReport(
      { from: new Date("2026-08-19T00:00:00Z"), to: new Date("2026-08-19T00:00:00Z") },
      { credentials: null }
    );
    expect(after.issues.find((i) => i.adId === ad.id)).toBeUndefined();
  });

  it("клик по рекламе про НЕСКОЛЬКО объектов не называет клиенту «основной» — какой из них, неизвестно", async () => {
    const [a, b] = [await makeProperty(), await makeProperty()];
    const solo = `flex-${runId}-ref-solo`;
    const multi = `flex-${runId}-ref-multi`;
    entities = [entity(solo, []), entity(multi, [])];
    stats = [];
    await syncMetaAds();
    const [soloAd, multiAd] = await Promise.all(
      [solo, multi].map((externalId) =>
        prisma.ad.findUniqueOrThrow({ where: { platform_externalId: { platform: "META", externalId } } })
      )
    );
    await setAdProperties(soloAd.id, [{ propertyId: a.id, weight: 1 }], "MANUAL");
    await setAdProperties(multiAd.id, [{ propertyId: a.id, weight: 1 }, { propertyId: b.id, weight: 1 }], "MANUAL");

    expect(await adReferralPropertyId({ adId: solo })).toBe(a.id);
    expect(await adReferralPropertyId({ adId: multi })).toBeNull();
  });

  /**
   * 03.10.2026, вопрос Dan «почему назван агент Ноза»: клиент ответил на ролик про
   * одну квартиру, а у гибкого объявления в нашей таблице лежат номер публикации и
   * «№N» в названии от СОСЕДНЕГО ролика. Решает только ролик из метки Meta.
   */
  it("гибкое объявление: объект берётся по ролику, на который ответил клиент, а не по полям объявления", async () => {
    const [a, b] = [await makeProperty(), await makeProperty()];
    const multi = `flex-${runId}-ref-seen`;
    entities = [entity(multi, [])];
    stats = [];
    await syncMetaAds();
    const multiAd = await prisma.ad.findUniqueOrThrow({ where: { platform_externalId: { platform: "META", externalId: multi } } });
    const mediaA = `media-${runId}-a`;
    const mediaB = `media-${runId}-b`;
    await prisma.property.update({ where: { id: a.id }, data: { publishedPostIds: { INSTAGRAM: mediaA } } });
    await prisma.property.update({ where: { id: b.id }, data: { publishedPostIds: { INSTAGRAM: mediaB } } });
    // Поля объявления указывают на A — так сверка записала первый ролик.
    await prisma.ad.update({ where: { id: multiAd.id }, data: { mediaId: mediaA, name: `Гибкое №${a.shortId} №${b.shortId}` } });
    await setAdProperties(multiAd.id, [{ propertyId: a.id, weight: 1 }, { propertyId: b.id, weight: 1 }], "MANUAL");

    // Клиент ответил на ролик B — объект B.
    expect(await adReferralPropertyId({ adId: multi, adPostId: mediaB })).toBe(b.id);
    // Какой ролик видел клиент, неизвестно — не угадываем по первому ролику и названию.
    expect(await adReferralPropertyId({ adId: multi })).toBeNull();
  });

  it("объявления нет в таблице — догружается по номеру, и бот узнаёт объект и его агента", async () => {
    resetLazyAdFetch();
    const p = await makeProperty();
    const lost = `lost-${runId}-archived`;
    // В списке /ads его нет (архив при откате фильтра статусов) — только по номеру.
    entities = [];
    lazyEntities = [entity(lost, [], { name: `Фирдавси №${p.shortId}` })];
    expect(await adReferralPropertyId({ adId: lost })).toBeNull();

    expect(await ensureMetaAdKnown(lost)).toBe(true);
    const row = await prisma.ad.findUniqueOrThrow({
      where: { platform_externalId: { platform: "META", externalId: lost } },
      select: { propertyId: true },
    });
    expect(row.propertyId).toBe(p.id);
    expect(await adReferralPropertyId({ adId: lost })).toBe(p.id);
    // Уже известное — второй раз в Meta не ходим.
    expect(await ensureMetaAdKnown(lost)).toBe(true);
  });

  it("объявление не читается вовсе — объект берётся по подписи ролика из сообщения", async () => {
    resetLazyAdFetch();
    const p = await makeProperty();
    const unknown = `nowhere-${runId}`;
    lazyEntities = [];
    expect(await ensureMetaAdKnown(unknown)).toBe(false);
    expect(
      await adReferralPropertyId({ adId: unknown, mediaCaption: `3-комн, 75 м², 12 этаж.\nОбъект №${p.shortId}` })
    ).toBe(p.id);
  });
});
