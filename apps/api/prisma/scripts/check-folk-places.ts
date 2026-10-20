/**
 * ЧТО ИЗ НАРОДНЫХ НАЗВАНИЙ КАРТА УЖЕ ЗНАЕТ, А ЧТО НЕТ (20.09.2026).
 *
 * Список народных названий (`src/ai/folkPlaces.ts`) печатается боту не целиком:
 * название, которое карта знает и относит к тому же району, из промта уходит.
 * Этот скрипт показывает разбор целиком — что ушло, что осталось и почему.
 *
 * ЗАПУСК (из apps/api, там же .env с DATABASE_URL):
 *   npx tsx prisma/scripts/check-folk-places.ts
 *
 * Ничего не меняет ни при каких флагах: недостающие места заводятся руками,
 * точкой на карте, в справочнике ориентиров (Настройки → Агентство). Выдумать
 * координату за человека нельзя — ей потом поверят и подбор, и объявление на сайте.
 */
import { prisma } from "../../src/db.js";
import { folkCoverage } from "../../src/ai/folkPlaces.js";

async function main(): Promise<void> {
  const aliases = await prisma.geoAlias.count();
  const boundaries = await prisma.district.count({ where: { boundary: { not: null } } });
  if (aliases === 0) {
    console.log(
      "Словарь синонимов пуст — сверять не с чем.\n" +
        "Сначала загрузите слой: npx tsx prisma/scripts/import-geo.ts"
    );
    return;
  }
  console.log(`Справочник: синонимов ${aliases}, районов с границей ${boundaries}.\n`);

  const rows = await folkCoverage();
  const known = rows.filter((r) => r.onMap && r.mapDistrict === r.place.district);
  const conflicting = rows.filter((r) => r.onMap && r.mapDistrict !== null && r.mapDistrict !== r.place.district);
  const noDistrict = rows.filter((r) => r.onMap && r.mapDistrict === null);
  const missing = rows.filter((r) => !r.onMap);

  console.log(`Карта знает и район совпал — из промта убраны (${known.length}):`);
  for (const r of known) console.log(`  ${r.place.name} — ${r.mapDistrict}`);

  console.log(`\nКарта знает, но район РАСХОДИТСЯ — остались в промте (${conflicting.length}):`);
  for (const r of conflicting) console.log(`  ${r.place.name}: в списке ${r.place.district}, по карте ${r.mapDistrict}`);

  console.log(`\nКарта знает, но район по точке не определился (${noDistrict.length}):`);
  for (const r of noDistrict) console.log(`  ${r.place.name} — в списке ${r.place.district}`);

  console.log(`\nКарта НЕ знает — завести руками в справочнике ориентиров (${missing.length}):`);
  for (const r of missing) console.log(`  ${r.place.name} — ${r.place.district}`);
}

main()
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
