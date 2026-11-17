import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  fetchSomon: vi.fn(),
  stopped: vi.fn(),
  logError: vi.fn(),
  save: vi.fn(),
  gone: vi.fn(),
  paydo: vi.fn(),
}));
vi.mock("../src/lib/somonLeads/sourceClient.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/lib/somonLeads/sourceClient.js")>()),
  fetchSomon: mocks.fetchSomon,
}));
vi.mock("../src/lib/somonLeads/sourceBudgetStore.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/lib/somonLeads/sourceBudgetStore.js")>()),
  isSomonSourceStopped: mocks.stopped,
}));
vi.mock("../src/lib/systemError.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/lib/systemError.js")>()),
  logSystemError: mocks.logError,
}));
vi.mock("../src/lib/market/marketStore.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/lib/market/marketStore.js")>()),
  saveListings: mocks.save,
  markDisappeared: mocks.gone,
}));
vi.mock("../src/lib/market/paydoCrawler.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/lib/market/paydoCrawler.js")>()),
  crawlPaydoSection: mocks.paydo,
}));

import { prisma } from "../src/db.js";
import { SomonSourceUnavailable } from "../src/lib/somonLeads/sourceClient.js";
import { PaydoBlockedError } from "../src/lib/market/paydoClient.js";
import { looksTruncated, runMarketFullCrawl, runPaydoFullCrawl, withMarketCrawlLock } from "../src/lib/market/nightly.js";
import { DISAPPEAR_AFTER_HOURS, PAYDO_DISAPPEAR_AFTER_HOURS } from "../src/lib/market/marketStore.js";
import { RUBRIC_HOUSES, somonListPageHtml } from "./helpers/somonPage.js";

function pageHtml(ids: number[], links: number, houses = false): string {
  return houses
    ? somonListPageHtml(ids.map((id) => ({ id, rubricId: RUBRIC_HOUSES, title: "2 этажн. 5-комн. дом, 2 соток, Сино" })), { links, pageRubricId: RUBRIC_HOUSES })
    : somonListPageHtml(ids.map((id) => ({ id })), { links });
}
const pause = async () => {};
const paydoOk = async (_c: unknown, _s: unknown, o: { onPage?: (l: unknown[], p: number) => Promise<void> }) => {
  await o.onPage?.([{ sourceId: "p1" }], 1);
  return { section: "p", pagesFetched: 1, listings: [], complete: true };
};

beforeEach(() => {
  vi.clearAllMocks();
  vi.restoreAllMocks();
  // Прежний объём каталога не должен зависеть от содержимого тестовой базы.
  vi.spyOn(prisma.marketListing, "count").mockResolvedValue(0);
  mocks.stopped.mockResolvedValue(false);
  mocks.logError.mockResolvedValue(undefined);
  mocks.save.mockResolvedValue({ created: 1, updated: 0, priceChanges: 0, skipped: 0 });
  mocks.gone.mockResolvedValue(3);
  mocks.paydo.mockImplementation(paydoOk);
  // Каждый раздел: 2 страницы, у каждого раздела свои id.
  mocks.fetchSomon.mockImplementation(async (path: string) => {
    const n = Number(/page=(\d+)/.exec(path)?.[1] ?? 1);
    const houses = path.includes("domov");
    const base = houses ? 2000 : 1000;
    return new Response(pageHtml([base + n * 10 + 1, base + n * 10 + 2], 2, houses));
  });
});

describe("недельный обход Somon", () => {
  it("полный обход: квартиры и дома через fetchSomon, «исчезнувшие» помечены только у Somon (Paydo сюда не ходит)", async () => {
    const stats = await runMarketFullCrawl({ pause });
    expect(stats?.somon).toMatchObject({ complete: true, pages: 4, disappeared: 3 });
    expect(stats).not.toHaveProperty("paydo");
    expect(mocks.paydo).not.toHaveBeenCalled();
    expect(mocks.fetchSomon.mock.calls.map((c) => c[0])).toEqual([
      "/nedvizhimost/prodazha-kvartir/dushanbe/",
      "/nedvizhimost/prodazha-kvartir/dushanbe/?page=2",
      "/nedvizhimost/prodazha-domov-havli-i-dach/dushanbe/",
      "/nedvizhimost/prodazha-domov-havli-i-dach/dushanbe/?page=2",
    ]);
    expect(mocks.gone.mock.calls).toEqual([["somon.tj", DISAPPEAR_AFTER_HOURS]]);
    // порог «не видели дольше полутора интервалов» передан явно: мимо двух полных обходов подряд
    expect(DISAPPEAR_AFTER_HOURS).toBe(264);
  });

  it("403 от Somon: обход остановлен без повторов, исчезнувшие Somon НЕ помечены", async () => {
    mocks.fetchSomon.mockResolvedValueOnce(new Response(pageHtml([1, 2], 2))).mockRejectedValueOnce(new SomonSourceUnavailable("http", 403));
    const stats = await runMarketFullCrawl({ pause });
    expect(stats?.somon).toMatchObject({ complete: false, stopReason: "forbidden", disappeared: 0 });
    expect(mocks.fetchSomon).toHaveBeenCalledTimes(2);
    expect(mocks.gone).not.toHaveBeenCalled();
  });

  it("обрыв на втором разделе (дома): ничего не помечается исчезнувшим у Somon", async () => {
    mocks.fetchSomon.mockImplementation(async (path: string) => {
      if (path.includes("domov")) throw new SomonSourceUnavailable("http", 429);
      return new Response(pageHtml([1, 2], 1));
    });
    const stats = await runMarketFullCrawl({ pause });
    expect(stats?.somon).toMatchObject({ complete: false, stopReason: "rate_limited" });
    expect(mocks.gone.mock.calls.map((c) => c[0])).not.toContain("somon.tj");
  });

  it("слот бюджета не освободился: обход уступает и сдаётся неполным", async () => {
    mocks.fetchSomon.mockRejectedValue(new SomonSourceUnavailable("not_ready"));
    const stats = await runMarketFullCrawl({ pause });
    expect(stats?.somon).toMatchObject({ complete: false, stopReason: "wait_timeout" });
    expect(mocks.gone.mock.calls.map((c) => c[0])).not.toContain("somon.tj");
  });

  it("слот Somon занят полным обходом Paydo: оба не идут вместе", async () => {
    let second: Awaited<ReturnType<typeof runPaydoFullCrawl>> | undefined;
    await withMarketCrawlLock(async () => {
      second = await runPaydoFullCrawl();
    });
    expect(second).toBeNull();
    expect(mocks.paydo).not.toHaveBeenCalled();
    expect(mocks.gone).not.toHaveBeenCalled();
  });

  it("вышло время прогона: Somon не получает ни одного запроса, ничего не помечается", async () => {
    const stats = await runMarketFullCrawl({ pause, maxRuntimeMs: 0 });
    expect(stats?.somon).toMatchObject({ complete: false, stopReason: "deadline" });
    expect(mocks.fetchSomon).not.toHaveBeenCalled();
    expect(mocks.gone).not.toHaveBeenCalled();
  });

  it("второй процесс не стартует, пока замок занят (pg advisory lock)", async () => {
    let second: Awaited<ReturnType<typeof runMarketFullCrawl>> | undefined;
    await withMarketCrawlLock(async () => {
      second = await runMarketFullCrawl({ pause });
    });
    expect(second).toBeNull();
    expect(mocks.fetchSomon).not.toHaveBeenCalled();
    // замок снят — следующий прогон идёт
    expect(await runMarketFullCrawl({ pause })).not.toBeNull();
  });

  it("параллельный вызов в том же процессе отклоняется", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    mocks.fetchSomon.mockImplementationOnce(async () => {
      await gate;
      return new Response(pageHtml([1], 1));
    });
    const first = runMarketFullCrawl({ pause });
    await vi.waitFor(() => expect(mocks.fetchSomon).toHaveBeenCalled());
    expect(await runMarketFullCrawl({ pause })).toBeNull();
    release();
    expect(await first).not.toBeNull();
  });
});

describe("защита от молча оборванного обхода: порог 60 % проверяется по-настоящему", () => {
  /** Прежний объём каталога `source`; остальные источники — без истории. */
  function previous(source: string, count: number) {
    vi.spyOn(prisma.marketListing, "count").mockImplementation((async (args?: { where?: { source?: string } }) =>
      args?.where?.source === source ? count : 0) as never);
  }
  /** По 60 новых объявлений на страницу, id не повторяются: два раздела по две страницы = 240 объявлений. */
  function manyAds() {
    mocks.fetchSomon.mockImplementation(async (path: string) => {
      const n = Number(/page=(\d+)/.exec(path)?.[1] ?? 1);
      const base = (path.includes("domov") ? 20_000 : 10_000) + n * 100;
      return new Response(pageHtml(Array.from({ length: 60 }, (_, i) => base + i), 2, path.includes("domov")));
    });
  }

  it("собрали 240 из 500 (48 %) — обход подозрительно мал: исчезнувшие Somon не помечены, в журнале причина", async () => {
    previous("somon.tj", 500);
    manyAds();
    const stats = await runMarketFullCrawl({ pause });
    expect(stats?.somon).toMatchObject({ complete: false, stopReason: "too_small", disappeared: 0, pages: 4 });
    expect(mocks.gone).not.toHaveBeenCalled();
    expect(mocks.logError).toHaveBeenCalledWith("api", expect.stringContaining("240 при 500"), expect.anything());
  });

  it("собрали 240 из 380 (63 %) — защита пропускает, исчезнувшие помечаются", async () => {
    previous("somon.tj", 380);
    manyAds();
    const stats = await runMarketFullCrawl({ pause });
    expect(stats?.somon).toMatchObject({ complete: true, disappeared: 3 });
    expect(mocks.gone).toHaveBeenCalledWith("somon.tj", DISAPPEAR_AFTER_HOURS);
  });

  it("малая прежняя база (< 100) защиту не включает, даже если собрано мало", async () => {
    previous("somon.tj", 99);
    const stats = await runMarketFullCrawl({ pause }); // собирает 8 объявлений
    expect(stats?.somon).toMatchObject({ complete: true });
  });

});

describe("ночной обход Paydo: 03:00 каждую ночь, порог «исчезло» 72 часа", () => {
  function previous(source: string, count: number) {
    vi.spyOn(prisma.marketListing, "count").mockImplementation((async (args?: { where?: { source?: string } }) =>
      args?.where?.source === source ? count : 0) as never);
  }

  it("полный обход: «исчезнувшие» помечены с порогом 72 ч (не 264), Somon не трогаем", async () => {
    const stats = await runPaydoFullCrawl();
    expect(stats).toMatchObject({ complete: true, disappeared: 3 });
    expect(PAYDO_DISAPPEAR_AFTER_HOURS).toBe(72);
    expect(mocks.gone.mock.calls).toEqual([["paydo.tj", 72]]);
    expect(mocks.fetchSomon).not.toHaveBeenCalled();
  });

  it("Paydo заблокировал: исчезнувшие не помечены, причина в журнале", async () => {
    mocks.paydo.mockRejectedValue(new PaydoBlockedError(429));
    const stats = await runPaydoFullCrawl();
    expect(stats).toMatchObject({ complete: false, stopReason: "paydo_blocked" });
    expect(mocks.gone).not.toHaveBeenCalled();
    expect(mocks.logError).toHaveBeenCalled();
  });

  it("Paydo тихо вернул пусто (сбой первого запроса): неполный обход, не помечаем", async () => {
    mocks.paydo.mockResolvedValue({ section: "p", pagesFetched: 0, listings: [], complete: false, stopReason: "page_failed" });
    const stats = await runPaydoFullCrawl();
    expect(stats).toMatchObject({ complete: false, stopReason: "paydo_failed" });
    expect(mocks.gone).not.toHaveBeenCalled();
  });

  it("обрыв посреди раздела (страница 150 не отдалась): не помечаем, второй раздел не качается", async () => {
    mocks.paydo.mockResolvedValue({ section: "p", pagesFetched: 149, listings: [], complete: false, stopReason: "page_failed" });
    const stats = await runPaydoFullCrawl();
    expect(stats).toMatchObject({ complete: false, stopReason: "paydo_failed", disappeared: 0 });
    expect(mocks.gone).not.toHaveBeenCalled();
    expect(mocks.paydo).toHaveBeenCalledTimes(1);
  });

  it("обрыв ВТОРОГО раздела (домов) при полном первом: тоже неполный обход", async () => {
    mocks.paydo.mockImplementation(async (_c: unknown, section: { subcategoryId: number }) =>
      section.subcategoryId === 201
        ? { section: "p", pagesFetched: 30, listings: [], complete: true }
        : { section: "p", pagesFetched: 10, listings: [], complete: false, stopReason: "page_limit" }
    );
    const stats = await runPaydoFullCrawl();
    expect(stats).toMatchObject({ complete: false, disappeared: 0 });
    expect(mocks.gone).not.toHaveBeenCalled();
  });

  it("страховка «подозрительно мало» осталась: собрал 1 из 300 — не помечаем", async () => {
    previous("paydo.tj", 300);
    const stats = await runPaydoFullCrawl();
    expect(stats).toMatchObject({ complete: false, stopReason: "too_small" });
    expect(mocks.gone).not.toHaveBeenCalled();
    expect(mocks.logError).toHaveBeenCalledWith("api", expect.stringContaining("1 при 300"), expect.anything());
  });

  it("вышло время прогона: в сеть не ходим, ничего не помечаем", async () => {
    const stats = await runPaydoFullCrawl({ maxRuntimeMs: 0 });
    expect(stats).toMatchObject({ complete: false, stopReason: "deadline" });
    expect(mocks.paydo).not.toHaveBeenCalled();
    expect(mocks.gone).not.toHaveBeenCalled();
  });
});

describe("looksTruncated: граница", () => {
  it("меньше 60 % прежнего — подозрительно; малая база защиту не включает", () => {
    expect(looksTruncated(500, 1000)).toBe(true);
    expect(looksTruncated(700, 1000)).toBe(false);
    expect(looksTruncated(0, 50)).toBe(false);
  });
});

it("база тестов доступна для замка", async () => {
  expect(await prisma.$queryRaw`SELECT 1 AS ok`).toBeTruthy();
});
