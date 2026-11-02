/**
 * Ручной запуск обхода: `npx tsx src/lib/market/runCrawl.ts [разделов]`.
 *
 * Отдельной точкой входа, а не кроном: первый полный сбор запускается руками и
 * под присмотром, а по расписанию его ставят уже после того, как стало видно,
 * сколько он длится и сколько приносит.
 */

import { prisma } from "../../db.js";
import { crawlSection, SECTIONS } from "./somonCrawler.js";
import { markDisappeared, saveListings } from "./marketStore.js";

const SOURCE = "somon.tj";

async function main(): Promise<void> {
  const only = process.argv[2] ? Number(process.argv[2]) : SECTIONS.length;
  const started = Date.now();
  let created = 0;
  let updated = 0;
  let priceChanges = 0;

  for (const section of SECTIONS.slice(0, only)) {
    console.log(`\n=== ${section.label} ===`);
    const result = await crawlSection(section, {
      onPage: async (listings, page, total) => {
        const stats = await saveListings(SOURCE, listings);
        created += stats.created;
        updated += stats.updated;
        priceChanges += stats.priceChanges;
        if (page === 1 || page % 10 === 0 || page === total) {
          console.log(
            `  стр ${page}/${total}: +${stats.created} новых, ${stats.updated} обновлено` +
              `${stats.skipped ? `, пропущено ${stats.skipped}` : ""} (всего собрано: ${created + updated})`
          );
        }
      },
    });
    console.log(`  страниц обойдено: ${result.pagesFetched}, объявлений: ${result.listings.length}`);
  }

  const gone = await markDisappeared(SOURCE);
  const total = await prisma.marketListing.count();
  const minutes = Math.round((Date.now() - started) / 60000);

  console.log(`\n==== ИТОГ (${minutes} мин) ====`);
  console.log(`новых: ${created}, обновлено: ${updated}, изменений цены: ${priceChanges}`);
  console.log(`помечено исчезнувшими: ${gone}`);
  console.log(`всего в базе: ${total}`);
  await prisma.$disconnect();
}

main().catch(async (err) => {
  console.error("Обход прерван:", err);
  await prisma.$disconnect();
  process.exit(1);
});
