import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ fetchSomon: vi.fn(), stopped: vi.fn(), logError: vi.fn() }));
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

import { SomonSourceUnavailable } from "../src/lib/somonLeads/sourceClient.js";
import { crawlSection, parseSomonPage, saveSomonPageHtml, SECTIONS, somonPageRubricId } from "../src/lib/market/somonCrawler.js";
import { RUBRIC_FOREIGN, RUBRIC_HOUSES, somonListPageHtml } from "./helpers/somonPage.js";

const APARTMENTS = SECTIONS[0];
const HOUSES = SECTIONS[1];

/** Страница списка квартир Somon: объявления своей рубрики + ссылки пагинации до `links`. */
function pageHtml(ids: number[], links: number): string {
  return somonListPageHtml(ids.map((id) => ({ id, title: "2-комн. квартира, 3 этаж, 50 м², Сино" })), { links });
}
const ok = (html: string) => new Response(html);
const blocked = (status: number) => new SomonSourceUnavailable("http", status);
const notReady = () => new SomonSourceUnavailable("not_ready");
const pause = vi.fn(async () => {});

beforeEach(() => {
  vi.clearAllMocks();
  mocks.stopped.mockResolvedValue(false);
  mocks.logError.mockResolvedValue(undefined);
});

describe("обход Somon идёт только через общую дверь fetchSomon", () => {
  it("проходит все страницы по порядку, в фоновом режиме, и сообщает о полном обходе", async () => {
    mocks.fetchSomon.mockImplementation(async (path: string) => {
      const n = Number(/page=(\d+)/.exec(path)?.[1] ?? 1);
      return ok(pageHtml([n * 10 + 1, n * 10 + 2], 3));
    });
    const onPage = vi.fn(async () => {});
    const result = await crawlSection(APARTMENTS, { pause, onPage });
    expect(result).toMatchObject({ complete: true, pagesFetched: 3, listingCount: 6 });
    expect(mocks.fetchSomon.mock.calls.map((c) => c[0])).toEqual([
      "/nedvizhimost/prodazha-kvartir/dushanbe/",
      "/nedvizhimost/prodazha-kvartir/dushanbe/?page=2",
      "/nedvizhimost/prodazha-kvartir/dushanbe/?page=3",
    ]);
    for (const call of mocks.fetchSomon.mock.calls) expect(call[3]).toEqual({ background: true });
    expect(onPage).toHaveBeenCalledTimes(3);
    expect(mocks.logError).not.toHaveBeenCalled();
  });

  it("не верит окну пагинации: конец раздела там, где страница не ссылается дальше", async () => {
    // Страница N показывает ссылки только до N+1; всего их 4.
    mocks.fetchSomon.mockImplementation(async (path: string) => {
      const n = Number(/page=(\d+)/.exec(path)?.[1] ?? 1);
      return ok(pageHtml([n * 10 + 1], Math.min(n + 1, 4)));
    });
    const result = await crawlSection(APARTMENTS, { pause });
    expect(result).toMatchObject({ complete: true, pagesFetched: 4 });
  });

  it("уступает бюджету: слот не готов — ждёт и повторяет, а не ломится", async () => {
    mocks.fetchSomon.mockRejectedValueOnce(notReady()).mockRejectedValueOnce(notReady()).mockResolvedValueOnce(ok(pageHtml([1], 1)));
    const result = await crawlSection(APARTMENTS, { pause });
    expect(result.complete).toBe(true);
    expect(pause).toHaveBeenCalledTimes(2);
    expect(pause).toHaveBeenCalledWith(5000);
  });

  it("не ждёт вечно: после лимита ожидания обход неполный", async () => {
    mocks.fetchSomon.mockRejectedValue(notReady());
    const result = await crawlSection(APARTMENTS, { pause });
    expect(result).toMatchObject({ complete: false, stopReason: "wait_timeout", pagesFetched: 0 });
    expect(pause).toHaveBeenCalledTimes(60);
  });

  it("источник остановлен общим бюджетом — сразу стоп, без ожидания", async () => {
    mocks.fetchSomon.mockRejectedValue(notReady());
    mocks.stopped.mockResolvedValue(true);
    const result = await crawlSection(APARTMENTS, { pause });
    expect(result).toMatchObject({ complete: false, stopReason: "source_stopped" });
    expect(pause).not.toHaveBeenCalled();
  });

  it("403 — немедленный стоп без повторов, в журнале только код и номер страницы", async () => {
    mocks.fetchSomon.mockResolvedValueOnce(ok(pageHtml([1], 5))).mockRejectedValueOnce(blocked(403));
    const result = await crawlSection(APARTMENTS, { pause });
    expect(result).toMatchObject({ complete: false, stopReason: "forbidden", pagesFetched: 1 });
    expect(mocks.fetchSomon).toHaveBeenCalledTimes(2);
    expect(mocks.logError).toHaveBeenCalledTimes(1);
    const message = String(mocks.logError.mock.calls[0][1]);
    expect(message).toContain("стр. 2");
    expect(message).toContain("403");
    expect(message).not.toMatch(/somon\.tj|https?:/);
  });

  it("429 — стоп без повторов", async () => {
    mocks.fetchSomon.mockRejectedValue(blocked(429));
    const result = await crawlSection(APARTMENTS, { pause });
    expect(result).toMatchObject({ complete: false, stopReason: "rate_limited" });
    expect(mocks.fetchSomon).toHaveBeenCalledTimes(1);
  });

  it("сбой 5xx: одна повторная попытка, потом стоп (никаких штормов)", async () => {
    mocks.fetchSomon.mockRejectedValue(blocked(503));
    const result = await crawlSection(APARTMENTS, { pause });
    expect(result).toMatchObject({ complete: false, stopReason: "unavailable" });
    expect(mocks.fetchSomon).toHaveBeenCalledTimes(2);
  });

  it("разовый сбой сети лечится одним повтором", async () => {
    mocks.fetchSomon.mockRejectedValueOnce(new SomonSourceUnavailable("network", undefined, "ECONNRESET")).mockResolvedValue(ok(pageHtml([1], 1)));
    const result = await crawlSection(APARTMENTS, { pause });
    expect(result.complete).toBe(true);
  });

  it("пустая страница до известного конца — не «конец выдачи», а неполный обход", async () => {
    mocks.fetchSomon.mockResolvedValueOnce(ok(pageHtml([1], 3))).mockResolvedValueOnce(ok(pageHtml([], 3)));
    const result = await crawlSection(APARTMENTS, { pause });
    expect(result).toMatchObject({ complete: false, stopReason: "layout_changed" });
  });

  it("страница без данных Next — вёрстка изменилась", async () => {
    mocks.fetchSomon.mockResolvedValue(ok("<html>captcha</html>"));
    const result = await crawlSection(APARTMENTS, { pause });
    expect(result).toMatchObject({ complete: false, stopReason: "layout_changed" });
  });

  describe("рынок сжался за время обхода: 404 на странице, на которую ссылалась прошлая", () => {
    const missing = () => new SomonSourceUnavailable("http", 404);

    it("свежая предыдущая страница уже не ссылается дальше — это конец раздела, обход полный", async () => {
      // 1: ссылки до 4; 2: до 4; 3: до 4; страница 4 — 404; перекачанная 3 — ссылок на 4 уже нет.
      let thirdFetched = 0;
      mocks.fetchSomon.mockImplementation(async (path: string) => {
        const n = Number(/page=(\d+)/.exec(path)?.[1] ?? 1);
        if (n === 4) throw missing();
        if (n === 3 && ++thirdFetched === 2) return ok(pageHtml([31], 3));
        return ok(pageHtml([n * 10 + 1], 4));
      });
      const result = await crawlSection(APARTMENTS, { pause });
      expect(result).toMatchObject({ complete: true, pagesFetched: 3 });
      expect(mocks.logError).not.toHaveBeenCalled();
      expect(mocks.fetchSomon.mock.calls.map((c) => c[0])).toEqual([
        "/nedvizhimost/prodazha-kvartir/dushanbe/",
        "/nedvizhimost/prodazha-kvartir/dushanbe/?page=2",
        "/nedvizhimost/prodazha-kvartir/dushanbe/?page=3",
        "/nedvizhimost/prodazha-kvartir/dushanbe/?page=4",
        "/nedvizhimost/prodazha-kvartir/dushanbe/?page=3",
      ]);
    });

    it("предыдущая страница всё ещё ссылается на пропавшую — это сбой, обход неполный", async () => {
      mocks.fetchSomon.mockImplementation(async (path: string) => {
        const n = Number(/page=(\d+)/.exec(path)?.[1] ?? 1);
        if (n === 4) throw missing();
        return ok(pageHtml([n * 10 + 1], 4));
      });
      const result = await crawlSection(APARTMENTS, { pause });
      expect(result).toMatchObject({ complete: false, stopReason: "unavailable", pagesFetched: 3 });
    });

    it("проверка не удалась (предыдущая тоже недоступна) — не подтверждение", async () => {
      let third = 0;
      mocks.fetchSomon.mockImplementation(async (path: string) => {
        const n = Number(/page=(\d+)/.exec(path)?.[1] ?? 1);
        if (n === 4 || (n === 3 && ++third === 2)) throw missing();
        return ok(pageHtml([n * 10 + 1], 4));
      });
      expect((await crawlSection(APARTMENTS, { pause })).complete).toBe(false);
    });

    it("404 на первой странице конца раздела не означает", async () => {
      mocks.fetchSomon.mockRejectedValue(missing());
      expect(await crawlSection(APARTMENTS, { pause })).toMatchObject({ complete: false, stopReason: "unavailable" });
      expect(mocks.fetchSomon).toHaveBeenCalledTimes(1);
    });
  });

  it("ошибка записи в базу останавливает обход как неполный", async () => {
    mocks.fetchSomon.mockResolvedValue(ok(pageHtml([1], 2)));
    const result = await crawlSection(APARTMENTS, {
      pause,
      onPage: async () => {
        throw new Error("db down");
      },
    });
    expect(result).toMatchObject({ complete: false, stopReason: "save_failed" });
    expect(String(mocks.logError.mock.calls[0][1])).not.toContain("db down");
  });

  it("shouldStop (время вышло / замок потерян) останавливает до следующего запроса", async () => {
    mocks.fetchSomon.mockResolvedValue(ok(pageHtml([1], 5)));
    let calls = 0;
    const result = await crawlSection(APARTMENTS, { pause, shouldStop: () => calls++ >= 1 });
    expect(result).toMatchObject({ complete: false, stopReason: "deadline", pagesFetched: 1 });
    expect(mocks.logError).not.toHaveBeenCalled();
  });
});

describe("своя рубрика — или ничего (12.11.2026: общая лента вместо раздела домов)", () => {
  it("сайт отдал общую ленту «Все объявления» — стоп wrong_scope на первой странице, ничего не записано", async () => {
    // Так выглядел адрес /nedvizhimost/prodazha-domov/dushanbe/ 12.11.2026: "rubric":{} и 9 326 страниц.
    const feed = somonListPageHtml(
      [{ id: 1, rubricId: RUBRIC_FOREIGN, title: "Услуги по установке газ оборудования" }, { id: 2, rubricId: RUBRIC_HOUSES, title: "2 этажн. 5-комн. дом, 2 соток, Зарафшон" }],
      { pageRubricId: null, links: 9326 }
    );
    mocks.fetchSomon.mockResolvedValue(ok(feed));
    const onPage = vi.fn(async () => {});
    const result = await crawlSection(HOUSES, { pause, onPage });
    expect(result).toMatchObject({ complete: false, stopReason: "wrong_scope", pagesFetched: 1 });
    expect(onPage).not.toHaveBeenCalled();
    expect(mocks.fetchSomon).toHaveBeenCalledTimes(1);
    expect(String(mocks.logError.mock.calls[0][1])).toContain("wrong_scope");
  });

  it("чужие объявления на странице своего раздела не пишутся, тип берётся из рубрики", async () => {
    const html = somonListPageHtml(
      [{ id: 1 }, { id: 2, rubricId: RUBRIC_FOREIGN, title: "Ноутбук HP core i5" }, { id: 3, rubricId: RUBRIC_HOUSES, title: "1 этажн. 3-комн. дом, 2 сотки, Сино" }],
      { links: 1 }
    );
    const page = parseSomonPage(html, APARTMENTS);
    expect(page).toMatchObject({ inScope: true, adsTotal: 3 });
    expect(page.listings.map((l) => [l.sourceId, l.dealType, l.propertyType])).toEqual([["1", "SALE", "APARTMENT"]]);

    mocks.fetchSomon.mockResolvedValue(ok(html));
    const onPage = vi.fn(async () => {});
    const result = await crawlSection(APARTMENTS, { pause, onPage });
    expect(result).toMatchObject({ complete: true, listingCount: 1, foreignSkipped: 2 });
    expect((onPage.mock.calls[0] as unknown[])[0]).toHaveLength(1);
  });

  it("последняя известная страница без единого объявления своей рубрики — конец раздела, обход полный", async () => {
    mocks.fetchSomon.mockImplementation(async (path: string) => {
      const n = Number(/page=(\d+)/.exec(path)?.[1] ?? 1);
      if (n === 1) return ok(pageHtml([11, 12], 2));
      return ok(somonListPageHtml([{ id: 900 + n, rubricId: RUBRIC_FOREIGN, title: "Автозапчасти" }], { links: 2 }));
    });
    const onPage = vi.fn(async () => {});
    const result = await crawlSection(APARTMENTS, { pause, onPage });
    expect(result).toMatchObject({ complete: true, pagesFetched: 2, listingCount: 2, foreignSkipped: 1 });
    expect(onPage).toHaveBeenCalledTimes(1);
    expect(mocks.fetchSomon).toHaveBeenCalledTimes(2);
    // в журнале — только запись о чужой рубрике, не об остановке обхода
    expect(mocks.logError.mock.calls.map((c) => (c[2] as { dedupKey: string }).dedupKey)).toEqual([`market-somon-foreign-rubric-216-${RUBRIC_FOREIGN}`]);
  });

  it("страница только чужих рубрик РАНЬШЕ известного конца — не конец, а wrong_scope: обход неполный", async () => {
    mocks.fetchSomon.mockImplementation(async (path: string) => {
      const n = Number(/page=(\d+)/.exec(path)?.[1] ?? 1);
      if (n === 1) return ok(pageHtml([11, 12], 50));
      return ok(somonListPageHtml([{ id: 900 + n, rubricId: RUBRIC_FOREIGN, title: "Автозапчасти" }], { links: 50 }));
    });
    const onPage = vi.fn(async () => {});
    const result = await crawlSection(APARTMENTS, { pause, onPage });
    expect(result).toMatchObject({ complete: false, stopReason: "wrong_scope", pagesFetched: 2 });
    expect(mocks.fetchSomon).toHaveBeenCalledTimes(2);
  });

  it("чужая рубрика на своей странице — в журнал, по записи на номер рубрики (новая подрубрика не пропадёт молча)", async () => {
    const html = somonListPageHtml(
      [{ id: 1 }, { id: 2, rubricId: 2841, title: "7-комн. квартира, 2 этаж, 300 м², Сино" }, { id: 3, rubricId: 2841, title: "7-комн. квартира" }, { id: 4, rubricId: RUBRIC_FOREIGN }],
      { links: 1 }
    );
    mocks.fetchSomon.mockResolvedValue(ok(html));
    const result = await crawlSection(APARTMENTS, { pause });
    expect(result).toMatchObject({ complete: true, listingCount: 1, foreignSkipped: 3 });
    const keys = mocks.logError.mock.calls.map((c) => (c[2] as { dedupKey: string }).dedupKey).sort();
    expect(keys).toEqual([`market-somon-foreign-rubric-216-${RUBRIC_FOREIGN}`, "market-somon-foreign-rubric-216-2841"].sort());
    expect(String(mocks.logError.mock.calls.find((c) => String(c[1]).includes("2841"))![1])).toContain("(2 на странице)");
  });

  it("рубрика страницы читается при любом порядке ключей в её объекте", () => {
    const payload = (rubric: object) => JSON.stringify({ next_page: "?cursor=1&page_size=1", rubric, location_ids: [1], adverts: [] });
    expect(somonPageRubricId(payload({ id: 216, name: "Продажа квартир", slug: "prodazha-kvartir" }))).toBe(216);
    expect(somonPageRubricId(payload({ name: "Продажа квартир", is_job: false, ancestors: [{ id: 121 }], id: 216 }))).toBe(216);
    expect(somonPageRubricId(payload({}))).toBeNull();
    expect(somonPageRubricId(payload({ id: "216" }))).toBeNull();
    // предок с id не путается с самой рубрикой
    expect(somonPageRubricId(payload({ ancestors: [{ id: 121 }], slug: "x" }))).toBeNull();
  });

  it("парсер лидов: чужой список в каталог не пишется, но и не молчит — запись в журнал", async () => {
    const feed = somonListPageHtml([{ id: 1, rubricId: RUBRIC_FOREIGN }], { pageRubricId: null, links: 9326 });
    const stats = await saveSomonPageHtml(feed);
    expect(stats).toEqual({ created: 0, updated: 0, priceChanges: 0, skipped: 0 });
    expect(mocks.logError).toHaveBeenCalledTimes(1);
    expect((mocks.logError.mock.calls[0][2] as { dedupKey: string }).dedupKey).toBe("somon-market-ingest-wrong-scope-216");
  });

  it("раздел домов читается по новому адресу; дом — HOUSE, этажность и сотки из заголовка", async () => {
    expect(HOUSES.path).toBe("/nedvizhimost/prodazha-domov-havli-i-dach/dushanbe/");
    const html = somonListPageHtml(
      [{ id: 7, rubricId: RUBRIC_HOUSES, title: "3 этажн. 6-комн. дом, 3 соток, Конституция, Бозори Балх", price_without_currency: "3880000" }],
      { pageRubricId: RUBRIC_HOUSES }
    );
    const [house] = parseSomonPage(html, HOUSES).listings;
    expect(house).toMatchObject({ propertyType: "HOUSE", dealType: "SALE", rooms: 6, totalFloors: 3, floor: null, landSotki: 3, areaSqm: null, landmark: "Конституция" });
    // страница квартир для раздела домов — чужой список
    expect(parseSomonPage(pageHtml([1], 1), HOUSES)).toMatchObject({ inScope: false, listings: [] });
  });

  it("предел страниц, заданный вызывающим (инкремент), — не сбой: в журнал не пишется", async () => {
    mocks.fetchSomon.mockImplementation(async (path: string) => {
      const n = Number(/page=(\d+)/.exec(path)?.[1] ?? 1);
      return ok(pageHtml([n * 10 + 1], 100));
    });
    const result = await crawlSection(APARTMENTS, { pause, maxPages: 3 });
    expect(result).toMatchObject({ complete: false, stopReason: "page_limit", pagesFetched: 3 });
    expect(mocks.logError).not.toHaveBeenCalled();
  });
});
