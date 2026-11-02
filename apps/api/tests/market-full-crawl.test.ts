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
import { looksTruncated, runMarketFullCrawl, withMarketCrawlLock } from "../src/lib/market/nightly.js";

function pageHtml(ids: number[], links: number): string {
  const ads = ids.map((id) => ({ id, title: "2-комн. квартира, 50 м², 3/9 этаж", url: `/adv/${id}_stand/` }));
  const anchors = Array.from({ length: links }, (_, i) => `<a href="?page=${i + 1}">${i + 1}</a>`).join("");
  return `${anchors}<script>self.__next_f.push([1,${JSON.stringify(JSON.stringify({ adverts: ads }))}]);</script>`;
}
const pause = async () => {};
const paydoOk = async (_c: unknown, _s: unknown, o: { onPage?: (l: unknown[], p: number) => Promise<void> }) => {
  await o.onPage?.([{ sourceId: "p1" }], 1);
  return { section: "p", pagesFetched: 1, listings: [] };
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
    const base = path.includes("domov") ? 2000 : 1000;
    return new Response(pageHtml([base + n * 10 + 1, base + n * 10 + 2], 2));
  });
});

describe("полный обход рынка раз в неделю", () => {
  it("полный обход: квартиры и дома через fetchSomon, «исчезнувшие» помечены по обоим источникам", async () => {
    const stats = await runMarketFullCrawl({ pause });
    expect(stats?.somon).toMatchObject({ complete: true, pages: 4, disappeared: 3 });
    expect(stats?.paydo).toMatchObject({ complete: true, disappeared: 3 });
    expect(mocks.fetchSomon.mock.calls.map((c) => c[0])).toEqual([
      "/nedvizhimost/prodazha-kvartir/dushanbe/",
      "/nedvizhimost/prodazha-kvartir/dushanbe/?page=2",
      "/nedvizhimost/prodazha-domov/dushanbe/",
      "/nedvizhimost/prodazha-domov/dushanbe/?page=2",
    ]);
    expect(mocks.gone.mock.calls.map((c) => c[0])).toEqual(["somon.tj", "paydo.tj"]);
  });

  it("403 от Somon: обход остановлен без повторов, исчезнувшие Somon НЕ помечены, Paydo идёт своим путём", async () => {
    mocks.fetchSomon.mockResolvedValueOnce(new Response(pageHtml([1, 2], 2))).mockRejectedValueOnce(new SomonSourceUnavailable("http", 403));
    const stats = await runMarketFullCrawl({ pause });
    expect(stats?.somon).toMatchObject({ complete: false, stopReason: "forbidden", disappeared: 0 });
    expect(mocks.fetchSomon).toHaveBeenCalledTimes(2);
    expect(mocks.gone.mock.calls.map((c) => c[0])).toEqual(["paydo.tj"]);
  });

  it("обрыв на втором разделе (дома): ничего не помечается исчезнувшим у Somon", async () => {
    mocks.fetchSomon.mockImplementation(async (path: string) => {
      if (path.includes("domov")) throw new SomonSourceUnavailable("http", 429);
      return new Response(pageHtml([1, 2], 1));
    });
    const stats = await runMarketFullCrawl({ pause });
    expect(stats?.somon).toMatchObject({ complete: false, stopReason: "rate_limited" });
    expect(mocks.gone).not.toHaveBeenCalledWith("somon.tj");
  });

  it("слот бюджета не освободился: обход уступает и сдаётся неполным", async () => {
    mocks.fetchSomon.mockRejectedValue(new SomonSourceUnavailable("not_ready"));
    const stats = await runMarketFullCrawl({ pause });
    expect(stats?.somon).toMatchObject({ complete: false, stopReason: "wait_timeout" });
    expect(mocks.gone).not.toHaveBeenCalledWith("somon.tj");
  });

  it("Paydo заблокировал: исчезнувшие Paydo не помечены, причина в журнале", async () => {
    mocks.paydo.mockRejectedValue(new PaydoBlockedError(429));
    const stats = await runMarketFullCrawl({ pause });
    expect(stats?.paydo).toMatchObject({ complete: false, stopReason: "paydo_blocked" });
    expect(mocks.gone).not.toHaveBeenCalledWith("paydo.tj");
    expect(mocks.gone).toHaveBeenCalledWith("somon.tj");
    expect(mocks.logError).toHaveBeenCalled();
  });

  it("Paydo тихо вернул пусто (сбой первого запроса): это неполный обход", async () => {
    mocks.paydo.mockResolvedValue({ section: "p", pagesFetched: 0, listings: [] });
    const stats = await runMarketFullCrawl({ pause });
    expect(stats?.paydo).toMatchObject({ complete: false, stopReason: "paydo_failed" });
    expect(mocks.gone).not.toHaveBeenCalledWith("paydo.tj");
  });

  it("вышло время прогона: Somon не получает ни одного запроса, ничего не помечается", async () => {
    const stats = await runMarketFullCrawl({ pause, maxRuntimeMs: 0 });
    expect(stats?.somon).toMatchObject({ complete: false, stopReason: "deadline" });
    expect(stats?.paydo).toMatchObject({ complete: false });
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

describe("защита от молча оборванного обхода", () => {
  it("меньше 60 % прежнего — подозрительно; малая база защиту не включает", () => {
    expect(looksTruncated(500, 1000)).toBe(true);
    expect(looksTruncated(700, 1000)).toBe(false);
    expect(looksTruncated(0, 50)).toBe(false);
  });
});

it("база тестов доступна для замка", async () => {
  expect(await prisma.$queryRaw`SELECT 1 AS ok`).toBeTruthy();
});
