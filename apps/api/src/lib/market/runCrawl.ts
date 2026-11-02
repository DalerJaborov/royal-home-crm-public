/**
 * Ручной запуск обхода Somon: `npx tsx src/lib/market/runCrawl.ts [разделов]`.
 *
 * Отдельной точкой входа, а не кроном: первый полный сбор запускается руками и
 * под присмотром. Идёт через ту же дверь `fetchSomon` (общий бюджет, темп 10 с),
 * поэтому 150 страниц — около получаса; с тем же замком, что и еженедельный
 * прогон (`runMarketFullCrawl`), — вдвоём они не пойдут.
 */

import { prisma } from "../../db.js";
import { crawlSection, SECTIONS } from "./somonCrawler.js";
import { markDisappeared, saveListings } from "./marketStore.js";
import { withMarketCrawlLock } from "./nightly.js";

const SOURCE = "somon.tj";

async function main(): Promise<void> {
  const only = process.argv[2] ? Number(process.argv[2]) : SECTIONS.length;
  const sections = SECTIONS.slice(0, only);
  const started = Date.now();
  let created = 0;
  let updated = 0;
  let priceChanges = 0;
  let complete = sections.length === SECTIONS.length;

  const locked = await withMarketCrawlLock(async () => {
    for (const section of sections) {
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
      console.log(`  страниц обойдено: ${result.pagesFetched}, объявлений: ${result.listingCount}`);
      if (!result.complete) {
        complete = false;
        console.error(`  обход раздела неполный: ${result.stopReason}`);
        break;
      }
    }
  });
  if (!locked) {
    console.error("Полный обход рынка уже идёт (замок занят) — ничего не запущено.");
    await prisma.$disconnect();
    return;
  }

  // «Исчезло» помечаем только после полного обхода всех разделов.
  const gone = complete ? await markDisappeared(SOURCE) : 0;
  const total = await prisma.marketListing.count();
  const minutes = Math.round((Date.now() - started) / 60000);

  console.log(`\n==== ИТОГ (${minutes} мин) ====`);
  console.log(`новых: ${created}, обновлено: ${updated}, изменений цены: ${priceChanges}`);
  console.log(complete ? `помечено исчезнувшими: ${gone}` : "обход неполный — исчезнувшие не помечались");
  console.log(`всего в базе: ${total}`);
  await prisma.$disconnect();
}

main().catch(async (err) => {
  console.error("Обход прерван:", err);
  await prisma.$disconnect();
  process.exit(1);
});
