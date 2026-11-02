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
import { crawlSection, SECTIONS } from "../src/lib/market/somonCrawler.js";

const APARTMENTS = SECTIONS[0];

/** Страница списка Somon: объявления в Next-payload + ссылки пагинации до `links`. */
function pageHtml(ids: number[], links: number): string {
  const ads = ids.map((id) => ({ id, title: "2-комн. квартира, 50 м², 3/9 этаж", url: `/adv/${id}_stand/`, price_without_currency: "500000", currency: "TJS" }));
  const data = JSON.stringify({ adverts: ads });
  const anchors = Array.from({ length: links }, (_, i) => `<a href="?page=${i + 1}">${i + 1}</a>`).join("");
  return `${anchors}<script>self.__next_f.push([1,${JSON.stringify(data)}]);</script>`;
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
