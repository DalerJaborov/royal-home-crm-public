/**
 * Ручной запуск обхода Paydo: `npx tsx src/lib/market/runPaydoCrawl.ts [разделов] [макс. страниц]`.
 * Только чтение с Paydo; пишем в свою базу. 201 — квартиры, 203 — дома/хавли.
 */

import { prisma } from "../../db.js";
import { PaydoBlockedError, PaydoClient } from "./paydoClient.js";
import { crawlPaydoSection, PAYDO_SECTIONS, paydoRunComplete, type PaydoCrawlResult } from "./paydoCrawler.js";
import { PAYDO_SOURCE } from "./paydoParser.js";
import { DISAPPEAR_AFTER_HOURS, markDisappeared, saveListings } from "./marketStore.js";
import { withMarketCrawlLock } from "./nightly.js";

async function main(): Promise<void> {
  const only = process.argv[2] ? Number(process.argv[2]) : PAYDO_SECTIONS.length;
  const maxPages = process.argv[3] ? Number(process.argv[3]) : undefined;
  const sections = PAYDO_SECTIONS.slice(0, only);
  const client = new PaydoClient();
  const started = Date.now();
  let created = 0;
  let updated = 0;
  let priceChanges = 0;
  const results: PaydoCrawlResult[] = [];

  // Тот же замок, что у недельного обхода и ручного обхода Somon: вдвоём они не пойдут.
  const locked = await withMarketCrawlLock(async () => {
    for (const section of sections) {
      console.log(`
=== ${section.label} ===`);
      try {
        const result = await crawlPaydoSection(client, section, {
          maxPages,
          onPage: async (listings, page) => {
            const stats = await saveListings(PAYDO_SOURCE, listings);
            created += stats.created;
            updated += stats.updated;
            priceChanges += stats.priceChanges;
            if (page === 1 || page % 25 === 0) {
              console.log(`  стр ${page}: +${stats.created} новых, ${stats.updated} обновлено (всего: ${created + updated})`);
            }
          },
        });
        results.push(result);
        console.log(`  страниц: ${result.pagesFetched}, объявлений: ${result.listings.length}`);
        if (!result.complete) {
          console.error(`  обход раздела неполный: ${result.stopReason}`);
          break;
        }
      } catch (err) {
        if (err instanceof PaydoBlockedError) {
          console.error(`  ${err.message}`);
          break;
        }
        throw err;
      }
    }
  });
  if (!locked) {
    console.error("Полный обход рынка уже идёт (замок занят) — ничего не запущено.");
    await prisma.$disconnect();
    return;
  }

  // «Исчезло» помечаем только после полного обхода ВСЕХ разделов (аргумент «разделов» меньше
  // каталога, обрыв, 0 страниц — всё это неполный обход) и только тех, кого не видели дольше порога.
  const complete = paydoRunComplete(sections.length, results);
  const gone = complete ? await markDisappeared(PAYDO_SOURCE, DISAPPEAR_AFTER_HOURS) : 0;
  const minutes = Math.round((Date.now() - started) / 60000);
  console.log(`
==== ИТОГ (${minutes} мин) ====`);
  console.log(`новых: ${created}, обновлено: ${updated}, изменений цены: ${priceChanges}`);
  console.log(complete ? `помечено исчезнувшими: ${gone}` : "обход неполный — исчезнувшие не помечались");
  await prisma.$disconnect();
}

main().catch(async (err) => {
  console.error("Обход прерван:", err);
  await prisma.$disconnect();
  process.exit(1);
});
