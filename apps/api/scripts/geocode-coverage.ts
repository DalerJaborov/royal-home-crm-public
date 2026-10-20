/**
 * ПОКРЫТИЕ ОБЪЕКТОВ КООРДИНАТАМИ — замер перед подбором по адресу (12.09.2026).
 *
 * Владелец одобрил подбор «объект в радиусе N метров от ориентира» вместо подбора
 * по району целиком. Прежде чем такой фильтр писать, надо знать, у скольких объектов
 * координаты вообще есть: `{ lat: { not: null } }` в SQL молча выбрасывает строки с
 * NULL, и фильтр по радиусу на плохом покрытии не «уточнит подбор», а спрячет от
 * покупателя половину каталога — ровно та тихая поломка, которую по экрану не видно.
 * Тот же приём, что уже применён к этажу и этажности в lib/propertyMatchFilter.ts:
 * незаполненное поле не должно наказывать покупателя за чужую карточку.
 *
 * ЗАПУСК (из apps/api, там же .env с DATABASE_URL):
 *     npx tsx scripts/geocode-coverage.ts            — только показать замер
 *     npx tsx scripts/geocode-coverage.ts --apply    — доставить задания геокодера
 *
 * Без `--apply` не пишет НИЧЕГО и не ходит в Nominatim — считает по базе.
 *
 * С `--apply` ставит задание `geocode` каждому живому объекту без координат. Nominatim
 * бесплатный и просит не больше одного запроса в секунду (см. lib/geocode.ts), поэтому
 * задания расставляются по времени с шагом NOMINATIM_SPACING_MS: воркер разберёт их
 * лесенкой, а не выстрелит пачкой и не получит 429 на весь каталог разом. Повторный
 * запуск безопасен: dedupeKey `geocode:{id}` схлопывает уже ждущие задания.
 */
import { prisma } from "../src/db.js";
import { GEOCODE_MAX_ATTEMPTS } from "../src/jobs/geocode.js";
import { enqueueBackgroundJob } from "../src/jobs/enqueue.js";

/** Политика Nominatim — не чаще одного запроса в секунду, с запасом. */
const NOMINATIM_SPACING_MS = 1500;

const apply = process.argv.includes("--apply");

function pct(part: number, total: number): string {
  if (total === 0) return "—";
  return `${((part / total) * 100).toFixed(1)}%`;
}

async function main() {
  const alive = { deletedAt: null } as const;
  const withCoords = { ...alive, lat: { not: null }, lng: { not: null } };

  const [total, coords, autoCoords, available, availableCoords] = await Promise.all([
    prisma.property.count({ where: alive }),
    prisma.property.count({ where: withCoords }),
    prisma.property.count({ where: { ...withCoords, geocodedAt: { not: null } } }),
    prisma.property.count({ where: { ...alive, status: "AVAILABLE" } }),
    prisma.property.count({ where: { ...withCoords, status: "AVAILABLE" } }),
  ]);

  console.log("=== Координаты объектов ===");
  console.log(`Живых объектов:            ${total}`);
  console.log(`С координатами:            ${coords} (${pct(coords, total)})`);
  console.log(`  из них автогеокодер:     ${autoCoords}`);
  console.log(`  из них руками/с сайта:   ${coords - autoCoords}`);
  console.log(`Без координат:             ${total - coords}`);
  console.log("");
  console.log(`В продаже (AVAILABLE):     ${available}`);
  console.log(`  из них с координатами:   ${availableCoords} (${pct(availableCoords, available)})`);
  console.log(`  ПРОПАЛИ БЫ из подбора:   ${available - availableCoords}`);

  // Разрез по районам — где именно дыра. Считаем только то, что участвует в подборе.
  const byDistrict = await prisma.property.groupBy({
    by: ["districtId"],
    where: { ...alive, status: "AVAILABLE" },
    _count: { _all: true },
  });
  const covered = await prisma.property.groupBy({
    by: ["districtId"],
    where: { ...withCoords, status: "AVAILABLE" },
    _count: { _all: true },
  });
  const coveredBy = new Map(covered.map((r) => [r.districtId, r._count._all]));
  const districts = await prisma.district.findMany({ select: { id: true, name: true } });
  const nameOf = new Map(districts.map((d) => [d.id, d.name]));

  const rows = byDistrict
    .map((r) => ({
      name: nameOf.get(r.districtId) ?? r.districtId,
      total: r._count._all,
      covered: coveredBy.get(r.districtId) ?? 0,
    }))
    .sort((a, b) => b.total - b.covered - (a.total - a.covered));

  if (rows.length > 0) {
    console.log("");
    console.log("=== По районам (в продаже) ===");
    for (const r of rows) {
      console.log(`${r.name.padEnd(24)} ${String(r.covered).padStart(4)} из ${String(r.total).padStart(4)}  (${pct(r.covered, r.total)})`);
    }
  }

  // Очередь геокодера: сколько заданий висит и сколько сдалось после всех попыток.
  const jobs = await prisma.backgroundJob.groupBy({
    by: ["status"],
    where: { type: "geocode" },
    _count: { _all: true },
  });
  if (jobs.length > 0) {
    console.log("");
    console.log("=== Очередь заданий geocode ===");
    for (const j of jobs) console.log(`${j.status.padEnd(12)} ${j._count._all}`);
  }

  const missing = await prisma.property.findMany({
    where: { ...alive, OR: [{ lat: null }, { lng: null }] },
    select: { id: true, address: true, district: { select: { name: true } } },
    orderBy: { createdAt: "asc" },
  });

  if (!apply) {
    console.log("");
    console.log(`Без --apply ничего не поставлено. Заданий было бы: ${missing.length}`);
    console.log(
      `Разбор занял бы примерно ${Math.ceil((missing.length * NOMINATIM_SPACING_MS) / 60_000)} мин ` +
        `(шаг ${NOMINATIM_SPACING_MS} мс — политика Nominatim).`
    );
    return;
  }

  let queued = 0;
  for (const [i, p] of missing.entries()) {
    const result = await enqueueBackgroundJob({
      type: "geocode",
      payload: { propertyId: p.id, address: p.address, districtName: p.district.name },
      dedupeKey: `geocode:${p.id}`,
      maxAttempts: GEOCODE_MAX_ATTEMPTS,
      runAt: new Date(Date.now() + i * NOMINATIM_SPACING_MS),
    });
    if (result.enqueued) queued += 1;
  }
  console.log("");
  console.log(`Поставлено заданий: ${queued} из ${missing.length} (остальные уже ждали в очереди).`);
}

main()
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
