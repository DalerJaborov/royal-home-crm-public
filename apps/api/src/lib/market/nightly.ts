/**
 * НОЧНОЙ СБОР РЫНКА: Somon (HTML, как посетитель) + Paydo (JSON API, только чтение).
 *
 * Только квартиры и дома в Душанбе (владелец 02.11.2026): первые два раздела Somon
 * и оба раздела Paydo. Один прогон за раз (замок в памяти процесса); «исчезло»
 * помечаем только после полного обхода источника — оборванный даёт ложные «продано».
 * Включается переменной MARKET_CRAWL_ENABLED=1 (см. cron.ts) — по умолчанию выключено.
 */

import { logSystemError } from "../systemError.js";
import { markDisappeared, saveListings } from "./marketStore.js";
import { crawlPaydoSection, PAYDO_SECTIONS } from "./paydoCrawler.js";
import { PaydoBlockedError, PaydoClient } from "./paydoClient.js";
import { PAYDO_SOURCE } from "./paydoParser.js";
import { crawlSection, SECTIONS } from "./somonCrawler.js";

const SOMON_SOURCE = "somon.tj";
/** Продажа квартир и продажа домов — первые два раздела SECTIONS. */
const SOMON_NIGHTLY_SECTIONS = SECTIONS.slice(0, 2);

let running = false;

export interface NightlyStats {
  somon: { saved: number; complete: boolean };
  paydo: { saved: number; complete: boolean };
}

export async function runNightlyMarketCrawl(): Promise<NightlyStats | null> {
  if (running) return null;
  running = true;
  const stats: NightlyStats = { somon: { saved: 0, complete: true }, paydo: { saved: 0, complete: true } };
  try {
    try {
      for (const section of SOMON_NIGHTLY_SECTIONS) {
        await crawlSection(section, {
          onPage: async (listings) => {
            const s = await saveListings(SOMON_SOURCE, listings);
            stats.somon.saved += s.created + s.updated;
          },
        });
      }
    } catch (err) {
      stats.somon.complete = false;
      void logSystemError("api", `Ночной сбор Somon оборван: ${err instanceof Error ? err.message : String(err)}`);
    }
    if (stats.somon.complete) await markDisappeared(SOMON_SOURCE);

    try {
      const client = new PaydoClient();
      for (const section of PAYDO_SECTIONS) {
        await crawlPaydoSection(client, section, {
          onPage: async (listings) => {
            const s = await saveListings(PAYDO_SOURCE, listings);
            stats.paydo.saved += s.created + s.updated;
          },
        });
      }
    } catch (err) {
      stats.paydo.complete = false;
      if (!(err instanceof PaydoBlockedError)) {
        void logSystemError("api", `Ночной сбор Paydo оборван: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
    if (stats.paydo.complete) await markDisappeared(PAYDO_SOURCE);
    return stats;
  } finally {
    running = false;
  }
}
