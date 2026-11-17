import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ fetchSomon: vi.fn(), save: vi.fn(), logError: vi.fn(), paused: vi.fn() }));
vi.mock("../src/lib/somonLeads/sourceClient.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/lib/somonLeads/sourceClient.js")>()),
  fetchSomon: mocks.fetchSomon,
}));
vi.mock("../src/lib/market/marketStore.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/lib/market/marketStore.js")>()),
  saveListings: mocks.save,
}));
vi.mock("../src/lib/systemError.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/lib/systemError.js")>()),
  logSystemError: mocks.logError,
}));
vi.mock("../src/lib/telegramPortalPause.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/lib/telegramPortalPause.js")>()),
  isTelegramPortalAlertsPaused: mocks.paused,
}));

import { prisma } from "../src/db.js";
import { somonKeyFingerprint } from "../src/lib/somonLeads/contactIdentity.js";
import { runSomonMonitorTick, somonMonitorFeedsMarket } from "../src/lib/somonLeads/monitor.js";
import { SomonSourceUnavailable } from "../src/lib/somonLeads/sourceClient.js";
import { runSomonIncremental, SOMON_INCREMENTAL_PAGES } from "../src/lib/market/somonIncremental.js";
import { withMarketCrawlLock } from "../src/lib/market/nightly.js";
import { RUBRIC_HOUSES, somonListPageHtml } from "./helpers/somonPage.js";

/**
 * Пауза Telegram-уведомлений площадок глушит лиды, а не рынок (12.11.2026): каталог Somon стоял с
 * 11.11, пока пауза была включена. Инкремент читает первые страницы сам, но квартиры — только когда
 * парсер лидов их не пишет (без двойного трафика). Состояние Somon подменяется шпионом: строка
 * SomonMonitor общая для всех файлов тестов.
 */

type MonitorRow = { enabled: boolean; sourceStopped: boolean; blockedUntil: Date | null; contactKeyFingerprint: string | null };
let monitorRow: MonitorRow;
const pause = async () => {};

beforeEach(() => {
  vi.clearAllMocks();
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  vi.stubEnv("SETTINGS_ENCRYPTION_KEY", "1".repeat(64));
  monitorRow = { enabled: true, sourceStopped: false, blockedUntil: null, contactKeyFingerprint: somonKeyFingerprint() };
  vi.spyOn(prisma.somonMonitor, "findUnique").mockImplementation((async () => monitorRow) as never);
  mocks.paused.mockResolvedValue(true);
  mocks.logError.mockResolvedValue(undefined);
  mocks.save.mockImplementation(async (_s: string, listings: unknown[]) => ({ created: listings.length, updated: 0, priceChanges: 0, skipped: 0 }));
  mocks.fetchSomon.mockImplementation(async (path: string) => {
    const n = Number(/page=(\d+)/.exec(path)?.[1] ?? 1);
    if (path.includes("domov")) {
      return new Response(somonListPageHtml([{ id: 2000 + n, rubricId: RUBRIC_HOUSES, title: "2 этажн. 5-комн. дом, 2 соток, Сино" }], { pageRubricId: RUBRIC_HOUSES, links: 24 }));
    }
    return new Response(somonListPageHtml([{ id: 1000 + n }], { links: 151 }));
  });
});

describe("парсер лидов: пишет ли он каталог сам", () => {
  it("пауза уведомлений — не пишет; лиды выключены или остановлены — не пишет; работает — пишет", async () => {
    expect(await somonMonitorFeedsMarket()).toBe(false);
    mocks.paused.mockResolvedValue(false);
    expect(await somonMonitorFeedsMarket()).toBe(true);
    monitorRow = { ...monitorRow, enabled: false };
    expect(await somonMonitorFeedsMarket()).toBe(false);
    monitorRow = { ...monitorRow, enabled: true, sourceStopped: true };
    expect(await somonMonitorFeedsMarket()).toBe(false);
    monitorRow = { ...monitorRow, sourceStopped: false, contactKeyFingerprint: "other" };
    expect(await somonMonitorFeedsMarket()).toBe(false);
    vi.stubEnv("MARKET_MONITOR_INGEST", "0");
    monitorRow = { ...monitorRow, contactKeyFingerprint: somonKeyFingerprint() };
    expect(await somonMonitorFeedsMarket()).toBe(false);
  });

  it("на паузе сам тик лидов к Somon не ходит (поэтому каталог и стоял)", async () => {
    await runSomonMonitorTick(pause);
    expect(mocks.fetchSomon).not.toHaveBeenCalled();
  });
});

describe("инкремент Somon", () => {
  it("пауза уведомлений: квартиры и дома, по 3 первые страницы, в фоне через общую дверь", async () => {
    const stats = await runSomonIncremental({ pause });
    expect(stats?.sections).toEqual([
      { section: "Продажа квартир", pages: SOMON_INCREMENTAL_PAGES, saved: 3, foreignSkipped: 0 },
      { section: "Продажа домов", pages: SOMON_INCREMENTAL_PAGES, saved: 3, foreignSkipped: 0 },
    ]);
    expect(mocks.fetchSomon.mock.calls.map((c) => c[0])).toEqual([
      "/nedvizhimost/prodazha-kvartir/dushanbe/",
      "/nedvizhimost/prodazha-kvartir/dushanbe/?page=2",
      "/nedvizhimost/prodazha-kvartir/dushanbe/?page=3",
      "/nedvizhimost/prodazha-domov-havli-i-dach/dushanbe/",
      "/nedvizhimost/prodazha-domov-havli-i-dach/dushanbe/?page=2",
      "/nedvizhimost/prodazha-domov-havli-i-dach/dushanbe/?page=3",
    ]);
    for (const call of mocks.fetchSomon.mock.calls) expect(call[3]).toEqual({ background: true });
    expect(mocks.logError).not.toHaveBeenCalled();
  });

  it("парсер лидов работает и пишет квартиры сам — инкремент их не качает второй раз, только дома", async () => {
    mocks.paused.mockResolvedValue(false);
    const stats = await runSomonIncremental({ pause });
    expect(stats?.sections[0]).toMatchObject({ section: "Продажа квартир", pages: 0, stopReason: "skipped_monitor" });
    expect(mocks.fetchSomon.mock.calls.every((c) => String(c[0]).includes("prodazha-domov-havli-i-dach"))).toBe(true);
    expect(mocks.fetchSomon).toHaveBeenCalledTimes(SOMON_INCREMENTAL_PAGES);
  });

  it("источник остановлен (403) или бюджет закрыт надолго — тик пропускается без единого запроса", async () => {
    monitorRow = { ...monitorRow, sourceStopped: true };
    expect(await runSomonIncremental({ pause })).toBeNull();
    monitorRow = { ...monitorRow, sourceStopped: false, blockedUntil: new Date(Date.now() + 10 * 60_000) };
    expect(await runSomonIncremental({ pause })).toBeNull();
    expect(mocks.fetchSomon).not.toHaveBeenCalled();
  });

  it("403 посреди тика — стоп, дальше разделы не трогаем", async () => {
    mocks.fetchSomon.mockRejectedValueOnce(new SomonSourceUnavailable("http", 403));
    const stats = await runSomonIncremental({ pause });
    expect(stats?.sections).toEqual([{ section: "Продажа квартир", pages: 0, saved: 0, foreignSkipped: 0, stopReason: "forbidden" }]);
    expect(mocks.fetchSomon).toHaveBeenCalledTimes(1);
  });

  it("замок обходов рынка занят (полный обход, Paydo) — тик пропускается", async () => {
    let inner: Awaited<ReturnType<typeof runSomonIncremental>> | undefined;
    await withMarketCrawlLock(async () => {
      inner = await runSomonIncremental({ pause });
    });
    expect(inner).toBeNull();
    expect(mocks.fetchSomon).not.toHaveBeenCalled();
  });
});
