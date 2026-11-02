import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  search: vi.fn(),
  save: vi.fn(),
  gone: vi.fn(),
  logError: vi.fn(),
}));
vi.mock("../src/lib/market/paydoClient.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/lib/market/paydoClient.js")>()),
  PaydoClient: class {
    search = mocks.search;
  },
}));
vi.mock("../src/lib/market/marketStore.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/lib/market/marketStore.js")>()),
  saveListings: mocks.save,
  markDisappeared: mocks.gone,
}));
vi.mock("../src/lib/systemError.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/lib/systemError.js")>()),
  logSystemError: mocks.logError,
}));

import { prisma } from "../src/db.js";
import { PaydoBlockedError } from "../src/lib/market/paydoClient.js";
import { withMarketCrawlLock } from "../src/lib/market/nightly.js";
import { INCREMENTAL_MAX_PAGES, isKnownUnchanged, runPaydoIncremental } from "../src/lib/market/paydoIncremental.js";

/** Каталог: sourceId → цена (строкой, как отдаёт Prisma Decimal). Неактивные — отдельно. */
let catalog: Map<string, { price: string | null; isActive: boolean }>;

/** Страница N раздела: 20 объявлений с id N*100+i; курсор — номер следующей страницы. */
const pageIds = (n: number) => Array.from({ length: 20 }, (_, i) => n * 100 + i);
const ad = (id: number, price = 100_000) => ({ id, price: String(price), subtitle1: `${price} сомони`, title: `Квартира ${id}` });
const known = (ids: number[], price = 100_000) => ids.forEach((id) => catalog.set(String(id), { price: String(price), isActive: true }));

/** Выдача из `total` страниц; цена объявления на странице `n` — `priceOf(n)`. */
function serve(total: number, priceOf: (n: number) => number = () => 100_000) {
  mocks.search.mockImplementation(async (_sub: number, cursor: string | null) => {
    const n = cursor ? Number(cursor) : 1;
    return { advertisements: pageIds(n).map((id) => ad(id, priceOf(n))), cursor: n < total ? String(n + 1) : null, hasMore: n < total };
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.restoreAllMocks();
  catalog = new Map();
  mocks.save.mockResolvedValue({ created: 1, updated: 0, priceChanges: 0, skipped: 0 });
  mocks.gone.mockResolvedValue(5);
  mocks.logError.mockResolvedValue(undefined);
  vi.spyOn(prisma.marketListing, "findMany").mockImplementation((async (args: { where: { sourceId: { in: string[] } } }) =>
    args.where.sourceId.in.flatMap((id) => {
      const row = catalog.get(id);
      return row ? [{ sourceId: id, price: row.price, currency: "TJS", isActive: row.isActive }] : [];
    })) as never);
});

describe("инкремент Paydo: где останавливается", () => {
  it("две подряд полностью известные страницы — стоп (страницы 3 и 4), дальше раздел не читается", async () => {
    known([...pageIds(3), ...pageIds(4)]);
    serve(50);
    const stats = await runPaydoIncremental();
    // каждый из двух разделов: 1, 2 — новые; 3, 4 — известные; 5-я не запрашивается
    expect(mocks.search).toHaveBeenCalledTimes(8);
    expect(stats?.sections).toEqual([
      { section: "Paydo: продажа квартир", pages: 4, stopReason: "caught_up" },
      { section: "Paydo: продажа домов и хавли", pages: 4, stopReason: "caught_up" },
    ]);
    expect(mocks.save).toHaveBeenCalledTimes(8); // известные страницы тоже сохраняются: обновляют «видели»
  });

  it("одна известная страница не останавливает: после неё снова новое — идём дальше", async () => {
    known(pageIds(2)); // 2 — известная, 3 — новая, 4 и 5 — известные
    known([...pageIds(4), ...pageIds(5)]);
    serve(50);
    const stats = await runPaydoIncremental();
    expect(stats?.sections.map((s) => s.pages)).toEqual([5, 5]);
  });

  it("известное объявление с изменившейся ценой не считается известным: серия обрывается", async () => {
    known([...pageIds(1), ...pageIds(2)], 90_000); // в каталоге цена старая, на сайте 100 000
    known([...pageIds(3), ...pageIds(4)]);
    serve(50);
    const stats = await runPaydoIncremental();
    // стр. 1-2: цена изменилась → новое; 3-4: известные → стоп на 4-й
    expect(stats?.sections.map((s) => s.pages)).toEqual([4, 4]);
  });

  it("ранее исчезнувшее объявление, вернувшееся в выдачу, — новость (реактивируем)", async () => {
    known(pageIds(1));
    catalog.set(String(pageIds(1)[0]), { price: "100000", isActive: false });
    known([...pageIds(2), ...pageIds(3)]);
    serve(50);
    const stats = await runPaydoIncremental();
    expect(stats?.sections.map((s) => s.pages)).toEqual([3, 3]); // 1-я не «известная» целиком
  });

  it("всё новое: упираемся в потолок 15 страниц на раздел", async () => {
    serve(500);
    const stats = await runPaydoIncremental();
    expect(INCREMENTAL_MAX_PAGES).toBe(15);
    expect(mocks.search).toHaveBeenCalledTimes(30);
    expect(stats?.sections).toEqual([
      { section: "Paydo: продажа квартир", pages: 15, stopReason: "page_limit" },
      { section: "Paydo: продажа домов и хавли", pages: 15, stopReason: "page_limit" },
    ]);
  });

  it("выдача кончилась раньше потолка — причина остановки пуста", async () => {
    serve(3);
    const stats = await runPaydoIncremental();
    expect(stats?.sections).toEqual([
      { section: "Paydo: продажа квартир", pages: 3 },
      { section: "Paydo: продажа домов и хавли", pages: 3 },
    ]);
  });
});

describe("инкремент Paydo: чего не делает и как защищён", () => {
  it("НЕ помечает исчезнувшие — ни при остановке по известным страницам, ни при потолке", async () => {
    known([...pageIds(3), ...pageIds(4)]);
    serve(50);
    await runPaydoIncremental();
    serve(500);
    await runPaydoIncremental();
    expect(mocks.gone).not.toHaveBeenCalled();
  });

  it("замок занят (идёт полный обход) — тик тихо пропущен: в сеть не ходили, в журнал не писали", async () => {
    serve(3);
    let skipped: Awaited<ReturnType<typeof runPaydoIncremental>> | undefined;
    await withMarketCrawlLock(async () => {
      skipped = await runPaydoIncremental();
    });
    expect(skipped).toBeNull();
    expect(mocks.search).not.toHaveBeenCalled();
    expect(mocks.logError).not.toHaveBeenCalled();
    // замок снят — следующий тик идёт
    expect(await runPaydoIncremental()).not.toBeNull();
  });

  it("429/403: остановка сразу, второй раздел не трогаем, в журнал только код ответа", async () => {
    mocks.search.mockRejectedValue(new PaydoBlockedError(429));
    const stats = await runPaydoIncremental();
    expect(mocks.search).toHaveBeenCalledTimes(1);
    expect(stats?.sections).toEqual([{ section: "Paydo: продажа квартир", pages: 0, stopReason: "paydo_blocked" }]);
    expect(mocks.logError).toHaveBeenCalledWith("api", expect.stringContaining("429"), expect.anything());
    expect(mocks.gone).not.toHaveBeenCalled();
  });

  it("страница не отдалась после повторов клиента: останов, причина в журнале, исчезнувшие не трогаем", async () => {
    mocks.search.mockResolvedValue(null);
    const stats = await runPaydoIncremental();
    expect(stats?.sections).toEqual([{ section: "Paydo: продажа квартир", pages: 0, stopReason: "page_failed" }]);
    expect(mocks.logError).toHaveBeenCalled();
    expect(mocks.gone).not.toHaveBeenCalled();
  });

  it("неожиданная ошибка: тело ошибки в журнал не попадает", async () => {
    mocks.search.mockRejectedValue(new Error("секретный фрагмент ответа"));
    const stats = await runPaydoIncremental();
    expect(stats?.sections[0]).toMatchObject({ stopReason: "failed" });
    expect(JSON.stringify(mocks.logError.mock.calls)).not.toContain("секретный");
  });

  it("вышло время тика: в сеть не ходим", async () => {
    serve(3);
    const stats = await runPaydoIncremental({ maxRuntimeMs: 0 });
    expect(mocks.search).not.toHaveBeenCalled();
    expect(stats?.sections[0]).toMatchObject({ stopReason: "deadline" });
  });
});

describe("isKnownUnchanged", () => {
  const row = (price: string | null, isActive = true, currency = "TJS") => ({ sourceId: "1", price, currency, isActive });
  it("известно только при совпадении цены и валюты у активного объявления", () => {
    expect(isKnownUnchanged(row("100000"), { price: 100_000, currency: "TJS" })).toBe(true);
    expect(isKnownUnchanged(row("100000.00"), { price: 100_000, currency: "TJS" })).toBe(true);
    expect(isKnownUnchanged(row("100000"), { price: 99_000, currency: "TJS" })).toBe(false);
    expect(isKnownUnchanged(row("100000"), { price: 100_000, currency: "USD" })).toBe(false);
    expect(isKnownUnchanged(row("100000", false), { price: 100_000, currency: "TJS" })).toBe(false);
    expect(isKnownUnchanged(undefined, { price: 100_000, currency: "TJS" })).toBe(false);
    expect(isKnownUnchanged(row(null), { price: null, currency: "TJS" })).toBe(true);
    expect(isKnownUnchanged(row(null), { price: 5, currency: "TJS" })).toBe(false);
  });
});
