import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { SOMON_CRAWL_NIGHTLY_CRON, SOMON_CRAWL_WEEKLY_CRON, somonCrawlSchedule } from "../src/lib/market/somonCrawlSchedule.js";

/**
 * ЧАСТОТА ПОЛНОГО ОБХОДА SOMON (17.11.2026). Владелец не выбрал между «каждую ночь» и «раз в неделю»,
 * поэтому без переменной поведение прода прежнее — раз в неделю. Ночной обход — только явным `nightly`.
 */
describe("MARKET_SOMON_CRAWL_SCHEDULE", () => {
  it("без переменной — раз в неделю (воскресенье 02:45)", () => {
    expect(somonCrawlSchedule({})).toEqual({ mode: "weekly", cron: "45 2 * * 0" });
    expect(SOMON_CRAWL_WEEKLY_CRON).toBe("45 2 * * 0");
  });

  it("weekly и пустая строка — раз в неделю", () => {
    expect(somonCrawlSchedule({ MARKET_SOMON_CRAWL_SCHEDULE: "weekly" })).toEqual({ mode: "weekly", cron: SOMON_CRAWL_WEEKLY_CRON });
    expect(somonCrawlSchedule({ MARKET_SOMON_CRAWL_SCHEDULE: "  " })).toEqual({ mode: "weekly", cron: SOMON_CRAWL_WEEKLY_CRON });
  });

  it("nightly — каждую ночь в 02:45", () => {
    expect(somonCrawlSchedule({ MARKET_SOMON_CRAWL_SCHEDULE: "nightly" })).toEqual({ mode: "nightly", cron: "45 2 * * *" });
    expect(somonCrawlSchedule({ MARKET_SOMON_CRAWL_SCHEDULE: " NIGHTLY " }).cron).toBe(SOMON_CRAWL_NIGHTLY_CRON);
  });

  it("мусор — раз в неделю и пометка, что значение не распознано", () => {
    expect(somonCrawlSchedule({ MARKET_SOMON_CRAWL_SCHEDULE: "daily" })).toEqual({ mode: "weekly", cron: SOMON_CRAWL_WEEKLY_CRON, invalid: "daily" });
  });

  it("крон берёт расписание из этой функции, а не строкой; переменная доходит до контейнера", () => {
    const cron = readFileSync(fileURLToPath(new URL("../src/cron.ts", import.meta.url)), "utf8");
    expect(cron).toMatch(/"market-weekly-crawl",\s*somonSchedule\.cron,/);
    const compose = readFileSync(fileURLToPath(new URL("../../../docker-compose.prod.yml", import.meta.url)), "utf8");
    expect(compose).toContain("MARKET_SOMON_CRAWL_SCHEDULE:");
  });
});
