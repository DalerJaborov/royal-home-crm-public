/**
 * КАК ЧАСТО ИДЁТ ПОЛНЫЙ ОБХОД SOMON (17.11.2026, решение диспетчера: владелец частоту не выбрал —
 * поведение прода по умолчанию не меняем).
 *
 * `MARKET_SOMON_CRAWL_SCHEDULE`:
 *  - пусто или `weekly` — раз в неделю, воскресенье 02:45 по Душанбе (как было до 17.11; на 15 минут позже
 *    прежних 02:30, потому что ночной Paydo теперь в 02:30, а замок обходов общий — иначе в воскресенье один
 *    из двух тихо пропускался бы);
 *  - `nightly` — каждую ночь в 02:45 (подбор под клиентов берёт только то, что сбор видел за 3 суток);
 *  - любое другое значение — раз в неделю, и одна запись в журнал ошибок (cron.ts).
 * Сам обход по-прежнему включает `MARKET_CRAWL_ENABLED=1`. Значение читается при старте worker:
 * поменять — пересоздать контейнеры api/worker.
 */
export const SOMON_CRAWL_WEEKLY_CRON = "45 2 * * 0";
export const SOMON_CRAWL_NIGHTLY_CRON = "45 2 * * *";

export interface SomonCrawlSchedule {
  mode: "weekly" | "nightly";
  cron: string;
  /** Значение переменной, которое не распознали (тогда mode = weekly). */
  invalid?: string;
}

export function somonCrawlSchedule(env: Readonly<Record<string, string | undefined>> = process.env): SomonCrawlSchedule {
  const raw = (env.MARKET_SOMON_CRAWL_SCHEDULE ?? "").trim();
  const value = raw.toLowerCase();
  if (value === "nightly") return { mode: "nightly", cron: SOMON_CRAWL_NIGHTLY_CRON };
  if (value === "" || value === "weekly") return { mode: "weekly", cron: SOMON_CRAWL_WEEKLY_CRON };
  return { mode: "weekly", cron: SOMON_CRAWL_WEEKLY_CRON, invalid: raw.slice(0, 40) };
}
