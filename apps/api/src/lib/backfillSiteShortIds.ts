/**
 * ДОСЫЛКА НОМЕРА КАРТОЧКИ (shortId) УЖЕ ОПУБЛИКОВАННЫМ ОБЪЕКТАМ НА САЙТЕ (19.10.2026).
 *
 * С 19.10.2026 снимок объекта для сайта (lib/siteSync.ts::toSitePayload) несёт
 * `shortId`: сайт хранит его и шлёт в Meta Pixel как content_ids, совпадая с
 * home_listing_id фида каталога (lib/metaCatalogFeed.ts). Новые публикации и любая
 * правка карточки несут номер сами, а строки, опубликованные раньше и не менявшиеся
 * с тех пор, остаются без него. Общего «досылать всё» в репозитории не было
 * (site-resync ставится поштучно на правку карточки), поэтому этот скрипт.
 *
 * ЗАПУСК ТОЛЬКО ПОСЛЕ ТОГО, КАК ВЫКАЧЕНА СТОРОНА САЙТА: пока сайт не принимает
 * поле shortId, досылка либо ничего не даст, либо будет отвергнута.
 *
 *   локально (из apps/api):  npm run site:resync-short-ids -- [флаги]
 *   на проде (контейнер api): node dist/lib/backfillSiteShortIds.js [флаги]
 *
 *   без флагов / --dry-run   — показать, кого затронет (ничего не шлёт)
 *   --apply                  — отправить
 *   --limit 500              — сколько объектов за запуск (по умолчанию 500, не больше 2000)
 *   --batch 20               — сколько объектов в одном запросе к сайту (по умолчанию 20, не больше 50)
 *   --after <id>             — продолжить с объекта после этого id (скрипт сам печатает его, если не уложился в предел)
 *
 * Шлётся тот же «publish»-снимок, что и обычная досылка site-resync: на стороне
 * сайта это upsert, повторный прогон ничего не ломает (ИДЕМПОТЕНТНО). Выборка —
 * ровно то, что стоит на витрине: publishedOnSite, не в корзине, не offSite, статус
 * в продаже/броне/продан. Партии идут по порядку одна за другой с короткой паузой,
 * таймаут запроса считает syncPropertiesToSite (10 с + 3 с на объект, не больше
 * 60 с). Отказ партии пишется в журнал и не останавливает остальные; код возврата
 * 1, если хоть одна партия не дошла, — тогда прогон просто повторяют.
 */
import { pathToFileURL } from "node:url";
import { prisma } from "../db.js";
import { describeError } from "./describeError.js";
import { isSiteListedStatus, syncPropertiesToSite } from "./siteSync.js";
import { logSystemError } from "./systemError.js";

const DEFAULT_LIMIT = 500;
const MAX_LIMIT = 2000;
const DEFAULT_BATCH = 20;
/** Предел сайта на один запрос (см. массовую публикацию, до 50 объектов). */
const MAX_BATCH = 50;
const PAUSE_BETWEEN_BATCHES_MS = 500;

function argValue(name: string): string | null {
  const i = process.argv.indexOf(name);
  return i >= 0 ? (process.argv[i + 1] ?? null) : null;
}

function intArg(name: string, fallback: number, max: number): number {
  const raw = Number(argValue(name) ?? fallback);
  return Number.isFinite(raw) && raw >= 1 ? Math.min(Math.floor(raw), max) : fallback;
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

export async function main(): Promise<void> {
  const apply = process.argv.includes("--apply") && !process.argv.includes("--dry-run");
  const limit = intArg("--limit", DEFAULT_LIMIT, MAX_LIMIT);
  const batchSize = intArg("--batch", DEFAULT_BATCH, MAX_BATCH);

  // Курсор по id: если опубликованных больше предела, следующий запуск идёт с
  // `--after <последний id>`, а не шлёт заново тех же первых.
  const after = argValue("--after");
  const where = {
    deletedAt: null,
    publishedOnSite: true,
    offSite: false,
    status: { in: ["AVAILABLE" as const, "RESERVED" as const, "SOLD" as const] },
    ...(after ? { id: { gt: after } } : {}),
  };
  const [total, candidates] = await Promise.all([
    prisma.property.count({ where }),
    prisma.property.findMany({
      where,
      select: { id: true, shortId: true, title: true },
      orderBy: { id: "asc" },
      take: limit,
    }),
  ]);

  console.log(`Опубликованных на сайте объектов: ${total}; в этом запуске: ${candidates.length} (предел ${limit}, партия ${batchSize}).`);
  if (!apply) {
    for (const p of candidates.slice(0, 20)) console.log(`  · №${p.shortId}  ${p.id}  ${p.title}`);
    if (candidates.length > 20) console.log(`  … и ещё ${candidates.length - 20}`);
    console.log("Ничего не отправлено — запустите с --apply, чтобы досылать.");
    return;
  }

  let sent = 0;
  let failedBatches = 0;
  let failedItems = 0;
  for (let i = 0; i < candidates.length; i += batchSize) {
    const ids = candidates.slice(i, i + batchSize).map((c) => c.id);
    // Свежее чтение партии: объект мог уйти с сайта или в корзину, пока шёл прогон.
    const properties = (
      await prisma.property.findMany({
        where: { id: { in: ids }, deletedAt: null, publishedOnSite: true, offSite: false },
        include: { district: true, photos: { orderBy: { order: "asc" } } },
        orderBy: { id: "asc" },
      })
    ).filter((p) => isSiteListedStatus(p.status));
    if (properties.length === 0) continue;

    const result = await syncPropertiesToSite(properties, "publish");
    if (!result.ok) {
      failedBatches += 1;
      failedItems += properties.length;
      console.error(`Партия ${i / batchSize + 1}: не дошла — ${result.error}`);
      void logSystemError("site-sync", `Досылка shortId на сайт: партия не дошла — ${result.error}`);
    } else {
      for (const property of properties) {
        const receipts = Array.isArray(result.results)
          ? result.results.filter((r) => r.externalId === property.id)
          : [];
        if (receipts.length === 1 && receipts[0]!.ok === true) sent += 1;
        else {
          failedItems += 1;
          const reason = receipts.length === 1 ? receipts[0]!.error : "нет однозначного подтверждения сайта";
          console.error(`  отказ сайта по ${property.id}: ${reason}`);
        }
      }
    }
    if (i + batchSize < candidates.length) await sleep(PAUSE_BETWEEN_BATCHES_MS);
  }

  console.log(`Готово: отправлено ${sent}, не дошло ${failedItems} (партий с отказом: ${failedBatches}).`);
  if (total > candidates.length) {
    console.log(`Осталось вне предела: ${total - candidates.length} — продолжить: --apply --after ${candidates[candidates.length - 1]!.id}`);
  }
  if (failedItems > 0) process.exitCode = 1;
}

// Запуск только как самостоятельного процесса: при импорте (тесты) — ничего.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main()
    .catch((err) => {
      console.error(describeError(err));
      process.exitCode = 1;
    })
    .finally(() => prisma.$disconnect());
}
