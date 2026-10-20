import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { prisma } from "../src/db.js";
import type { GraphAdSet } from "../src/lib/ads/adSetSettings.js";

/**
 * СИНХРОНИЗАЦИЯ ПИШЕТ НАСТРОЙКИ ГРУППЫ (04.10.2026): AdSetSettings заполняется на каждом
 * прогоне, отказ чтения групп (или записи) синхронизацию расходов НЕ роняет, а облегчённый
 * ответ Meta не стирает прежде записанный таргетинг. Graph и лента Instagram замоканы.
 */

vi.mock("../src/messengers/instagramFeed.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/messengers/instagramFeed.js")>()),
  getAllOwnMedia: vi.fn(async () => []),
  getInstagramMedia: vi.fn(async () => []),
}));

const runId = Date.now().toString(36);
const AD_ID = `as-sync-${runId}`;
const ADSET_ID = `adset-${runId}`;

const entity = {
  id: AD_ID,
  name: `Тест настроек группы ${runId}`,
  campaignId: "camp-s",
  campaignName: "Вовлечённость",
  adsetId: ADSET_ID,
  adsetName: "приемка дилафруз",
  postUrl: null,
  mediaId: null,
  storyId: null,
  thumbnailUrl: null,
  caption: null,
  createdTime: null,
  startTime: null,
  stopTime: null,
  status: "ACTIVE",
  objective: "OUTCOME_ENGAGEMENT",
  assets: [],
};
const stats = [{ adId: AD_ID, date: "2026-10-03", spend: 8, impressions: 5000, reach: 4000, clicks: 80, conversations: 13 }];

let adSetsImpl: () => Promise<{ byId: Map<string, GraphAdSet>; partial: boolean; skipped?: "rate_limit" | "failed" }>;

vi.mock("../src/lib/ads/metaAdsApi.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/lib/ads/metaAdsApi.js")>()),
  loadMetaAdsCredentials: vi.fn(async () => ({ enabled: true, token: "test-token", adAccountIds: ["act_77"] })),
  isMetaAdsConfigured: () => true,
  fetchMetaAds: vi.fn(async () => [entity]),
  fetchMetaAdSets: vi.fn(async () => adSetsImpl()),
  fetchMetaAdDailyStats: vi.fn(async () => stats),
  fetchAdAccountCurrency: vi.fn(async () => "USD" as const),
  fetchAccountSpendTotal: vi.fn(async () => 8),
  parseAdAccountIds: (raw: string | null) =>
    (raw ?? "").split(/[\s,;]+/).filter(Boolean).map((p) => `act_${p.replace(/\D/g, "")}`),
  MetaAdsTokenError: class MetaAdsTokenError extends Error {},
}));

const { syncMetaAds, resetAdSetReadThrottle } = await import("../src/lib/ads/syncMetaAds.js");
const metaApi = await import("../src/lib/ads/metaAdsApi.js");

const FULL: GraphAdSet = {
  id: ADSET_ID,
  destination_type: "WHATSAPP",
  optimization_goal: "CONVERSATIONS",
  bid_strategy: "LOWEST_COST_WITHOUT_CAP",
  billing_event: "IMPRESSIONS",
  daily_budget: "800",
  start_time: "2026-09-18T00:00:00+0500",
  end_time: "2026-10-05T00:00:00+0500",
  targeting: { geo_locations: { cities: [{ key: "1", name: "Dushanbe", country: "TJ" }] }, age_min: 18, age_max: 65 },
};

async function settingsRow() {
  const ad = await prisma.ad.findUnique({
    where: { platform_externalId: { platform: "META", externalId: AD_ID } },
    select: { id: true, adSetSettings: true, spend: { select: { spend: true, conversations: true } } },
  });
  return ad;
}

beforeEach(() => {
  adSetsImpl = async () => ({ byId: new Map([[ADSET_ID, FULL]]), partial: false });
});

afterAll(async () => {
  await prisma.ad.deleteMany({ where: { externalId: AD_ID } });
});

describe("syncMetaAds → AdSetSettings", () => {
  it("прогон записывает настройки группы вместе с расходом", async () => {
    const result = await syncMetaAds(7, { lockWaitMs: 120_000 });
    expect(result.ads).toBe(1);
    expect(result.spendRows).toBe(1);
    const ad = await settingsRow();
    expect(ad?.adSetSettings).toMatchObject({
      adsetId: ADSET_ID,
      // Валюта кабинета сохраняется рядом с бюджетом: бюджет Meta отдаёт в её минимальных единицах.
      currency: "USD",
      destination: "WHATSAPP",
      optimizationGoal: "CONVERSATIONS",
      dailyBudgetCents: 800,
      durationDays: 17,
      geoScope: "DUSHANBE",
      ageMin: 18,
      ageMax: 65,
      placementsMode: "AUTOMATIC",
    });
    expect(ad?.spend).toHaveLength(1);
  });

  it("повторный прогон не плодит строки: одна на объявление, значения обновляются", async () => {
    adSetsImpl = async () => ({ byId: new Map([[ADSET_ID, { ...FULL, daily_budget: "1000" }]]), partial: false });
    await syncMetaAds(7, { lockWaitMs: 120_000 });
    const ad = await settingsRow();
    expect(await prisma.adSetSettings.count({ where: { adId: ad!.id } })).toBe(1);
    expect(ad?.adSetSettings?.dailyBudgetCents).toBe(1000);
  });

  it("облегчённый ответ Meta обновляет базовые поля, но не стирает таргетинг", async () => {
    adSetsImpl = async () => ({
      byId: new Map([[ADSET_ID, { id: ADSET_ID, destination_type: "INSTAGRAM_DIRECT", daily_budget: "500" }]]),
      partial: true,
    });
    await syncMetaAds(7, { lockWaitMs: 120_000 });
    const row = (await settingsRow())?.adSetSettings;
    expect(row).toMatchObject({ destination: "INSTAGRAM_DIRECT", dailyBudgetCents: 500, geoScope: "DUSHANBE", ageMin: 18 });
  });

  it("группы не прочитались (исключение) — расход всё равно синхронизируется, настройки целы", async () => {
    adSetsImpl = async () => {
      throw new Error("Marketing API: (#100) Tried accessing nonexisting field");
    };
    const result = await syncMetaAds(7, { lockWaitMs: 120_000 });
    expect(result.skipped).toBeUndefined();
    expect(result.spendRows).toBe(1);
    const row = (await settingsRow())?.adSetSettings;
    expect(row?.geoScope).toBe("DUSHANBE");
  });

  it("группы пусты (Meta не отдала) — настройки прежние, ничего не удалено", async () => {
    adSetsImpl = async () => ({ byId: new Map(), partial: true });
    await syncMetaAds(7, { lockWaitMs: 120_000 });
    const row = (await settingsRow())?.adSetSettings;
    expect(row?.destination).toBe("INSTAGRAM_DIRECT");
  });
});

describe("нагрузка на Meta: настройки групп", () => {
  const scopesCalled = () => vi.mocked(metaApi.fetchMetaAdSets).mock.calls.map((c) => (c[2] as { scope?: string } | undefined)?.scope);

  it("действующие группы — каждым прогоном, остановленные и архивные — не чаще раза в сутки", async () => {
    resetAdSetReadThrottle();
    vi.mocked(metaApi.fetchMetaAdSets).mockClear();
    await syncMetaAds(7, { lockWaitMs: 120_000 });
    await syncMetaAds(7, { lockWaitMs: 120_000 });
    // Первый прогон читает обе выборки, второй — только действующие.
    expect(scopesCalled()).toEqual(["active", "inactive", "active"]);
  });

  it("лимит запросов Meta на действующих группах — второй запрос в этом прогоне не делается, расход синхронизируется", async () => {
    resetAdSetReadThrottle();
    vi.mocked(metaApi.fetchMetaAdSets).mockClear();
    adSetsImpl = async () => ({ byId: new Map(), partial: true, skipped: "rate_limit" as const });
    const result = await syncMetaAds(7, { lockWaitMs: 120_000 });
    expect(scopesCalled()).toEqual(["active"]);
    expect(result.spendRows).toBe(1);
  });
});
