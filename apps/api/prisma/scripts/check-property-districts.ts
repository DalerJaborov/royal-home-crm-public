/**
 * СВЕРКА РАЙОНОВ УЖЕ ЗАВЕДЁННЫХ КАРТОЧЕК (20.09.2026).
 *
 * Правка того же дня заставила район определяться картой при сохранении карточки
 * (см. src/lib/propertyDistrict.ts), но объекты, заведённые ДО неё, остаются с тем
 * районом, который подсказала прежняя эвристика «ближайший из четырёх центров».
 * Живой случай владельца — «Шохмансур, улица Дехоти, 8», где улица лежит в
 * Фирдавси. Этот скрипт проходит по всей базе и показывает такие расхождения.
 *
 * ЗАПУСК (из apps/api, там же .env с DATABASE_URL):
 *   npx tsx prisma/scripts/check-property-districts.ts          — только показать
 *   npx tsx prisma/scripts/check-property-districts.ts --fix    — и исправить
 *
 * Без `--fix` не пишет НИЧЕГО: район — видимое агенту поле, и менять его молча,
 * не показав сначала список, нельзя. Скрытые (deletedAt) объекты не трогаются.
 */
import { prisma } from "../../src/db.js";
import { districtFromMap } from "../../src/lib/propertyDistrict.js";

const BATCH_SIZE = 500;

async function main(): Promise<void> {
  const fix = process.argv.includes("--fix");
  const streets = await prisma.street.count();
  const districtsWithBoundary = await prisma.district.count({ where: { boundary: { not: null } } });
  if (streets === 0 && districtsWithBoundary === 0) {
    console.log(
      "Справочник адресов пуст (0 улиц, 0 границ районов) — сверять не с чем.\n" +
        "Сначала загрузите слой: npx tsx prisma/scripts/import-geo.ts"
    );
    return;
  }
  console.log(`Справочник: улиц ${streets}, районов с границей ${districtsWithBoundary}.`);

  const mismatched: { shortId: number; address: string; was: string; should: string; why: string }[] = [];
  let checked = 0;
  let cursor: string | undefined;
  // Постранично по курсору: карточек тысячи, читать их одним findMany в память
  // незачем (правило репозитория про предел выборки).
  for (;;) {
    const page = await prisma.property.findMany({
      where: { deletedAt: null },
      select: {
        id: true,
        shortId: true,
        address: true,
        lat: true,
        lng: true,
        districtId: true,
        district: { select: { name: true } },
      },
      orderBy: { id: "asc" },
      take: BATCH_SIZE,
      ...(cursor ? { skip: 1, cursor: { id: cursor } } : {}),
    });
    if (page.length === 0) break;
    cursor = page[page.length - 1].id;

    for (const p of page) {
      checked += 1;
      const guess = await districtFromMap({
        lat: p.lat != null ? Number(p.lat) : null,
        lng: p.lng != null ? Number(p.lng) : null,
        address: p.address,
      });
      if (!guess || guess.id === p.districtId) continue;
      mismatched.push({
        shortId: p.shortId,
        address: p.address ?? "(без адреса)",
        was: p.district?.name ?? "(без района)",
        should: guess.name,
        why: guess.source === "point" ? "точка внутри границы района" : `улица ${guess.street}`,
      });
      if (fix) await prisma.property.update({ where: { id: p.id }, data: { districtId: guess.id } });
    }
  }

  console.log(`Проверено карточек: ${checked}. Расхождений: ${mismatched.length}.`);
  for (const m of mismatched) {
    console.log(`  №${m.shortId}: «${m.address}» — стоит ${m.was}, по карте ${m.should} (${m.why})`);
  }
  if (mismatched.length > 0) {
    console.log(fix ? "Исправлено." : "Ничего не менял. Повторите с --fix, чтобы исправить.");
  }
}

main()
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
