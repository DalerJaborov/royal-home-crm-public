/**
 * ЧИСТКА АРЕНДЫ ИЗ КАТАЛОГА РЫНКА (разовый, 14.11.2026).
 *
 * Владелец: «у нас нет аренды, удаляй полностью». Код выката перестал писать и читать аренду
 * (в списке рубрик нет аренды, `marketCatalogWhere` читает только dealType = SALE, `saveListings`
 * отбрасывает всё, что не продажа). Строки аренды, которые УЖЕ лежат в базе (на проде — 743 строки
 * Somon.tj), никому не мешают и не читаются; этот скрипт их удаляет окончательно.
 *
 * Что делает:
 *  1. печатает, сколько строк с dealType <> 'SALE' и по каким площадкам, и сколько снимков цен и
 *     совпадений с нашими объектами уйдёт каскадом вместе с ними;
 *  2. с `--apply --force`: СНАЧАЛА выгружает все эти строки целиком (со всеми колонками и сырьём)
 *     в файл JSON Lines (`--out`, по умолчанию market-rent-backup-<метка времени>.jsonl в текущей
 *     папке), сверяет число записанных строк с числом найденных и только потом удаляет пачками
 *     по `--batch` (по умолчанию 500). Не совпало — отказ, ничего не удалено.
 * Без `--apply` не пишет ничего. `--apply` без `--force` — отказ (удаление необратимо). Повторный
 * запуск безопасен: второй раз удалять нечего. Продажу и другие площадки не трогает.
 *
 * ЗАПУСК (только по «да» владельца на прод; в этой ветке на прод НЕ запускался):
 *   локально (из apps/api):  npx tsx src/lib/market/purgeMarketRent.ts [--apply --force] [--out файл] [--batch 500]
 *   на проде (контейнер api): node dist/lib/market/purgeMarketRent.js [--apply --force] [--out /tmp/файл]
 * Перед `--apply` на проде ещё и копия таблиц: pg_dump -t '"MarketListing"' -t '"MarketPriceSnapshot"'
 * -t '"PropertyMarketMatch"' — выгрузка скрипта это страховка, а не замена копии базы.
 *
 * Заметка: `purgeSomonJunk.ts` после этой правки считает рубрики аренды «чужими» (аренды нет в списке
 * рубрик) и с `--force` удалил бы их тоже; этот скрипт — прямой путь и не зависит от списка рубрик.
 */
import { createWriteStream } from "node:fs";
import { once } from "node:events";
import { pathToFileURL } from "node:url";
import { prisma } from "../../db.js";

const DEFAULT_BATCH = 500;
const MAX_BATCH = 5000;

export interface RentCounts {
  total: number;
  bySource: Array<{ source: string; dealType: string; count: number }>;
  snapshots: number;
  matches: number;
}

/** Условие «не продажа»: только RENT сегодня, но и любое будущее значение, кроме SALE, не читается каталогом. */
export const NOT_SALE = { dealType: { not: "SALE" } } as const;

export async function countRent(): Promise<RentCounts> {
  const groups = await prisma.marketListing.groupBy({ by: ["source", "dealType"], where: NOT_SALE, _count: { _all: true } });
  const [snapshots, matches] = await Promise.all([
    prisma.marketPriceSnapshot.count({ where: { listing: NOT_SALE } }),
    prisma.propertyMarketMatch.count({ where: { listing: NOT_SALE } }),
  ]);
  return {
    total: groups.reduce((s, g) => s + g._count._all, 0),
    bySource: groups.map((g) => ({ source: g.source, dealType: g.dealType, count: g._count._all })).sort((a, b) => b.count - a.count),
    snapshots,
    matches,
  };
}

/** Выгружает строки аренды в JSON Lines; возвращает, сколько записано. Decimal и Date — строками. */
export async function exportRent(file: string, idPrefix = ""): Promise<number> {
  const out = createWriteStream(file, { encoding: "utf8", flags: "wx" });
  let written = 0;
  let cursor: string | undefined;
  try {
    for (;;) {
      const rows = await prisma.marketListing.findMany({
        where: { ...NOT_SALE, ...(idPrefix ? { sourceId: { startsWith: idPrefix } } : {}), ...(cursor ? { id: { gt: cursor } } : {}) },
        orderBy: { id: "asc" },
        take: 1000,
      });
      if (rows.length === 0) break;
      cursor = rows[rows.length - 1].id;
      for (const row of rows) {
        if (!out.write(JSON.stringify(row) + "\n")) await once(out, "drain");
        written++;
      }
    }
  } finally {
    out.end();
    await once(out, "finish").catch(() => undefined);
  }
  return written;
}

/** Удаляет строки аренды пачками; снимки цен и совпадения уходят каскадом. Возвращает число удалённых. */
export async function deleteRent(batch = DEFAULT_BATCH, idPrefix = ""): Promise<number> {
  let deleted = 0;
  for (;;) {
    const ids = await prisma.marketListing.findMany({
      where: { ...NOT_SALE, ...(idPrefix ? { sourceId: { startsWith: idPrefix } } : {}) },
      select: { id: true },
      take: batch,
    });
    if (ids.length === 0) return deleted;
    const res = await prisma.marketListing.deleteMany({ where: { id: { in: ids.map((r) => r.id) }, ...NOT_SALE } });
    deleted += res.count;
    console.log(`  удалено ${deleted}`);
  }
}

function parseArgs(argv: string[]): { apply: boolean; force: boolean; batch: number; out: string } {
  const apply = argv.includes("--apply");
  const force = argv.includes("--force");
  const bi = argv.indexOf("--batch");
  const rawBatch = bi >= 0 ? Number(argv[bi + 1]) : DEFAULT_BATCH;
  const batch = Number.isInteger(rawBatch) && rawBatch > 0 ? Math.min(rawBatch, MAX_BATCH) : DEFAULT_BATCH;
  const oi = argv.indexOf("--out");
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const out = oi >= 0 && argv[oi + 1] ? argv[oi + 1] : `market-rent-backup-${stamp}.jsonl`;
  return { apply, force, batch, out };
}

async function main(): Promise<void> {
  const { apply, force, batch, out } = parseArgs(process.argv.slice(2));
  const counts = await countRent();
  console.log(`Строк аренды в каталоге: ${counts.total}.`);
  for (const g of counts.bySource) console.log(`  ${g.source} / ${g.dealType}: ${g.count}`);
  console.log(`Вместе с ними каскадом уйдут: снимков цен ${counts.snapshots}, совпадений с нашими объектами ${counts.matches}.`);
  if (!apply) {
    console.log("Это просмотр: ничего не изменено. Выполнить — с флагами --apply --force.");
    return;
  }
  if (!force) {
    console.error("Отказ: удаление необратимо — нужны оба флага --apply --force.");
    process.exitCode = 1;
    return;
  }
  if (counts.total === 0) {
    console.log("Удалять нечего.");
    return;
  }
  const exported = await exportRent(out);
  console.log(`Выгружено в ${out}: ${exported} строк.`);
  if (exported < counts.total) {
    console.error(`Отказ: выгружено ${exported}, найдено ${counts.total}. Ничего не удалено.`);
    process.exitCode = 1;
    return;
  }
  const deleted = await deleteRent(batch);
  console.log(`Готово: удалено ${deleted} строк аренды.`);
}

// Запуск только как самостоятельного процесса: при импорте (тесты) — ничего.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main()
    .catch((err) => {
      console.error("Чистка прервана:", err instanceof Error ? err.message : String(err));
      process.exitCode = 1;
    })
    .finally(() => prisma.$disconnect());
}
