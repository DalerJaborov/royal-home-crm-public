/**
 * ДОЗАПОЛНЕНИЕ РАЙОНА В КАТАЛОГЕ РЫНКА (14.11.2026).
 *
 * Проходит по MarketListing без района и пробует вывести его той же лестницей, что и
 * сборщик (lib/market/districtInference.ts): координаты в границе района → подпись и
 * улица в адресе → район целым фрагментом → известное место в заголовке. Район, который
 * уже есть (из источника или раньше выведенный), НЕ трогается никогда.
 *
 * Описание объявления в базе не хранится, поэтому самая богатая ступень («Район: Сино»
 * в тексте) здесь недоступна: она сработает, когда сборщик сам перечитает объявление
 * при очередном обходе. Скрипт добирает то, что видно из координат, адреса и заголовка.
 *
 * ЗАПУСК (из apps/api, там же .env с DATABASE_URL):
 *   npx tsx scripts/backfill-market-districts.ts                       — только посчитать (dry-run)
 *   npx tsx scripts/backfill-market-districts.ts --source=paydo.tj     — один источник
 *   npx tsx scripts/backfill-market-districts.ts --apply --force       — записать
 *
 * Перед записью меняемые строки (id и прежний район) сохраняются файлом в
 * <папка temp ОС>/market-district-backup-<время>.json — по нему откат: вернуть districtName в null.
 * НА ПРОДЕ запускает только владелец, отдельным «да».
 */
import { writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { prisma } from "../src/db.js";
import { resolveDistrict, type DistrictVia } from "../src/lib/market/districtInference.js";

const BATCH = 500;

function arg(name: string): string | null {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : null;
}

async function main(): Promise<void> {
  const apply = process.argv.includes("--apply");
  const force = process.argv.includes("--force");
  if (apply && !force) {
    console.error("Для записи нужны оба флага: --apply --force. Без них — только подсчёт.");
    process.exit(1);
  }
  const source = arg("source");
  const sourceWhere = source ? { source } : {};

  const total = await prisma.marketListing.count({ where: { isActive: true, ...sourceWhere } });
  const withBefore = await prisma.marketListing.count({ where: { isActive: true, districtName: { not: null }, ...sourceWhere } });
  console.log(`Активных: ${total}. С районом до: ${withBefore} (${pct(withBefore, total)}).`);

  const changes: Array<{ id: string; was: null; now: string; via: DistrictVia; title: string; landmark: string | null }> = [];
  const viaCount: Record<string, number> = {};
  let cursor: string | undefined;
  for (;;) {
    const page = await prisma.marketListing.findMany({
      where: { isActive: true, districtName: null, ...sourceWhere },
      select: { id: true, title: true, landmark: true, latitude: true, longitude: true, city: true },
      orderBy: { id: "asc" },
      take: BATCH,
      ...(cursor ? { skip: 1, cursor: { id: cursor } } : {}),
    });
    if (page.length === 0) break;
    cursor = page[page.length - 1].id;
    for (const r of page) {
      if (r.city && !/душанбе/i.test(r.city)) continue;
      const ans = await resolveDistrict({
        latitude: r.latitude == null ? null : Number(r.latitude),
        longitude: r.longitude == null ? null : Number(r.longitude),
        address: r.landmark,
        title: r.title,
      });
      if (!ans.name || !ans.via) continue;
      viaCount[ans.via] = (viaCount[ans.via] ?? 0) + 1;
      changes.push({ id: r.id, was: null, now: ans.name, via: ans.via, title: r.title, landmark: r.landmark });
    }
  }

  const after = withBefore + changes.length;
  console.log(`Можно заполнить: ${changes.length}. С районом после: ${after} (${pct(after, total)}). По ступеням:`, viaCount);
  for (const c of changes.slice(0, 15)) console.log(`  ${c.now} ← [${c.via}] ${c.title} | ${c.landmark ?? "—"}`);

  if (!apply) {
    console.log("Dry-run: ничего не записано. Для записи: --apply --force.");
    return;
  }
  const file = join(tmpdir(), `market-district-backup-${new Date().toISOString().replace(/[:.]/g, "-")}.json`);
  writeFileSync(file, JSON.stringify(changes.map((c) => ({ id: c.id, was: c.was, now: c.now, via: c.via }))));
  console.log(`Копия меняемых строк: ${file}`);
  let written = 0;
  for (const c of changes) {
    // where districtName: null — вторая страховка: район, появившийся с момента подсчёта, не затираем.
    const res = await prisma.marketListing.updateMany({ where: { id: c.id, districtName: null }, data: { districtName: c.now } });
    written += res.count;
  }
  const finalCount = await prisma.marketListing.count({ where: { isActive: true, districtName: { not: null }, ...sourceWhere } });
  console.log(`Записано: ${written}. С районом теперь: ${finalCount} (${pct(finalCount, total)}).`);
}

function pct(n: number, d: number): string {
  return d ? `${((n / d) * 100).toFixed(1)}%` : "—";
}

main()
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
