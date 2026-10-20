/**
 * РАЗОВЫЙ БЭКФИЛЛ Property.canonicalAddress (15.09.2026, проверка дублей на шаге
 * «Где» — см. миграцию 20260915120000_property_canonical_address).
 *
 * Колонка появилась со значением по умолчанию '' — у всех объектов, заведённых
 * до этой правки, канонного адреса ещё нет, и проверка «этот адрес уже заведён»
 * их просто не найдёт (пустая строка ни с чем не совпадёт, кроме другой пустой
 * в том же районе). Заполняем ОДИН РАЗ той же функцией normalizePropertyAddress,
 * которой routes/properties/crud.ts считает канонный адрес при создании/правке —
 * второй копии этих правил быть не должно.
 *
 * ЗАПУСК (из apps/api, там же DATABASE_URL):
 *     npx tsx scripts/backfill-property-canonical-address.ts            — показать, что будет сделано
 *     npx tsx scripts/backfill-property-canonical-address.ts --apply    — выполнить
 *
 * Без --apply ничего не пишет — только считает, сколько объектов попадёт под
 * заполнение. Повторный запуск безопасен: объект с уже посчитанным канонным
 * адресом (canonicalAddress != '') в выборку не попадает, поэтому прогон можно
 * повторять пачками, пока LIMIT не покроет всю таблицу.
 *
 * ПЕРЕСЧЁТ (29.09.2026, ключ научился таджикскому написанию и латинице):
 *     npx tsx scripts/backfill-property-canonical-address.ts --recompute           — сколько расходится
 *     npx tsx scripts/backfill-property-canonical-address.ts --recompute --apply   — пересчитать
 * Проходит ВСЕ объекты пачками по id и пишет только те, чей сохранённый ключ
 * разошёлся с нынешним правилом. Повторный запуск безопасен: совпавшие не
 * трогаются. Пока пересчёт не прошёл, проверка дублей ищет и по прежнему ключу.
 */
import { prisma } from "../src/db.js";
import { normalizePropertyAddress } from "../src/routes/properties/shared.js";

/** Предел выборки за один прогон — правило репозитория (полный перебор без
 *  предела на растущей таблице рано или поздно кладёт базу). Повторный запуск
 *  подхватит следующую пачку — уже заполненные строки из выборки выпадут сами. */
const LIMIT = 5000;

async function recompute(apply: boolean): Promise<void> {
  let cursor: string | undefined;
  let checked = 0;
  let stale = 0;
  for (;;) {
    const page = await prisma.property.findMany({
      select: { id: true, address: true, canonicalAddress: true },
      orderBy: { id: "asc" },
      take: LIMIT,
      ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
    });
    if (page.length === 0) break;
    for (const p of page) {
      checked++;
      const canonicalAddress = normalizePropertyAddress(p.address);
      if (canonicalAddress === p.canonicalAddress) continue;
      stale++;
      if (apply) await prisma.property.update({ where: { id: p.id }, data: { canonicalAddress } });
    }
    cursor = page[page.length - 1].id;
  }
  console.log(`Проверено объектов: ${checked}, расходятся: ${stale}${apply ? " — пересчитаны" : " (ничего не записано, нужен --apply)"}.`);
}

async function main(): Promise<void> {
  const apply = process.argv.includes("--apply");
  if (process.argv.includes("--recompute")) return recompute(apply);

  const candidates = await prisma.property.findMany({
    where: { canonicalAddress: "" },
    select: { id: true, address: true },
    take: LIMIT,
  });

  console.log(`Объектов без канонного адреса (в этой выборке, предел ${LIMIT}): ${candidates.length}`);
  if (!apply) {
    console.log("Ничего не записано — запустите с --apply, чтобы заполнить.");
    return;
  }

  const started = Date.now();
  let done = 0;
  for (const p of candidates) {
    const canonicalAddress = normalizePropertyAddress(p.address);
    await prisma.property.update({ where: { id: p.id }, data: { canonicalAddress } });
    done++;
  }
  const seconds = ((Date.now() - started) / 1000).toFixed(1);
  console.log(`Заполнено: ${done} объектов за ${seconds} с.`);

  const remaining = await prisma.property.count({ where: { canonicalAddress: "" } });
  if (remaining > 0) {
    console.log(`Осталось ещё ${remaining} — запустите скрипт повторно.`);
  }
}

main()
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
