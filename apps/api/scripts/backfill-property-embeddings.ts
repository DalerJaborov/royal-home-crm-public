/**
 * РАЗОВЫЙ БЭКАФИЛЛ ВЕКТОРОВ ОБЪЕКТОВ (семантический подбор, 23.08.2026, пункт 3
 * очереди ИИ).
 *
 * Индексация объекта (embedAndSaveProperty, ai/embeddings.ts) с этого дня идёт при
 * КАЖДОМ создании/правке карточки — но у объектов, заведённых до выкатки, вектора
 * ещё нет вовсе, а у объекта, чья правка попала на момент, когда Gemini не отвечал
 * (лимит/ротация ключа), он мог остаться пустым или устареть молча: фоновый вызов
 * не бросает и не блокирует сохранение (см. комментарий у embedAndSaveProperty), и
 * без отдельного прохода такой объект так и остался бы без вектора навсегда.
 *
 * «Устаревший» здесь — вектор посчитан РАНЬШЕ последней правки карточки
 * (embeddingUpdatedAt < updatedAt): признак того, что какая-то правка не долетела
 * до эмбеддинга (сбой на тот момент), а не то, что поменялось именно смысловое
 * поле — точный список того, что запускает пересчёт при обычном PATCH, уже
 * привязан к updatedAt через тот же механизм, так что грубая проверка по времени
 * ловит и его, и разовые сбои разом.
 *
 * ЗАПУСК (из apps/api, там же .env с DATABASE_URL):
 *     npx tsx scripts/backfill-property-embeddings.ts            — показать, что будет сделано
 *     npx tsx scripts/backfill-property-embeddings.ts --apply    — выполнить
 *
 * Без `--apply` не зовёт Gemini и не пишет НИЧЕГО — только считает, сколько
 * объектов попадёт под пересчёт. Повторный запуск безопасен: объект с уже свежим
 * вектором (embeddingUpdatedAt >= updatedAt) в выборку не попадает.
 *
 * НЕ ЗАПУСКАТЬ НА БОЕВЫХ ДАННЫХ БЕЗ ВЛАДЕЛЬЦА — каждый объект это отдельный вызов
 * Gemini (embedContent), а квота считается на проект/модель в сутки (см. комментарий
 * у resolveGeminiKeys в ai/geminiClient.ts) — большой каталог разом может выесть её
 * заодно с диалоговыми вызовами бота.
 */
import { prisma } from "../src/db.js";
import { embedAndSaveProperty } from "../src/ai/embeddings.js";
import { sleep } from "../src/ai/geminiTransport.js";

/** Предел выборки за один прогон скрипта — правило репозитория (любой запрос без
 *  предела на растущей таблице рано или поздно поднимает всю базу разом). Если
 *  объектов без вектора больше — запустить скрипт повторно: уже обработанные
 *  из следующей выборки выпадут сами (embeddingUpdatedAt обновится). */
const LIMIT = 500;

/** Пауза между вызовами Gemini — не бьём в лимит запросов в минуту одной пачкой.
 *  embedAndSaveProperty и так синхронный по объекту за объектом, но без паузы
 *  сотни объектов улетели бы к Google практически одновременно. */
const DELAY_BETWEEN_MS = 300;

async function main(): Promise<void> {
  const apply = process.argv.includes("--apply");

  const candidates = await prisma.property.findMany({
    where: {
      deletedAt: null,
      OR: [
        { embeddingUpdatedAt: null },
        // Prisma не сравнивает две колонки одной строки в where напрямую — сырой SQL
        // для этого одного условия, остальная выборка обычным Prisma-запросом.
        { id: { in: await staleIds() } },
      ],
    },
    select: { id: true, shortId: true, title: true },
    orderBy: { createdAt: "asc" },
    take: LIMIT,
  });

  console.log(
    apply
      ? `Найдено объектов без свежего вектора: ${candidates.length}. Считаем эмбеддинги...`
      : `Пробный прогон: под пересчёт попадает объектов — ${candidates.length}. Запустите с --apply, чтобы выполнить.`
  );

  if (!apply) {
    for (const c of candidates) console.log(`  ОБ-${c.shortId} ${c.title}`);
    return;
  }

  let done = 0;
  let failed = 0;
  for (const c of candidates) {
    const before = await prisma.property.findUnique({ where: { id: c.id }, select: { embeddingUpdatedAt: true } });
    await embedAndSaveProperty(c.id);
    const after = await prisma.property.findUnique({ where: { id: c.id }, select: { embeddingUpdatedAt: true } });
    // embedAndSaveProperty никогда не бросает — отказ виден только по тому, что
    // embeddingUpdatedAt не сдвинулся (уже залогирован в ErrorLog самой функцией).
    if (after?.embeddingUpdatedAt?.getTime() !== before?.embeddingUpdatedAt?.getTime()) {
      done++;
    } else {
      failed++;
      console.error(`  ОБ-${c.shortId} ${c.title}: эмбеддинг не получен (см. «Здоровье системы»)`);
    }
    await sleep(DELAY_BETWEEN_MS);
  }

  console.log(`Готово: посчитано — ${done}, не получилось — ${failed}.`);
}

/** id объектов, чей вектор устарел (посчитан раньше последней правки карточки).
 *  Отдельным сырым запросом — Prisma не умеет сравнивать две колонки одной
 *  строки в обычном where. */
async function staleIds(): Promise<string[]> {
  const rows = await prisma.$queryRaw<{ id: string }[]>`
    SELECT "id" FROM "Property"
    WHERE "deletedAt" IS NULL
      AND "embeddingUpdatedAt" IS NOT NULL
      AND "embeddingUpdatedAt" < "updatedAt"`;
  return rows.map((r) => r.id);
}

main()
  .catch((err) => {
    console.error("[backfill-property-embeddings] упало:", err instanceof Error ? err.message : err);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
