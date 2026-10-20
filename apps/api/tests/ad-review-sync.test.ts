import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { prisma } from "../src/db.js";

/**
 * РЕВЬЮ СЕРВЕРНОЙ ЧАСТИ РЕКЛАМЫ (03.10.2026) — исправления, которые проверяются на настоящей
 * базе: откат на базовые поля креатива не стирает связи (п. 1), параллельные прогоны и
 * гонка с ручной привязкой (п. 2), карусель считается по карточкам (п. 5), архивные
 * объявления с расходом (п. 8), «давно не сверялись» из крона (п. 12), признаки «комнаты»
 * и «цена» в подписи (п. 16), живая сверка связей (п. 9).
 *
 * Graph и лента Instagram замоканы: сеть в тестах не нужна и не должна вызываться.
 */

vi.mock("../src/messengers/instagramFeed.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/messengers/instagramFeed.js")>()),
  getAllOwnMedia: vi.fn(async () => []),
  getInstagramMedia: vi.fn(async () => []),
}));

type Asset = {
  kind: "video" | "image" | "post" | "carousel_card";
  id: string;
  text?: string;
  permalink?: string;
  videoId?: string;
};
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
  partial?: boolean;
}
interface Stat {
  adId: string;
  adName?: string;
  campaignName?: string;
  date: string;
  spend: number;
  impressions: number;
  reach: number;
  clicks: number;
  conversations: number;
}
let entities: Entity[] = [];
let stats: Stat[] = [];
const fetchMetaAdsMock = vi.fn(async () => entities);

vi.mock("../src/lib/ads/metaAdsApi.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/lib/ads/metaAdsApi.js")>()),
  loadMetaAdsCredentials: vi.fn(async () => ({ enabled: true, token: "test-token", adAccountIds: ["act_review"] })),
  isMetaAdsConfigured: () => true,
  fetchMetaAds: (...args: unknown[]) => fetchMetaAdsMock(...(args as [])),
  fetchMetaAdSets: vi.fn(async () => ({ byId: new Map(), partial: false })),
  fetchMetaAdDailyStats: vi.fn(async () => stats),
  fetchAdAccountCurrency: vi.fn(async () => "USD" as const),
  fetchAccountSpendTotal: vi.fn(async () => 0),
  parseAdAccountIds: (raw: string | null) =>
    (raw ?? "").split(/[\s,;]+/).filter(Boolean).map((p) => `act_${p.replace(/\D/g, "")}`),
  MetaAdsTokenError: class MetaAdsTokenError extends Error {},
}));

const { buildAdMatcher, matchByCaption, textHasPrice, textHasRooms } = await import("../src/lib/ads/adMatching.js");
const { syncMetaAds, ADS_SYNC_LOCK_ID } = await import("../src/lib/ads/syncMetaAds.js");
const { setAdProperties } = await import("../src/lib/ads/adAllocation.js");
const { parseCreativeAssets } = await import("../src/lib/ads/adAssets.js");
const { buildReconcileReport, watchStaleSync } = await import("../src/lib/ads/adReconcile.js");

const runId = Date.now().toString(36);
/** Только буквы: адрес в тексте ролика ищется подстрокой, цифры runId мешали бы. */
const letters = runId.replace(/[0-9]/g, (d) => "абвгдежзик"[Number(d)]);
let districtId = "";
const propertyIds: string[] = [];
const externalIds: string[] = [];
let seq = 0;
let savedSettings: { metaAdsEnabled: boolean; metaAdsSyncedAt: Date | null } | null = null;

async function makeProperty(rooms = 3) {
  const index = seq++;
  const suffix = String(index).replace(/[0-9]/g, (d) => "абвгдежзик"[Number(d)]);
  // Хвост «ю»: без него улица объекта №1 была бы подстрокой улицы объекта №11 — ничья признаков.
  const street = `Ревьюулица${letters}${suffix}ю`;
  const price = 83000 + index * 211;
  const p = await prisma.property.create({
    data: {
      title: `Тест-ревью-${runId}-${index}`,
      type: "APARTMENT",
      rooms,
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

const videoAbout = (p: { street: string; price: number }, id: string): Asset => ({
  kind: "video",
  id,
  text: `Продаётся квартира на улице ${p.street}. Цена ${p.price} долларов`,
});

function entity(externalId: string, assets: Asset[], over: Partial<Entity> = {}): Entity {
  externalIds.push(externalId);
  return {
    id: externalId,
    name: `Ревью-объявление ${runId}`,
    campaignId: "camp-r",
    campaignName: "Вовлечённость",
    adsetId: "set-r",
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

const adOf = (externalId: string) =>
  prisma.ad.findUniqueOrThrow({
    where: { platform_externalId: { platform: "META", externalId } },
    include: { properties: true },
  });

beforeAll(async () => {
  districtId = (await prisma.district.create({ data: { name: `Тест-район-ревью-${runId}` } })).id;
  const s = await prisma.settings.findUnique({
    where: { id: "singleton" },
    select: { metaAdsEnabled: true, metaAdsSyncedAt: true },
  });
  savedSettings = s;
});

afterAll(async () => {
  if (savedSettings) {
    await prisma.settings.updateMany({ where: { id: "singleton" }, data: savedSettings });
  }
  await prisma.errorLog.deleteMany({ where: { source: "ads", message: { contains: "синхронизация рекламы" } } });
  await prisma.ad.deleteMany({ where: { externalId: { in: externalIds } } });
  await prisma.property.deleteMany({ where: { id: { in: propertyIds } } });
  await prisma.district.deleteMany({ where: { id: districtId } });
});

describe("п. 1 — откат на базовые поля не стирает связи", () => {
  it("объявление с 4 связями + прогон в режиме partial → связи на месте, материалы и assetCount не тронуты", async () => {
    const props = [await makeProperty(), await makeProperty(), await makeProperty(), await makeProperty()];
    const externalId = `rv-${runId}-partial`;
    entities = [entity(externalId, props.map((p, i) => videoAbout(p, `p${i}`)))];
    stats = [];
    await syncMetaAds();
    const before = await adOf(externalId);
    expect(before.properties).toHaveLength(4);
    expect(before.assetCount).toBe(4);

    // Meta отказала на asset_feed_spec: в ответе только «пост» без материалов — partial.
    entities = [entity(externalId, [{ kind: "post", id: "https://www.instagram.com/p/xyz/" }], { partial: true })];
    await syncMetaAds();
    const after = await adOf(externalId);
    expect(after.properties.map((r) => r.propertyId).sort()).toEqual(props.map((p) => p.id).sort());
    expect(after.assetCount).toBe(4);
    expect(Array.isArray(after.creativeAssets) && after.creativeAssets.length).toBe(4);
    expect(after.propertyId).toBe(before.propertyId);
  });

  it("partial только ДОБАВЛЯЕТ: найден ещё один объект — он появляется, прежние остаются", async () => {
    const [a, b, c] = [await makeProperty(), await makeProperty(), await makeProperty()];
    const externalId = `rv-${runId}-partial-add`;
    entities = [entity(externalId, [videoAbout(a, "a0"), videoAbout(b, "a1")])];
    await syncMetaAds();
    expect((await adOf(externalId)).properties).toHaveLength(2);

    entities = [entity(externalId, [videoAbout(c, "a2")], { partial: true })];
    await syncMetaAds();
    const after = await adOf(externalId);
    expect(after.properties.map((r) => r.propertyId).sort()).toEqual([a.id, b.id, c.id].sort());
    // Материалы и их число — прежние (неполный ответ их не переписывает).
    expect(after.assetCount).toBe(2);
  });
});

describe("п. 2 — гонки синхронизации", () => {
  it("второй прогон при занятом замке пропускается без ошибки и не ходит в Meta", async () => {
    entities = [];
    stats = [];
    let release!: () => void;
    const held = new Promise<void>((resolve) => (release = resolve));
    let acquired!: () => void;
    const gotLock = new Promise<void>((resolve) => (acquired = resolve));
    const holder = prisma.$transaction(
      async (tx) => {
        await tx.$executeRaw`SELECT pg_advisory_xact_lock(${ADS_SYNC_LOCK_ID}::bigint)`;
        acquired();
        await held;
      },
      { timeout: 60_000 }
    );
    await gotLock;
    try {
      fetchMetaAdsMock.mockClear();
      const skipped = await syncMetaAds(7, { lockWaitMs: 0 });
      expect(skipped.skipped).toBe(true);
      expect(skipped.ads).toBe(0);
      expect(fetchMetaAdsMock).not.toHaveBeenCalled();
    } finally {
      release();
      await holder;
    }
    // Замок снят — прогон идёт как обычно.
    const ran = await syncMetaAds(7, { lockWaitMs: 0 });
    expect(ran.skipped).toBeUndefined();
    expect(fetchMetaAdsMock).toHaveBeenCalled();
  });

  it("два параллельных прогона по одному объявлению: связи пишутся один раз, P2002 нет", async () => {
    const props = [await makeProperty(), await makeProperty()];
    const externalId = `rv-${runId}-parallel`;
    entities = [entity(externalId, props.map((p, i) => videoAbout(p, `q${i}`)))];
    stats = [];
    const ad = await prisma.ad.create({
      data: { platform: "META", externalId, name: "параллельный", adAccountId: "act_review", status: "PAUSED" },
    });
    externalIds.push(externalId);
    const items = props.map((p) => ({ propertyId: p.id, weight: 1, source: "FEED_CAPTION" as const }));
    // Обе записи стартуют разом: раньше обе видели пустую таблицу и обе делали create.
    const results = await Promise.allSettled([
      setAdProperties(ad.id, items, "FEED_CAPTION", { respectManual: true }),
      setAdProperties(ad.id, items, "FEED_CAPTION", { respectManual: true }),
      setAdProperties(ad.id, items, "FEED_CAPTION", { respectManual: true }),
    ]);
    expect(results.every((r) => r.status === "fulfilled")).toBe(true);
    expect(await prisma.adProperty.count({ where: { adId: ad.id } })).toBe(2);
  });

  it("ручная привязка, появившаяся пока шёл матчинг, не затирается машинной записью", async () => {
    const [machine, manual] = [await makeProperty(), await makeProperty()];
    const externalId = `rv-${runId}-race-manual`;
    externalIds.push(externalId);
    const ad = await prisma.ad.create({
      data: { platform: "META", externalId, name: "гонка с рукой", adAccountId: "act_review", status: "PAUSED" },
    });
    // Синхронизация прочитала matchSource = null и пошла матчить…
    // …а за это время маркетолог привязал объявление руками.
    await setAdProperties(ad.id, [{ propertyId: manual.id, weight: 5 }], "MANUAL");
    // Теперь машина дописывает своё решение — оно не должно пройти.
    await setAdProperties(ad.id, [{ propertyId: machine.id, weight: 1 }], "FEED_CAPTION", { respectManual: true });
    const after = await adOf(externalId);
    expect(after.properties.map((r) => [r.propertyId, r.source])).toEqual([[manual.id, "MANUAL"]]);
    expect(after.propertyId).toBe(manual.id);
    expect(after.matchSource).toBe("MANUAL");
  });
});

describe("п. 5 — карусель считается по карточкам", () => {
  it("карусель из 3 карточек с роликами → assetCount 3 после синхронизации (а не 6)", async () => {
    const [a, b] = [await makeProperty(), await makeProperty()];
    const creative = {
      object_story_spec: {
        link_data: {
          child_attachments: [
            { link: "https://site/1", name: "карточка 1", video_id: "cv1" },
            { link: "https://site/2", name: "карточка 2", video_id: "cv2" },
            { link: "https://site/3", name: "карточка 3", video_id: "cv3" },
          ],
        },
      },
    };
    const parsed = parseCreativeAssets(creative);
    expect(parsed).toHaveLength(3);
    // Подписи роликов — как их вписывает fetchMetaAds: про объекты a и b, третья без адреса.
    const withText: Asset[] = parsed.map((card, i) => ({
      ...card,
      text: i === 0 ? videoAbout(a, "x").text : i === 1 ? videoAbout(b, "y").text : "Просто красивый ролик",
    }));
    const externalId = `rv-${runId}-carousel`;
    entities = [entity(externalId, withText)];
    stats = [];
    await syncMetaAds();
    const ad = await adOf(externalId);
    expect(ad.assetCount).toBe(3);
    expect(Array.isArray(ad.creativeAssets) && ad.creativeAssets.length).toBe(3);
    expect(ad.properties.map((r) => r.propertyId).sort()).toEqual([a.id, b.id].sort());
  });
});

describe("п. 8 — архивные объявления: расход не теряется", () => {
  it("расход есть в insights, а в списке /ads объявления нет: строка из базы получает расход", async () => {
    const p = await makeProperty();
    const externalId = `rv-${runId}-archived-known`;
    entities = [entity(externalId, [videoAbout(p, "k0")])];
    stats = [];
    await syncMetaAds();
    const known = await adOf(externalId);

    // Объявление заархивировали: из списка исчезло, а расход за неделю у него был.
    entities = [];
    stats = [{ adId: externalId, date: "2026-08-19", spend: 7.5, impressions: 10, reach: 9, clicks: 1, conversations: 1 }];
    await syncMetaAds();
    const rows = await prisma.adSpendDaily.findMany({ where: { adId: known.id } });
    expect(rows).toHaveLength(1);
    expect(Number(rows[0].spend)).toBe(7.5);
    // Привязка прежняя — архивирование не отвязывает объект.
    expect((await adOf(externalId)).properties).toHaveLength(1);
  });

  it("объявления нет ни в списке, ни в базе: заводится по ad_id из insights, с пометкой «в архиве» и привязкой по №", async () => {
    const p = await makeProperty();
    const externalId = `rv-${runId}-archived-new`;
    externalIds.push(externalId);
    entities = [];
    stats = [
      {
        adId: externalId,
        adName: `Старая реклама №${p.shortId}`,
        campaignName: "Архивная кампания",
        date: "2026-08-19",
        spend: 3,
        impressions: 5,
        reach: 4,
        clicks: 1,
        conversations: 0,
      },
    ];
    const result = await syncMetaAds();
    expect(result.spendRows).toBe(1);
    const ad = await adOf(externalId);
    expect(ad.status).toBe("ARCHIVED");
    expect(ad.name).toContain(`№${p.shortId}`);
    expect(ad.properties.map((r) => r.propertyId)).toEqual([p.id]);
    const rows = await prisma.adSpendDaily.findMany({ where: { adId: ad.id } });
    expect(rows.map((r) => Number(r.spend))).toEqual([3]);
  });
});

describe("п. 12 — «давно не сверялись» живёт в кроне", () => {
  it("watchStaleSync: старая отметка — тревога один раз (ключ дедупа), свежая — тишина", async () => {
    await prisma.errorLog.deleteMany({ where: { source: "ads", message: { contains: "синхронизация рекламы была" } } });
    await prisma.settings.updateMany({
      where: { id: "singleton" },
      data: { metaAdsEnabled: true, metaAdsSyncedAt: new Date(Date.now() - 5 * 3_600_000) },
    });
    expect(await watchStaleSync()).toBe(true);
    expect(await watchStaleSync()).toBe(true);
    const logged = await prisma.errorLog.findMany({
      where: { source: "ads", message: { contains: "синхронизация рекламы была" } },
    });
    // Повторный вызов не плодит записи: одна строка (счётчик растёт в ней же).
    expect(logged).toHaveLength(1);

    await prisma.settings.updateMany({ where: { id: "singleton" }, data: { metaAdsSyncedAt: new Date() } });
    expect(await watchStaleSync()).toBe(false);
  });
});

describe("п. 9 — сверка связей Ad.propertyId ↔ AdProperty", () => {
  it("propertyId указан, а строк долей нет — SHARE_SUM_BROKEN; после починки хелпером — тишина", async () => {
    const p = await makeProperty();
    const externalId = `rv-${runId}-drift`;
    externalIds.push(externalId);
    const ad = await prisma.ad.create({
      data: { platform: "META", externalId, name: "дрейф связей", adAccountId: "act_review", status: "PAUSED", propertyId: p.id },
    });
    const range = { from: new Date("2025-01-01T00:00:00Z"), to: new Date("2025-01-02T00:00:00Z") };
    const broken = await buildReconcileReport(range, { credentials: null });
    expect(broken.issues.some((i) => i.kind === "SHARE_SUM_BROKEN" && i.adId === ad.id)).toBe(true);

    await setAdProperties(ad.id, [{ propertyId: p.id, weight: 1 }], "FEED_CAPTION");
    const fixed = await buildReconcileReport(range, { credentials: null });
    expect(fixed.issues.some((i) => i.kind === "SHARE_SUM_BROKEN" && i.adId === ad.id)).toBe(false);
  });
});

describe("п. 16 — «комнаты» и «цена» в подписи", () => {
  it("textHasRooms: «3 комнатная», «3-комнатная», «3-х комнатная», «3 хона» — да; «13 комнат» — нет", () => {
    for (const s of ["3 комнатная квартира", "3-комнатная", "3-х комнатная", "3х комнатная", "3 хона", "3 room flat"]) {
      expect(textHasRooms(s, 3), s).toBe(true);
    }
    expect(textHasRooms("13 комнат в общежитии", 3)).toBe(false);
    expect(textHasRooms("2 комнатная", 3)).toBe(false);
  });

  it("textHasPrice: отдельное число — да (слитно и с разделителями); внутри телефона или длинного числа — нет", () => {
    for (const s of ["цена 105000 долларов", "цена 105 000", "цена 105.000", "цена 105,000", "цена 105 000$"]) {
      expect(textHasPrice(s, 105000), s).toBe(true);
    }
    expect(textHasPrice("звоните +992 937 105000", 105000)).toBe(false);
    expect(textHasPrice("звоните +992930001040", 105000)).toBe(false);
    expect(textHasPrice("цена 1 105 000", 105000)).toBe(false);
    expect(textHasPrice("цена 1105000", 105000)).toBe(false);
    expect(textHasPrice("цена 105 0001", 105000)).toBe(false);
  });

  const props = [
    { id: "a", shortId: 1, address: "Рудаки, 15", price: 105000, rooms: 3, districtName: null },
    { id: "b", shortId: 2, address: "Сомони, 3", price: 50000, rooms: 2, districtName: null },
  ];

  it("matchByCaption: два признака (улица + комнаты) — объект найден; «13 комнат» признака не даёт", () => {
    expect(matchByCaption("Продаётся 3 комнатная квартира на Рудаки", props)).toBe("a");
    expect(matchByCaption("Продаётся 3-комнатная на Рудаки", props)).toBe("a");
    expect(matchByCaption("Продаётся 3 хона дар Рудаки", props)).toBe("a");
    expect(matchByCaption("Продаётся 13 комнат на Рудаки", props)).toBeNull();
  });

  it("matchByCaption: цена внутри телефона не засчитывается; настоящая цена + улица — засчитывается", () => {
    expect(matchByCaption("Рудаки, звоните +992 937 105000", props)).toBeNull();
    expect(matchByCaption("Рудаки, цена 105 000 долларов", props)).toBe("a");
    expect(matchByCaption("Рудаки, цена 105.000", props)).toBe("a");
  });

  it("на настоящей базе: матчер по подписи ролика — «13 комнат» не привязывает, «3 комнатная» привязывает", async () => {
    const p = await makeProperty(3);
    const matcher = await buildAdMatcher({ heal: false });
    const wrong = await matcher.matchAll(
      entity(`rv-${runId}-cap-wrong`, [{ kind: "video", id: "c0", text: `Общежитие, 13 комнат, улица ${p.street}` }])
    );
    expect(wrong.matches).toEqual([]);
    const right = await matcher.matchAll(
      entity(`rv-${runId}-cap-right`, [{ kind: "video", id: "c1", text: `3 комнатная квартира, улица ${p.street}` }])
    );
    expect(right.matches.map((m) => m.propertyId)).toEqual([p.id]);
    // Цена внутри телефона + улица = один признак → ничья доказательств, объект не найден.
    const phone = await matcher.matchAll(
      entity(`rv-${runId}-cap-phone`, [{ kind: "video", id: "c2", text: `Улица ${p.street}, звоните +992 90 ${p.price}` }])
    );
    expect(phone.matches).toEqual([]);
  });
});
