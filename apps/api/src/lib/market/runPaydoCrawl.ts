/**
 * Ручной запуск обхода Paydo: `npx tsx src/lib/market/runPaydoCrawl.ts [разделов] [макс. страниц]`.
 * Только чтение с Paydo; пишем в свою базу. 201 — квартиры, 203 — дома/хавли.
 */

import { prisma } from "../../db.js";
import { PaydoBlockedError, PaydoClient } from "./paydoClient.js";
import { crawlPaydoSection, PAYDO_SECTIONS } from "./paydoCrawler.js";
import { PAYDO_SOURCE } from "./paydoParser.js";
import { markDisappeared, saveListings } from "./marketStore.js";

async function main(): Promise<void> {
  const only = process.argv[2] ? Number(process.argv[2]) : PAYDO_SECTIONS.length;
  const maxPages = process.argv[3] ? Number(process.argv[3]) : undefined;
  const client = new PaydoClient();
  const started = Date.now();
  let created = 0;
  let updated = 0;
  let priceChanges = 0;
  let complete = true;

  for (const section of PAYDO_SECTIONS.slice(0, only)) {
    console.log(`\n=== ${section.label} ===`);
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
      console.log(`  страниц: ${result.pagesFetched}, объявлений: ${result.listings.length}`);
      if (maxPages && result.pagesFetched >= maxPages) complete = false;
    } catch (err) {
      if (err instanceof PaydoBlockedError) {
        console.error(`  ${err.message}`);
        complete = false;
        break;
      }
      throw err;
    }
  }

  // «Исчезло» помечаем только после полного обхода: оборванный даёт ложные исчезновения.
  const gone = complete ? await markDisappeared(PAYDO_SOURCE) : 0;
  const minutes = Math.round((Date.now() - started) / 60000);
  console.log(`\n==== ИТОГ (${minutes} мин) ====`);
  console.log(`новых: ${created}, обновлено: ${updated}, изменений цены: ${priceChanges}`);
  console.log(complete ? `помечено исчезнувшими: ${gone}` : "обход неполный — исчезнувшие не помечались");
  await prisma.$disconnect();
}

main().catch(async (err) => {
  console.error("Обход прерван:", err);
  await prisma.$disconnect();
  process.exit(1);
});
