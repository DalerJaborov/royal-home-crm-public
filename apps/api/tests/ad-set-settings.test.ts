import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import { prisma } from "../src/db.js";
import {
  classifyGeoScope,
  durationDaysOf,
  parseAdSetSettings,
  saveAdSetSettings,
  type GraphAdSet,
} from "../src/lib/ads/adSetSettings.js";
import { fetchMetaAdSets, isRateLimitCode, MetaAdsTokenError } from "../src/lib/ads/metaAdsApi.js";

/**
 * НАСТРОЙКИ ГРУППЫ ОБЪЯВЛЕНИЙ ИЗ META (04.10.2026, слой обучения «Студии запуска рекламы»).
 *
 * Фикстуры — ответы Graph `/{act}/adsets` трёх видов, как они лежат в живом кабинете
 * агентства (docs/ads-launch-research-own-account-04-10.md): группа WhatsApp для Душанбе
 * 18–65, группа Advantage+ на всю страну и группа без таргетинга. Сеть замокана: fetch
 * подменён, в Meta ничего не уходит.
 */

const runId = Date.now().toString(36);
/** Только цифры в номере кабинета: parseAdAccountIds их и оставляет. */
const digits = String(Date.now()).slice(-9);
const acct = `act_${digits}`;
const adIds: string[] = [];

afterEach(() => vi.unstubAllGlobals());
afterAll(async () => {
  if (adIds.length > 0) await prisma.ad.deleteMany({ where: { id: { in: adIds } } });
  await prisma.errorLog.deleteMany({ where: { dedupKey: { contains: digits } } });
});

const WA_DUSHANBE: GraphAdSet = {
  id: "as-wa-dushanbe",
  name: "приемка дилафруз",
  destination_type: "WHATSAPP",
  optimization_goal: "CONVERSATIONS",
  bid_strategy: "LOWEST_COST_WITHOUT_CAP",
  billing_event: "IMPRESSIONS",
  daily_budget: "800",
  budget_remaining: "120",
  start_time: "2026-09-18T00:00:00+0500",
  end_time: "2026-10-05T00:00:00+0500",
  promoted_object: { page_id: "123", whatsapp_phone_number: "+992000000000" },
  targeting: {
    geo_locations: {
      cities: [{ key: "2430536", name: "Dushanbe", country: "TJ", radius: 10, distance_unit: "mile" }],
      location_types: ["home", "recent"],
    },
    age_min: 18,
    age_max: 65,
  },
};

const ADVANTAGE_TJ: GraphAdSet = {
  id: "as-adv-tj",
  destination_type: "MESSAGING_INSTAGRAM_DIRECT_WHATSAPP",
  optimization_goal: "CONVERSATIONS",
  bid_strategy: "LOWEST_COST_WITHOUT_CAP",
  billing_event: "IMPRESSIONS",
  lifetime_budget: "10500",
  start_time: "2026-09-18T00:00:00+0500",
  targeting: {
    geo_locations: { countries: ["TJ"], location_types: ["home", "recent"] },
    age_min: 18,
    age_max: 65,
    genders: [1, 2],
    publisher_platforms: ["facebook", "instagram"],
    instagram_positions: ["stream", "reels"],
    targeting_automation: { advantage_audience: 1 },
    custom_audiences: [{ id: "6001", name: "Секретная аудитория клиентов" }],
    flexible_spec: [{ interests: [{ id: "1", name: "Недвижимость" }] }],
    locales: [24],
  },
};

const BARE: GraphAdSet = { id: "as-bare", destination_type: "MESSENGER" };

describe("parseAdSetSettings: три вида ответа Graph", () => {
  it("группа WhatsApp для Душанбе 18–65, 8 $/день, 17 суток", () => {
    const p = parseAdSetSettings(WA_DUSHANBE);
    expect(p).toMatchObject({
      adsetId: "as-wa-dushanbe",
      destination: "WHATSAPP",
      optimizationGoal: "CONVERSATIONS",
      bidStrategy: "LOWEST_COST_WITHOUT_CAP",
      billingEvent: "IMPRESSIONS",
      // Бюджеты Meta отдаёт строкой и в минимальных единицах валюты: «800» = 8,00.
      dailyBudgetCents: 800,
      lifetimeBudgetCents: null,
      durationDays: 17,
      geoScope: "DUSHANBE",
      ageMin: 18,
      ageMax: 65,
      genders: [],
      // Метки Advantage+ в ответе нет — не выдумываем, а честно null.
      advantageAudience: null,
      placementsMode: "AUTOMATIC",
      platforms: [],
    });
    expect(p.startAt?.toISOString()).toBe("2026-09-17T19:00:00.000Z");
    expect(p.promotedObject).toMatchObject({ whatsapp_phone_number: "+992000000000" });
    expect(p.geoRaw).toMatchObject({ cities: [{ name: "Dushanbe", country: "TJ" }] });
  });

  it("группа Advantage+ на всю страну: бюджет на весь срок, плейсменты вручную, аудитории — числом", () => {
    const p = parseAdSetSettings(ADVANTAGE_TJ);
    expect(p).toMatchObject({
      destination: "MESSAGING_INSTAGRAM_DIRECT_WHATSAPP",
      dailyBudgetCents: null,
      lifetimeBudgetCents: 10500,
      // Нет конца — срок не посчитать, а не «0 суток».
      endAt: null,
      durationDays: null,
      geoScope: "TJ",
      advantageAudience: true,
      placementsMode: "MANUAL",
      platforms: ["facebook", "instagram"],
      // 1 и 2 вместе — «все»; храним как пришло, фильтруем только мусор.
      genders: [1, 2],
    });
    const raw = JSON.stringify(p.rawTargeting);
    expect(p.rawTargeting).toMatchObject({
      instagram_positions: ["stream", "reels"],
      custom_audiences_count: 1,
      flexible_spec_count: 1,
      targeting_automation: { advantage_audience: 1 },
    });
    // Названия аудиторий и интересов — данные о клиентах агентства, в базу не кладём.
    expect(raw).not.toContain("Секретная");
    expect(raw).not.toContain("Недвижимость");
  });

  it("группа без таргетинга и бюджета: всё пусто, ничего не падает", () => {
    const p = parseAdSetSettings(BARE);
    expect(p).toMatchObject({
      destination: "MESSENGER",
      dailyBudgetCents: null,
      lifetimeBudgetCents: null,
      durationDays: null,
      geoScope: null,
      geoRaw: null,
      ageMin: null,
      ageMax: null,
      genders: [],
      advantageAudience: null,
      placementsMode: null,
      platforms: [],
      promotedObject: null,
      rawTargeting: null,
    });
  });

  it("мусор в числах и датах не ломает разбор", () => {
    const p = parseAdSetSettings({
      id: "as-garbage",
      daily_budget: "много",
      lifetime_budget: "99999999999999",
      start_time: "2026-10-05T00:00:00+0500",
      end_time: "2026-10-01T00:00:00+0500",
      targeting: { age_min: "двадцать" as unknown as number, genders: [1, 7, "x"] as unknown as number[] },
    });
    expect(p.dailyBudgetCents).toBeNull();
    // Больше целого Postgres — не пишем: лучше пусто, чем ошибка записи всей строки.
    expect(p.lifetimeBudgetCents).toBeNull();
    expect(p.durationDays).toBeNull();
    expect(p.ageMin).toBeNull();
    expect(p.genders).toEqual([1]);
  });
});

describe("гео: страна, город, точка на карте", () => {
  it("классификация", () => {
    expect(classifyGeoScope({ countries: ["TJ"] })).toBe("TJ");
    expect(classifyGeoScope({ cities: [{ name: "Душанбе" }] })).toBe("DUSHANBE");
    // «Булавка» на улице: названия нет, но координаты внутри Душанбе.
    expect(classifyGeoScope({ custom_locations: [{ latitude: 38.5598, longitude: 68.787, radius: 1, country_code: "TJ" }] })).toBe("DUSHANBE");
    // Страна целиком покрывает свой город.
    expect(classifyGeoScope({ countries: ["TJ"], cities: [{ name: "Dushanbe", country: "TJ" }] })).toBe("TJ");
    expect(classifyGeoScope({ countries: ["RU"] })).toBe("OTHER");
    expect(classifyGeoScope({ cities: [{ name: "Khujand", country: "TJ" }] })).toBe("OTHER");
    expect(classifyGeoScope({ countries: ["RU"], cities: [{ name: "Dushanbe", country: "TJ" }] })).toBe("MIXED");
    expect(classifyGeoScope({})).toBeNull();
    expect(classifyGeoScope(undefined)).toBeNull();
  });

  it("срок в сутках — вверх, а не вниз", () => {
    const start = new Date("2026-10-02T00:00:00Z");
    expect(durationDaysOf(start, new Date("2026-10-09T00:00:00Z"))).toBe(7);
    expect(durationDaysOf(start, new Date("2026-10-02T06:00:00Z"))).toBe(1);
    expect(durationDaysOf(start, null)).toBeNull();
  });
});

describe("fetchMetaAdSets: чтение и откат на базовый набор", () => {
  const creds = { enabled: true, token: "t", adAccountIds: [acct] };
  const json = (body: unknown, status = 200) =>
    new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
  const fieldError = { error: { message: "(#100) Tried accessing nonexisting field (promoted_object) on node type (AdSet)", code: 100 } };

  it("богатый набор: targeting просим целиком, страницы склеиваются", async () => {
    const urls: string[] = [];
    const fetchMock = vi.fn(async (url: string) => {
      urls.push(String(url));
      if (urls.length === 1) {
        return json({ data: [WA_DUSHANBE], paging: { next: `https://graph.facebook.com/next-page?access_token=t` } });
      }
      return json({ data: [ADVANTAGE_TJ, BARE] });
    });
    vi.stubGlobal("fetch", fetchMock);

    const res = await fetchMetaAdSets(creds, acct);
    expect(res.partial).toBe(false);
    expect(Array.from(res.byId.keys())).toEqual(["as-wa-dushanbe", "as-adv-tj", "as-bare"]);
    expect(urls[0]).toContain(`/${acct}/adsets?`);
    const fields = decodeURIComponent(urls[0].match(/fields=([^&]+)/)![1]);
    for (const f of [
      "daily_budget",
      "lifetime_budget",
      "budget_remaining",
      "bid_strategy",
      "billing_event",
      "optimization_goal",
      "destination_type",
      "promoted_object",
      "start_time",
      "end_time",
      "targeting",
    ]) {
      expect(fields.split(",")).toContain(f);
    }
    // Все статусы, включая архив: у остановленных групп тоже есть расход и история.
    expect(decodeURIComponent(urls[0])).toContain("ARCHIVED");
  });

  it("Meta отказала на богатых полях → базовый набор, partial, запись в журнал, синхронизация не падает", async () => {
    const urls: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        urls.push(String(url));
        // Первый запрос (с targeting) отклонён, второй (базовый набор) проходит.
        return urls.length === 1 ? json(fieldError, 400) : json({ data: [{ id: "as-base", destination_type: "WHATSAPP", daily_budget: "500" }] });
      })
    );
    const res = await fetchMetaAdSets(creds, acct);
    expect(res.partial).toBe(true);
    expect(res.byId.get("as-base")?.daily_budget).toBe("500");
    expect(urls).toHaveLength(2);
    expect(decodeURIComponent(urls[1])).not.toContain("targeting");

    await vi.waitFor(async () => {
      const log = await prisma.errorLog.findFirst({ where: { source: "ads", dedupKey: `ads-adset-fallback:${acct}:0` } });
      expect(log).not.toBeNull();
      expect(log?.message).toContain("таргетинг");
    });
  });

  it("не принят и фильтр статусов → третий путь без него", async () => {
    const urls: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        urls.push(String(url));
        return urls.length <= 2 ? json(fieldError, 400) : json({ data: [{ id: "as-nofilter" }] });
      })
    );
    const res = await fetchMetaAdSets(creds, acct);
    expect(res.partial).toBe(true);
    expect(res.byId.has("as-nofilter")).toBe(true);
    expect(decodeURIComponent(urls[2])).not.toContain("effective_status");
  });

  it("не прочиталось совсем → пустой результат и запись в журнал, без исключения", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => json(fieldError, 400)));
    const res = await fetchMetaAdSets(creds, acct);
    expect(res.byId.size).toBe(0);
    expect(res.partial).toBe(true);
    // Запись в журнал фоновая (void logSystemError) — ждём, пока она ляжет.
    await vi.waitFor(async () => {
      const log = await prisma.errorLog.findFirst({ where: { source: "ads", dedupKey: `ads-adset-failed:${acct}` } });
      expect(log).not.toBeNull();
    });
  });

  it("лимит запросов Meta (код 17): откат на облегчённые наборы НЕ делается — один запрос, пропуск и запись в журнал", async () => {
    const urls: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        urls.push(String(url));
        return json({ error: { message: "(#17) User request limit reached", code: 17 } }, 400);
      })
    );
    const res = await fetchMetaAdSets(creds, acct);
    expect(urls).toHaveLength(1);
    expect(res).toMatchObject({ partial: true, skipped: "rate_limit" });
    expect(res.byId.size).toBe(0);
    await vi.waitFor(async () => {
      const log = await prisma.errorLog.findFirst({ where: { source: "ads", dedupKey: `ads-adset-ratelimit:${acct}` } });
      expect(log).not.toBeNull();
    });
  });

  it("все коды лимита (4, 17, 32, 613, 80004) распознаются, обычные ошибки — нет", () => {
    for (const code of [4, 17, 32, 613, 80000, 80004, 80014]) expect(isRateLimitCode(code)).toBe(true);
    for (const code of [100, 190, 200, 2, undefined]) expect(isRateLimitCode(code)).toBe(false);
  });

  it("выборка по статусам: действующие и остальные просят разные effective_status, третьего пути «без фильтра» нет", async () => {
    const urls: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        urls.push(decodeURIComponent(String(url)));
        return json({ data: [{ id: "x" }] });
      })
    );
    await fetchMetaAdSets(creds, acct, { scope: "active" });
    await fetchMetaAdSets(creds, acct, { scope: "inactive" });
    expect(urls[0]).toContain("ACTIVE");
    expect(urls[0]).not.toContain("ARCHIVED");
    expect(urls[1]).toContain("ARCHIVED");
    expect(urls[1]).not.toContain('"ACTIVE"');

    // Фильтр статусов не принят: у выборки по статусам нет запасного пути без фильтра (он прочитал бы ВСЁ).
    const attempts: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        attempts.push(String(url));
        return json(fieldError, 400);
      })
    );
    await fetchMetaAdSets(creds, acct, { scope: "active" });
    expect(attempts).toHaveLength(2);
  });

  it("умерший маркер (190) — единственное, что пробрасывается наверх", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => json({ error: { message: "Error validating access token", code: 190 } }, 400)));
    await expect(fetchMetaAdSets(creds, acct)).rejects.toBeInstanceOf(MetaAdsTokenError);
  });
});

describe("saveAdSetSettings: запись и частичный ответ", () => {
  async function makeAd(): Promise<string> {
    const ad = await prisma.ad.create({
      data: { platform: "META", externalId: `adset-save-${runId}-${adIds.length}`, name: `Тест настроек ${runId}` },
    });
    adIds.push(ad.id);
    return ad.id;
  }

  it("одна строка на объявление; повторная запись обновляет, а не плодит", async () => {
    const adId = await makeAd();
    await saveAdSetSettings(adId, parseAdSetSettings(WA_DUSHANBE));
    await saveAdSetSettings(adId, parseAdSetSettings({ ...WA_DUSHANBE, daily_budget: "1200" }));
    const rows = await prisma.adSetSettings.findMany({ where: { adId } });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ destination: "WHATSAPP", dailyBudgetCents: 1200, geoScope: "DUSHANBE", ageMin: 18, durationDays: 17 });
  });

  it("облегчённый ответ не затирает уже записанный таргетинг пустым", async () => {
    const adId = await makeAd();
    await saveAdSetSettings(adId, parseAdSetSettings(ADVANTAGE_TJ));
    // Meta отказала на targeting: в ответе только базовые поля, бюджет изменился.
    await saveAdSetSettings(adId, parseAdSetSettings({ id: ADVANTAGE_TJ.id, destination_type: "WHATSAPP", daily_budget: "700" }), true);
    const row = await prisma.adSetSettings.findUniqueOrThrow({ where: { adId } });
    expect(row.destination).toBe("WHATSAPP");
    expect(row.dailyBudgetCents).toBe(700);
    expect(row.geoScope).toBe("TJ");
    expect(row.advantageAudience).toBe(true);
    expect(row.platforms).toEqual(["facebook", "instagram"]);
  });

  it("настройки уходят вместе с объявлением (каскад)", async () => {
    const adId = await makeAd();
    await saveAdSetSettings(adId, parseAdSetSettings(BARE));
    await prisma.ad.delete({ where: { id: adId } });
    adIds.splice(adIds.indexOf(adId), 1);
    expect(await prisma.adSetSettings.count({ where: { adId } })).toBe(0);
  });
});
