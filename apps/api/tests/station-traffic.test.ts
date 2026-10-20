import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { prisma } from "../src/db.js";
import {
  buildStationTrafficUsage,
  getStationTrafficUsageCached,
  parseEth1UsageCsv,
  resetStationTrafficCache,
  runStationTrafficTick,
  stationTrafficAlert,
  stationTrafficLimitMb,
} from "../src/lib/telephony/stationTraffic.js";
import { dushanbeDateString } from "../src/lib/dushanbeTime.js";

/**
 * ТРАФИК СТАНЦИИ (08.10.2026): разбор CSV 1-в-1 с режимом `report` скрипта станции
 * (`ops/pbx/station/royalhome-eth1-usage.sh`) и пороги предупреждения 70/90 %.
 * Сеть подменяется глобальным fetch — сам модуль станции не мокается.
 */

const MB = 1_048_576;
const MONTH = "2026-10";

describe("parseEth1UsageCsv", () => {
  it("суммирует приращения за месяц; первая строка — только точка отсчёта", () => {
    const csv = [
      `2026-10-01 00:00:01,${10 * MB},${2 * MB}`,
      `2026-10-01 01:00:01,${15 * MB},${3 * MB}`,
      `2026-10-01 02:00:01,${25 * MB},${4 * MB}`,
    ].join("\n");
    const r = parseEth1UsageCsv(csv, MONTH);
    expect(r.rxBytes).toBe(15 * MB);
    expect(r.txBytes).toBe(2 * MB);
    expect(r.lastStamp).toBe("2026-10-01 02:00:01");
  });

  it("сброс счётчика при перезагрузке: прирост равен текущему значению", () => {
    const csv = [
      `2026-10-02 00:00:00,${100 * MB},${50 * MB}`,
      `2026-10-02 01:00:00,${3 * MB},${1 * MB}`, // перезагрузка: счётчик начался заново
      `2026-10-02 02:00:00,${5 * MB},${2 * MB}`,
    ].join("\n");
    const r = parseEth1UsageCsv(csv, MONTH);
    expect(r.rxBytes).toBe(3 * MB + 2 * MB);
    expect(r.txBytes).toBe(1 * MB + 1 * MB);
  });

  it("строки чужого месяца не считаются, но служат точкой отсчёта", () => {
    const csv = [
      `2026-09-30 22:00:00,${500 * MB},${100 * MB}`,
      `2026-09-30 23:00:00,${600 * MB},${120 * MB}`, // сентябрь — не наш
      `2026-10-01 00:00:00,${610 * MB},${121 * MB}`, // 10 МБ + 1 МБ — октябрь
    ].join("\n");
    const r = parseEth1UsageCsv(csv, MONTH);
    expect(r.rxBytes).toBe(10 * MB);
    expect(r.txBytes).toBe(1 * MB);
  });

  it("мусорные строки пропускаются и не создают ложный сброс счётчика", () => {
    const csv = [
      "date,rx,tx",
      `2026-10-03 00:00:00,${100 * MB},${10 * MB}`,
      "2026-10-03 00:30:00,abc,def",
      "обрыв записи",
      "",
      `2026-10-03 01:00:00,${110 * MB},${12 * MB}`,
    ].join("\r\n");
    const r = parseEth1UsageCsv(csv, MONTH);
    expect(r.rxBytes).toBe(10 * MB);
    expect(r.txBytes).toBe(2 * MB);
  });

  it("пустой файл — нули и без метки", () => {
    expect(parseEth1UsageCsv("", MONTH)).toEqual({ rxBytes: 0, txBytes: 0, lastStamp: null });
  });
});

describe("buildStationTrafficUsage", () => {
  it("мегабайты, доля лимита и момент последней строки по Душанбе (UTC+5)", () => {
    const csv = [`2026-10-04 10:00:00,0,0`, `2026-10-04 11:00:00,${MB * 3},${MB * 1}`].join("\n");
    const u = buildStationTrafficUsage(csv, MONTH, 10_240);
    expect(u.rxMb).toBeCloseTo(3);
    expect(u.txMb).toBeCloseTo(1);
    expect(u.usedMb).toBeCloseTo(4);
    expect(u.pct).toBeCloseTo((4 / 10_240) * 100);
    expect(u.limitMb).toBe(10_240);
    expect(u.measuredAt).toBe("2026-10-04T06:00:00.000Z");
  });
});

describe("stationTrafficLimitMb", () => {
  afterEach(() => {
    delete process.env.PBX_TRAFFIC_LIMIT_MB;
  });
  it("по умолчанию 10240 МБ, переопределяется окружением, мусор игнорируется", () => {
    expect(stationTrafficLimitMb()).toBe(10_240);
    process.env.PBX_TRAFFIC_LIMIT_MB = "20480";
    expect(stationTrafficLimitMb()).toBe(20_480);
    process.env.PBX_TRAFFIC_LIMIT_MB = "много";
    expect(stationTrafficLimitMb()).toBe(10_240);
  });
});

describe("stationTrafficAlert", () => {
  const usage = (pct: number) => ({
    month: MONTH,
    usedMb: (pct / 100) * 10_240,
    rxMb: 0,
    txMb: 0,
    limitMb: 10_240,
    pct,
    measuredAt: "",
  });

  it("ниже 70 % молчит; 70 и 90 — свои ключи с месяцем", () => {
    expect(stationTrafficAlert(usage(69.9))).toBeNull();
    expect(stationTrafficAlert(usage(70))?.dedupKey).toBe("pbx-traffic-70-2026-10");
    expect(stationTrafficAlert(usage(89.9))?.level).toBe(70);
    expect(stationTrafficAlert(usage(90))?.dedupKey).toBe("pbx-traffic-90-2026-10");
  });

  it("текст по-русски: месяц словом, ГБ с запятой, процент", () => {
    const msg = stationTrafficAlert(usage(72))?.message ?? "";
    expect(msg).toContain("Трафик станции за октябрь: 7,2 ГБ из 10 ГБ (72 %)");
    expect(msg).toContain("уточните");
  });
});

describe("runStationTrafficTick / кэш (с подменённым fetch)", () => {
  const month = dushanbeDateString().slice(0, 7);
  const realFetch = globalThis.fetch;
  let calls = 0;
  let body = "";
  let status = 200;

  const csvWithUsedMb = (usedMb: number) =>
    [`${month}-01 00:00:00,0,0`, `${month}-01 01:00:00,${Math.round(usedMb * MB)},0`].join("\n");

  async function clearTrafficErrors() {
    await prisma.errorLog.deleteMany({ where: { dedupKey: { startsWith: "pbx-traffic" } } });
  }

  beforeAll(async () => {
    await clearTrafficErrors();
  });
  afterAll(async () => {
    await clearTrafficErrors();
    delete process.env.PBX_RECORDINGS_URL;
    delete process.env.PBX_RECORDINGS_TOKEN;
  });
  beforeEach(() => {
    process.env.PBX_RECORDINGS_URL = "http://station.test/recs/";
    process.env.PBX_RECORDINGS_TOKEN = "tkn";
    resetStationTrafficCache();
    calls = 0;
    status = 200;
    globalThis.fetch = vi.fn(async (url: unknown, init?: RequestInit) => {
      calls++;
      expect(String(url)).toBe("http://station.test/recs/royalhome-eth1-usage.csv");
      expect((init?.headers as Record<string, string>)["X-Recordings-Token"]).toBe("tkn");
      return new Response(body, { status });
    }) as typeof fetch;
  });
  afterEach(async () => {
    globalThis.fetch = realFetch;
    await clearTrafficErrors();
  });

  it("адрес не задан — null без обращения к сети и без записи в журнал", async () => {
    delete process.env.PBX_RECORDINGS_URL;
    const r = await runStationTrafficTick();
    expect(r).toEqual({ usage: null, alertedLevel: null });
    expect(calls).toBe(0);
  });

  it("50 % — тихо; 72 % — одна запись 70; повтор тика не дублирует", async () => {
    body = csvWithUsedMb(5120);
    expect((await runStationTrafficTick()).alertedLevel).toBeNull();
    expect(await prisma.errorLog.count({ where: { dedupKey: { startsWith: "pbx-traffic" } } })).toBe(0);

    body = csvWithUsedMb(0.72 * 10_240);
    expect((await runStationTrafficTick()).alertedLevel).toBe(70);
    expect((await runStationTrafficTick()).alertedLevel).toBe(70);
    const rows = await prisma.errorLog.findMany({ where: { dedupKey: `pbx-traffic-70-${month}` } });
    expect(rows).toHaveLength(1);
    expect(rows[0].source).toBe("telephony");
    expect(rows[0].message).toContain("Трафик станции за");
  });

  it("93 % — отдельная запись 90", async () => {
    body = csvWithUsedMb(0.93 * 10_240);
    expect((await runStationTrafficTick()).alertedLevel).toBe(90);
    expect(await prisma.errorLog.count({ where: { dedupKey: `pbx-traffic-90-${month}` } })).toBe(1);
  });

  it("станция ответила отказом — null и одна запись о сбое, а не молчание", async () => {
    status = 403;
    const r = await runStationTrafficTick();
    expect(r.usage).toBeNull();
    const rows = await prisma.errorLog.findMany({ where: { dedupKey: "pbx-traffic-fetch-failed" } });
    expect(rows).toHaveLength(1);
    expect(rows[0].message).toContain("HTTP 403");
  });

  it("кэш для экрана: второй вызов в пределах 10 минут не ходит на станцию", async () => {
    body = csvWithUsedMb(10);
    const a = await getStationTrafficUsageCached(1_000_000);
    const b = await getStationTrafficUsageCached(1_000_000 + 5 * 60_000);
    expect(calls).toBe(1);
    expect(b).toEqual(a);
    await getStationTrafficUsageCached(1_000_000 + 11 * 60_000);
    expect(calls).toBe(2);
  });
});
