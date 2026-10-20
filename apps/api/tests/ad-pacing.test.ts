import bcrypt from "bcrypt";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { deleteAgentsWithTraces } from "./helpers/cleanupAgents.js";

/**
 * Темп расхода и прогноз (03.10.2026, GET /ads/pacing): чистая функция на фикстурах
 * (начало месяца, мало данных, нулевой расход, флаги, граница суток по Душанбе, високосный
 * февраль) и сборка из настоящей базы. Деньги в базовых тестах — сомони, чтобы не зависеть
 * от курса; строки в июле 2024 — окно, где в общей базе нет чужих данных.
 */

vi.mock("../src/lib/ads/metaAdsApi.js", async (importOriginal) => {
  class MetaAdsTokenError extends Error {}
  return {
    ...(await importOriginal<typeof import("../src/lib/ads/metaAdsApi.js")>()),
    loadMetaAdsCredentials: vi.fn(async () => ({ enabled: false, token: null, adAccountIds: [] })),
    isMetaAdsConfigured: () => false,
    fetchAdAccountDetails: vi.fn(async () => null),
    fetchMetaAds: vi.fn(async () => []),
    fetchMetaAdSets: vi.fn(async () => ({ byId: new Map(), partial: false })),
    fetchMetaAdDailyStats: vi.fn(async () => []),
    fetchAdAccountCurrency: vi.fn(async () => "USD" as const),
    fetchAccountSpendTotal: vi.fn(async () => 0),
    parseAdAccountIds: (raw: string | null) =>
      (raw ?? "").split(/[\s,;]+/).filter(Boolean).map((p) => `act_${p.replace(/\D/g, "")}`),
    MetaAdsTokenError,
  };
});
vi.mock("../src/lib/ads/syncMetaAds.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/lib/ads/syncMetaAds.js")>()),
  FULL_SYNC_DAYS: 90,
  syncMetaAds: vi.fn(async () => ({ days: 7, ads: 0, matched: 0, foreign: 0, spendRows: 0 })),
  syncMetaAdsQuietly: vi.fn(async () => null),
}));
vi.mock("../src/messengers/instagramFeed.js", () => ({
  getAllOwnMedia: vi.fn(async () => []),
  getInstagramMedia: vi.fn(async () => []),
  refreshInstagramTokenIfDue: vi.fn(async () => false),
}));
vi.mock("../src/lib/ads/adInsights.js", () => ({
  buildAdInsights: vi.fn(async () => null),
  hasAdData: vi.fn(async () => false),
  _clearInsightsCache: vi.fn(),
}));

const { app } = await import("../src/app.js");
const { prisma } = await import("../src/db.js");
const { computePacing, buildAdPacing } = await import("../src/lib/ads/adPacing.js");
const { adSpendToTjsCents, fromCents, loadMoneyContext } = await import("../src/lib/money.js");

import type { AdAccountDetails } from "../src/lib/ads/metaAdsApi.js";

const MONEY = { usdToTjs: 10 };
type DayRows = Map<string, { spend: number; currency: string }[]>;

/** Дни ГГГГ-ММ-ДД → сомони (строка одной валюты). */
function days(entries: Record<string, number>): DayRows {
  return new Map(Object.entries(entries).map(([k, v]) => [k, [{ spend: v, currency: "TJS" }]]));
}

/** Диапазон дней месяца с одним значением: range("2024-07", 1, 7, 10). */
function range(month: string, from: number, to: number, value: number | ((day: number) => number)): Record<string, number> {
  const out: Record<string, number> = {};
  for (let d = from; d <= to; d++) {
    out[`${month}-${String(d).padStart(2, "0")}`] = typeof value === "function" ? value(d) : value;
  }
  return out;
}

/** 15 июля 2024, 12:00 по Душанбе (= 07:00 UTC). */
const NOON_15 = new Date("2024-07-15T07:00:00.000Z");
const FRESH = new Date("2024-07-15T06:30:00.000Z");

const base = { money: MONEY, enabledAds: 0, syncedAt: FRESH, enabled: true, accounts: null };

describe("computePacing — прогноз", () => {
  it("середина месяца: потрачено + темп × остаток; вилка по 25-му и 75-му перцентилям дней недели", () => {
    // 1–7 июля по 10; 8–14: 6, 14, 8, 12 и три раза по 10 (среднее 10); сегодня (15-е) пока 4.
    const rows = days({
      ...range("2024-07", 1, 7, 10),
      ...range("2024-07", 8, 14, (d) => ({ 8: 6, 9: 14, 10: 8, 11: 12 } as Record<number, number>)[d] ?? 10),
      "2024-07-15": 4,
    });
    const r = computePacing({ ...base, now: NOON_15, days: rows });
    expect(r.today).toBe("2024-07-15");
    expect(r.todayTjs).toBe(4);
    expect(r.usualDayTjs).toBe(10);
    expect(r.monthSpentTjs).toBe(144);
    expect(r.daysInMonth).toBe(31);
    expect(r.dayOfMonth).toBe(15);
    expect(r.forecastState).toBe("ok");
    // remaining = 16; ожидаемое: 144 + 10×16 + (10 − 4) дотянет сегодня = 310.
    // Дни недели по возрастанию: 6, 8, 10, 10, 10, 12, 14 → 25-й перцентиль 9, 75-й 11 (не 6 и 14).
    // низ: 144 + 9×16 + (9 − 4) = 293; верх: 144 + 11×16 + (11 − 4) = 327.
    expect(r.forecast).toEqual({
      expectedTjs: 310,
      lowTjs: 293,
      highTjs: 327,
      remainingDays: 16,
      rangeState: "percentile",
    });
    expect(r.forecast!.lowTjs).toBeLessThanOrEqual(r.forecast!.expectedTjs);
    expect(r.forecast!.expectedTjs).toBeLessThanOrEqual(r.forecast!.highTjs);
    // График месяца: 15 точек без пропусков.
    expect(r.series).toHaveLength(15);
    expect(r.series[14]).toEqual({ date: "2024-07-15", spendTjs: 4 });
  });

  it("начало месяца: «обычный день» берётся из прошлого месяца, потрачено — только сегодняшнее", () => {
    const now = new Date("2024-07-01T07:00:00.000Z"); // 1 июля, 12:00 по Душанбе
    const rows = days({ ...range("2024-06", 24, 30, 10), "2024-07-01": 3 });
    const r = computePacing({ ...base, now, days: rows, syncedAt: new Date("2024-07-01T06:00:00.000Z") });
    expect(r.today).toBe("2024-07-01");
    expect(r.dayOfMonth).toBe(1);
    expect(r.usualDayTjs).toBe(10);
    expect(r.monthSpentTjs).toBe(3);
    // 3 + 10 × 30 + (10 − 3) = 310.
    expect(r.forecast).toMatchObject({ expectedTjs: 310, remainingDays: 30 });
    expect(r.series).toEqual([{ date: "2024-07-01", spendTjs: 3 }]);
  });

  it("мало данных (строки Meta есть меньше чем за три дня из семи) — прогноза нет, и флаг «вдвое» не поднимается", () => {
    const rows = days({ "2024-07-13": 100, "2024-07-14": 100, "2024-07-15": 900 });
    const r = computePacing({ ...base, now: NOON_15, days: rows });
    expect(r.baselineDaysWithData).toBe(2);
    expect(r.forecastState).toBe("insufficient");
    expect(r.forecast).toBeNull();
    expect(r.flags.find((f) => f.kind === "SPEND_DOUBLE")).toBeUndefined();
  });

  it("кампания запущена 3 дня назад по 100 с. в день: обычный день 100, прогноз без занижения, ложного флага нет", () => {
    // 12–14 июля по 100, сегодня (15-е) 100: делить на семь дней нельзя — это дало бы «обычный» 43 и ложное «вдвое».
    const rows = days({ ...range("2024-07", 12, 14, 100), "2024-07-15": 100 });
    const r = computePacing({ ...base, now: NOON_15, days: rows });
    expect(r.baselineDaysWithData).toBe(3);
    expect(r.usualDayTjs).toBe(100);
    expect(r.ratioToUsual).toBe(1);
    expect(r.flags.map((f) => f.kind)).not.toContain("SPEND_DOUBLE");
    expect(r.forecastState).toBe("ok");
    // потрачено 400 + 100 × 16 остаток; сегодняшний день уже дотянул до обычного.
    // Данных меньше 5 дней — вилки нет: только точечный прогноз с пометкой.
    expect(r.forecast).toEqual({
      expectedTjs: 2000,
      lowTjs: 2000,
      highTjs: 2000,
      remainingDays: 16,
      rangeState: "too_few_days",
    });
  });

  it("вилка берёт только дни со строками Meta: дни без строк не «нулевые траты»", () => {
    // Строки за 8, 9, 10, 11 и 14 июля (12-го и 13-го Meta ничего не прислала), сегодня 100.
    const rows = days({
      "2024-07-08": 60,
      "2024-07-09": 100,
      "2024-07-10": 120,
      "2024-07-11": 80,
      "2024-07-14": 140,
      "2024-07-15": 100,
    });
    const r = computePacing({ ...base, now: NOON_15, days: rows });
    expect(r.baselineDaysWithData).toBe(5);
    // 500 за семь суток от первого дня данных (пропуски — нули в среднем): 71,43.
    expect(r.usualDayTjs).toBe(71.43);
    expect(r.forecast!.rangeState).toBe("percentile");
    // Дни со строками: 60, 80, 100, 120, 140 → 75-й перцентиль 120: 600 + 120×16 + (120 − 100) = 2540.
    expect(r.forecast!.highTjs).toBe(2540);
    // Если бы пропуски считались нулями, 25-й перцентиль упал бы до 30 и низ вилки — до 1080.
    // Перцентиль по дням со строками (80) выше прогноза 1742,88, и край не заходит за прогноз.
    expect(r.forecast!.expectedTjs).toBe(1742.88);
    expect(r.forecast!.lowTjs).toBe(1742.88);
  });

  it("вилка не растягивается одним тихим и одним дорогим днём (случай прода 03.10)", () => {
    // Неделя: пять обычных дней по 100, воскресенье 20 и один всплеск 600. По min/max вилка
    // была «от 20 до 600 в день»; по перцентилям — по обычным дням.
    const rows = days({
      ...range("2024-07", 1, 7, 100),
      "2024-07-08": 100,
      "2024-07-09": 100,
      "2024-07-10": 100,
      "2024-07-11": 100,
      "2024-07-12": 20,
      "2024-07-13": 600,
      "2024-07-14": 100,
      "2024-07-15": 100,
    });
    const r = computePacing({ ...base, now: NOON_15, days: rows });
    const f = r.forecast!;
    const monthSpent = r.monthSpentTjs;
    expect(f.rangeState).toBe("percentile");
    expect(f.lowTjs).toBeLessThanOrEqual(f.expectedTjs);
    expect(f.expectedTjs).toBeLessThanOrEqual(f.highTjs);
    // Старая вилка: потрачено + 20 × 16 … потрачено + 600 × 16 (≥ 9 280 шириной); новая в разы уже.
    expect(f.highTjs - f.lowTjs).toBeLessThan((600 - 20) * 16 * 0.25);
    expect(f.lowTjs).toBeGreaterThan(monthSpent + 20 * 16);
    expect(f.highTjs).toBeLessThan(monthSpent + 600 * 16);
  });

  it("четыре дня данных — вилки нет, пять — есть", () => {
    const four = days({ ...range("2024-07", 11, 14, 100), "2024-07-15": 100 });
    const rFour = computePacing({ ...base, now: NOON_15, days: four });
    expect(rFour.baselineDaysWithData).toBe(4);
    expect(rFour.forecastState).toBe("ok");
    expect(rFour.forecast).toMatchObject({ rangeState: "too_few_days" });
    expect(rFour.forecast!.lowTjs).toBe(rFour.forecast!.expectedTjs);
    expect(rFour.forecast!.highTjs).toBe(rFour.forecast!.expectedTjs);

    const five = days({ ...range("2024-07", 10, 14, 100), "2024-07-15": 100 });
    const rFive = computePacing({ ...base, now: NOON_15, days: five });
    expect(rFive.baselineDaysWithData).toBe(5);
    expect(rFive.forecast).toMatchObject({ rangeState: "percentile" });
  });

  it("совсем нет строк: нули, без прогноза и без деления на ноль", () => {
    const r = computePacing({ ...base, now: NOON_15, days: new Map() });
    expect(r).toMatchObject({ todayTjs: 0, usualDayTjs: 0, monthSpentTjs: 0, ratioToUsual: null, forecast: null });
    expect(r.series).toHaveLength(15);
    expect(r.series.every((p) => p.spendTjs === 0)).toBe(true);
  });

  it("нулевой расход при живых строках Meta: прогноз равен уже потраченному, вилка схлопнута", () => {
    const rows = days({ ...range("2024-07", 1, 15, 0) });
    const r = computePacing({ ...base, now: NOON_15, days: rows });
    expect(r.forecastState).toBe("no_spend");
    expect(r.forecast).toEqual({ expectedTjs: 0, lowTjs: 0, highTjs: 0, remainingDays: 16 });
    expect(r.ratioToUsual).toBeNull();
  });

  it("последний день високосного февраля: впереди ноль дней, прогноз не выходит за потраченное с остатком сегодняшнего", () => {
    const now = new Date("2024-02-29T07:00:00.000Z");
    const rows = days({ ...range("2024-02", 1, 28, 10), "2024-02-29": 10 });
    const r = computePacing({ ...base, now, days: rows, syncedAt: new Date("2024-02-29T06:00:00.000Z") });
    expect(r.daysInMonth).toBe(29);
    expect(r.forecast).toMatchObject({ expectedTjs: 290, remainingDays: 0 });
  });

  it("граница суток: 01:00 по Душанбе 15-го — это уже 15-е (а по UTC было бы 14-е)", () => {
    const now = new Date("2024-07-14T20:00:00.000Z");
    const r = computePacing({ ...base, now, days: new Map() });
    expect(r.today).toBe("2024-07-15");
  });
});

const account0: AdAccountDetails = {
  id: "act_1",
  name: "Кабинет",
  currency: "USD",
  fundingSource: null,
  balance: null,
  spendCap: null,
  timezone: "Asia/Dushanbe",
  amountSpent: null,
  accountStatus: 1,
  disableReason: 0,
};

describe("computePacing — флаги", () => {
  const steady = range("2024-07", 1, 14, 10);

  it("сегодня больше чем вдвое выше обычного — красный флаг; ровно вдвое — ещё нет", () => {
    const over = computePacing({ ...base, now: NOON_15, days: days({ ...steady, "2024-07-15": 21 }) });
    expect(over.ratioToUsual).toBe(2.1);
    expect(over.flags.map((f) => f.kind)).toContain("SPEND_DOUBLE");
    const exactly = computePacing({ ...base, now: NOON_15, days: days({ ...steady, "2024-07-15": 20 }) });
    expect(exactly.flags.map((f) => f.kind)).not.toContain("SPEND_DOUBLE");
  });

  it("обычный день меньше порога (шум) — «вдвое» не поднимаем", () => {
    const tiny = computePacing({ ...base, now: NOON_15, days: days({ ...range("2024-07", 1, 14, 3), "2024-07-15": 9 }) });
    expect(tiny.flags.map((f) => f.kind)).not.toContain("SPEND_DOUBLE");
  });

  it("нет расхода сегодня при включённых объявлениях — флаг после полудня и только на свежих данных", () => {
    const rows = days(steady);
    const flagged = computePacing({ ...base, now: NOON_15, days: rows, enabledAds: 3 });
    expect(flagged.flags.map((f) => f.kind)).toContain("NO_SPEND_TODAY");
    expect(flagged.dataStale).toBe(false);

    // Утро (10:00 по Душанбе): Meta ещё не прислала сегодняшнее — не тревожим.
    const morning = computePacing({ ...base, now: new Date("2024-07-15T05:00:00.000Z"), days: rows, enabledAds: 3 });
    expect(morning.flags.map((f) => f.kind)).not.toContain("NO_SPEND_TODAY");

    // Данные старые: не утверждаем «расхода нет», говорим, что данные несвежие.
    const stale = computePacing({ ...base, now: NOON_15, days: rows, enabledAds: 3, syncedAt: new Date("2024-07-14T00:00:00.000Z") });
    expect(stale.dataStale).toBe(true);
    expect(stale.flags.map((f) => f.kind)).not.toContain("NO_SPEND_TODAY");

    // Кабинет в Америке: в полдень по Душанбе у него ещё ночь, пустое «сегодня» — не тревога.
    const la = { ...account0, timezone: "America/Los_Angeles" };
    const laNoon = computePacing({ ...base, now: NOON_15, days: rows, enabledAds: 3, accounts: [la] });
    expect(laNoon.flags.map((f) => f.kind)).not.toContain("NO_SPEND_TODAY");
    // Тот же день позже вечером по Душанбе (22:00; в Лос-Анджелесе 10:00): сутки кабинета пошли — тревога честная.
    const laEvening = computePacing({
      ...base,
      now: new Date("2024-07-15T17:00:00.000Z"),
      syncedAt: new Date("2024-07-15T16:30:00.000Z"),
      days: rows,
      enabledAds: 3,
      accounts: [la],
    });
    expect(laEvening.flags.map((f) => f.kind)).toContain("NO_SPEND_TODAY");

    // Нет включённых объявлений — нечего ждать.
    const none = computePacing({ ...base, now: NOON_15, days: rows, enabledAds: 0 });
    expect(none.flags.map((f) => f.kind)).not.toContain("NO_SPEND_TODAY");
  });
});

describe("computePacing — кабинеты", () => {
  const account: AdAccountDetails = {
    id: "act_1",
    name: "Кабинет",
    currency: "USD",
    fundingSource: "Visa •• 4242",
    balance: 200,
    spendCap: 1000,
    timezone: "America/Los_Angeles",
    amountSpent: 900,
    accountStatus: 1,
    disableReason: 0,
  };

  it("долг, карта, лимит и дни до лимита; долг выше порога поднимает красный флаг тем же правилом, что уведомление", () => {
    const rows = days(range("2024-07", 1, 15, 100));
    const r = computePacing({ ...base, now: NOON_15, days: rows, accounts: [account] });
    expect(r.accounts).toHaveLength(1);
    expect(r.accounts![0]).toMatchObject({
      fundingSource: "Visa •• 4242",
      balance: 200,
      balanceTjs: 2000, // 200 $ × 10
      capLeftTjs: 1000, // 100 $ × 10
      daysToCap: 10, // 1000 / обычный день 100
    });
    expect(r.flags.some((f) => f.kind === "ACCOUNT_DEBT")).toBe(true);
    expect(r.cabinetTimezones).toEqual(["America/Los_Angeles"]);
    expect(r.timezoneNote).toMatch(/America\/Los_Angeles/);
    expect(r.timezoneNote).toMatch(/Душанбе/);
  });

  it("реквизитов нет в кэше — accounts: null, а подпись про часовой пояс всё равно есть", () => {
    const r = computePacing({ ...base, now: NOON_15, days: new Map(), accounts: null });
    expect(r.accounts).toBeNull();
    expect(r.cabinetTimezones).toEqual([]);
    expect(r.timezoneNote).toMatch(/Душанбе/);
  });

  it("лимита нет и долга нет — daysToCap/balanceTjs пустые, флага долга нет", () => {
    const quiet: AdAccountDetails = { ...account, balance: null, spendCap: null, amountSpent: null };
    const r = computePacing({ ...base, now: NOON_15, days: days(range("2024-07", 1, 15, 100)), accounts: [quiet] });
    expect(r.accounts![0]).toMatchObject({ balanceTjs: null, capLeftTjs: null, daysToCap: null });
    expect(r.flags.some((f) => f.kind === "ACCOUNT_DEBT")).toBe(false);
  });
});

// ---------- база и права ----------

const runId = Date.now();
const password = "testpass123";
const agentIds: string[] = [];
const adIds: string[] = [];
let adminToken = "";
let agentToken = "";
let marketingToken = "";

const get = (path: string, token: string) => request(app).get(path).set("Authorization", `Bearer ${token}`);

async function login(role: "ADMIN" | "AGENT" | "MARKETING", n: number): Promise<string> {
  const passwordHash = await bcrypt.hash(password, 10);
  const a = await prisma.agent.create({
    data: { fullName: `Темп ${role}`, phone: `+992980${runId}${n}`, role, passwordHash },
  });
  agentIds.push(a.id);
  const res = await request(app).post("/api/v1/auth/login").send({ phone: a.phone, password });
  return res.body.accessToken;
}

beforeAll(async () => {
  adminToken = await login("ADMIN", 1);
  agentToken = await login("AGENT", 2);
  marketingToken = await login("MARKETING", 3);

  const ad = await prisma.ad.create({
    data: {
      platform: "META",
      externalId: `pacing-${runId}`,
      name: `Тест-темп ${runId}`,
      adAccountId: "act_pacing",
      status: "PAUSED",
      lastSyncedAt: new Date(),
    },
  });
  adIds.push(ad.id);
  // Июль 2024: с 1-го по 14-е по 10 долларов, сегодня (15-е) — 30 (втрое больше обычного).
  const rows = [];
  for (let d = 1; d <= 15; d++) {
    rows.push({
      adId: ad.id,
      date: new Date(`2024-07-${String(d).padStart(2, "0")}T00:00:00.000Z`),
      spend: d === 15 ? 30 : 10,
      currency: "USD" as const,
    });
  }
  await prisma.adSpendDaily.createMany({ data: rows });
  // Чужое объявление в тот же день в учёт не входит.
  const foreign = await prisma.ad.create({
    data: {
      platform: "META",
      externalId: `pacing-foreign-${runId}`,
      name: `Тест-темп-чужое ${runId}`,
      adAccountId: "act_pacing",
      status: "PAUSED",
      excluded: true,
      lastSyncedAt: new Date(),
    },
  });
  adIds.push(foreign.id);
  await prisma.adSpendDaily.create({
    data: { adId: foreign.id, date: new Date("2024-07-15T00:00:00.000Z"), spend: 5000, currency: "USD" },
  });
});

afterAll(async () => {
  await prisma.adSpendDaily.deleteMany({ where: { adId: { in: adIds } } });
  await prisma.ad.deleteMany({ where: { id: { in: adIds } } });
  await deleteAgentsWithTraces(agentIds);
  await prisma.$disconnect();
});

describe("buildAdPacing (база)", () => {
  it("месячный итог и «сегодня» сходятся с единым правилом перевода; чужая реклама не входит", async () => {
    const money = await loadMoneyContext();
    const r = await buildAdPacing({ now: NOON_15, accounts: null });
    const usd = (n: number) => fromCents(adSpendToTjsCents([{ spend: n, currency: "USD" }], money));
    expect(r.today).toBe("2024-07-15");
    expect(r.todayTjs).toBe(usd(30));
    expect(r.usualDayTjs).toBe(usd(10));
    // Месяц — по сумме СТРОК периода (14 × 10 + 30 = 170 долларов), не сложением дневных округлений.
    expect(r.monthSpentTjs).toBe(usd(170));
    expect(r.ratioToUsual).toBe(3);
    expect(r.flags.map((f) => f.kind)).toContain("SPEND_DOUBLE");
    expect(r.forecastState).toBe("ok");
    expect(r.forecast!.lowTjs).toBeLessThanOrEqual(r.forecast!.expectedTjs);
    expect(r.forecast!.expectedTjs).toBeLessThanOrEqual(r.forecast!.highTjs);
  });
});

describe("GET /ads/pacing — права", () => {
  it("агент без «Финансов» получает 403 и ни одной суммы; без токена — 401", async () => {
    const denied = await get("/api/v1/ads/pacing", agentToken);
    expect(denied.status).toBe(403);
    expect(JSON.stringify(denied.body)).not.toMatch(/Tjs|forecast|series/);
    expect((await request(app).get("/api/v1/ads/pacing")).status).toBe(401);
  });

  it("директор и маркетолог читают; Meta из роута не зовётся (кэш кабинетов пуст — accounts: null)", async () => {
    const meta = await import("../src/lib/ads/metaAdsApi.js");
    const before = vi.mocked(meta.fetchAdAccountDetails).mock.calls.length;
    const res = await get("/api/v1/ads/pacing", adminToken);
    expect(res.status).toBe(200);
    expect(res.body.accounts).toBeNull();
    expect(typeof res.body.timezoneNote).toBe("string");
    expect(Array.isArray(res.body.series)).toBe(true);
    expect((await get("/api/v1/ads/pacing", marketingToken)).status).toBe(200);
    expect(vi.mocked(meta.fetchAdAccountDetails).mock.calls.length).toBe(before);
  });
});
