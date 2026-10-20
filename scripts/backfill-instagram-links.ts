/**
 * Одноразовый скрипт: нормализация ссылок Instagram в карточках объектов.
 *
 * Проблема: 17+ объектов имеют в поле «Ссылка на публикацию Instagram» не-Instagram
 * URL (t.me, произвольный текст, битые ссылки). Лид-магнит не узнаёт публикации по
 * таким ссылкам, лиды теряются.
 *
 * Что делает:
 * 1. Читает все объекты с непустым instagramUrl
 * 2. Пытается извлечь shortcode и нормализовать к https://www.instagram.com/reel/<CODE>/
 * 3. Если удалось — обновляет запись
 * 4. Если нет — помечает как needsManualReview и выводит список
 *
 * Запуск из корня репозитория:
 *   npx tsx scripts/backfill-instagram-links.ts           — только показать, что изменится
 *   npx tsx scripts/backfill-instagram-links.ts --apply   — записать в базу
 * .env подхватывается из apps/api сам (dotenv ниже) — руками экспортировать не нужно.
 */
import "./_env.cjs";
import { prisma } from "../apps/api/src/db.js";
import { normalizeInstagramUrl } from "@royal-home/shared";

const APPLY = process.argv.includes("--apply");

interface BackfillStats {
  total: number;
  normalized: number;
  alreadyCanonical: number;
  needsManualReview: { shortId: number; id: string; currentValue: string }[];
}

async function main(): Promise<void> {
  const stats: BackfillStats = {
    total: 0,
    normalized: 0,
    alreadyCanonical: 0,
    needsManualReview: [],
  };

  const properties = await prisma.property.findMany({
    where: { deletedAt: null, instagramUrl: { not: null } },
    select: { id: true, shortId: true, instagramUrl: true },
  });

  stats.total = properties.length;
  console.log(`Найдено ${stats.total} объектов с заполненным instagramUrl`);

  for (const p of properties) {
    const current = p.instagramUrl?.trim();
    if (!current) continue;

    const normalized = normalizeInstagramUrl(current);

    if (!normalized) {
      // Не удалось извлечь shortcode — нужна ручная проверка
      stats.needsManualReview.push({
        shortId: p.shortId,
        id: p.id,
        currentValue: current.slice(0, 120),
      });
      continue;
    }

    if (normalized === current) {
      stats.alreadyCanonical++;
      continue;
    }

    // Обновляем на нормализованный URL
    if (!APPLY) { stats.normalized++; console.log(`  [dry-run] ${p.shortId ?? ''} ${p.instagramUrl} → ${normalized}`); continue; }
    await prisma.property.update({
      where: { id: p.id },
      data: { instagramUrl: normalized },
    });
    stats.normalized++;
    console.log(`  №${p.shortId}: "${current.slice(0, 60)}" → ${normalized}`);
  }

  console.log("\n=== Итог ===");
  console.log(`Всего проверено: ${stats.total}`);
  console.log(`Нормализовано: ${stats.normalized}`);
  console.log(`Уже в каноническом виде: ${stats.alreadyCanonical}`);
  console.log(`Требуют ручной проверки: ${stats.needsManualReview.length}`);

  if (stats.needsManualReview.length > 0) {
    console.log("\nОбъекты для ручной проверки:");
    for (const item of stats.needsManualReview) {
      console.log(`  №${item.shortId} (${item.id}): ${item.currentValue}`);
    }
  }
}

main()
  .catch((err) => {
    console.error("Ошибка:", err);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });