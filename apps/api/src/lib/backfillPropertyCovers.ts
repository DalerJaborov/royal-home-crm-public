/**
 * ДОБОР ОБЛОЖЕК СТАРЫМ ОБЪЕКТАМ (владелец, 23.09.2026).
 *
 * Обложки нужны Instagram, Telegram и Facebook (на сайт они с 01.10.2026
 * не идут — `lib/siteSync.ts::siteImageUrls`), но появляются у объекта только при
 * публикации ролика. У объектов, вышедших раньше, их нет. Этот
 * скрипт дорисовывает им пару обложек (квадрат 1080×1080 + вертикаль 1080×1920)
 * и заполняет ТОЛЬКО поля обложек.
 *
 * Рисует `lib/video/coverOpenAi.ts::makePropertyCover` тем, кто выбран в
 * Настройках (`Settings.coverProvider`, с 28.09.2026 по умолчанию наш шаблон
 * «Royal Green»). `--provider template|openai` — перебить на этот прогон.
 * ChatGPT стоит денег (~$0.26 за объект при high), поэтому его предел пачки 10;
 * наш шаблон бесплатен — предел 500. Запуск только руками, с `--apply`.
 *
 * ЧЕГО СКРИПТ НЕ ДЕЛАЕТ: не трогает ролики, ничего не публикует в соцсети и не
 * зовёт синхронизацию сайта. Сайт обложки не получает.
 *
 * Живёт в `src/lib`, а не в `apps/api/scripts`: боевой образ несёт только
 * собранный `dist` без `tsx` (devDependency, вырезается `npm prune`), и скрипт
 * из `scripts/` на проде было бы просто нечем запустить. Тот же приём, что у
 * `backfillInstagramUrls.ts`.
 *
 * ЗАПУСК:
 *   локально (из apps/api):  npm run backfill:property-covers -- [флаги]
 *   на проде (контейнер api): node dist/lib/backfillPropertyCovers.js [флаги]
 *
 *   без флагов / --dry-run   — показать, кого затронет (ничего не пишет)
 *   --apply                  — дорисовать
 *   --apply --limit 50       — пачкой поменьше
 *   --apply --force          — перерисовать и тех, у кого обложка уже есть
 *   --provider template      — нашим шаблоном (openai — ChatGPT), мимо Настроек
 *   --parallel 4             — сколько объектов одновременно (по умолчанию 4, не больше 8)
 *   --only-fallback          — заменить ChatGPT-ом запасные обложки шаблона (после
 *                              пополнения баланса OpenAI); те, где ChatGPT снова не вышел,
 *                              остаются запасными и считаются в «не вышло»
 *
 * `--dry-run` принимается тоже и равен запуску без `--apply`.
 *
 * ПОВТОРНЫЙ ЗАПУСК БЕЗОПАСЕН: объект с уже заполненной обложкой в выборку не
 * попадает (кроме `--force`), поэтому прогон повторяют, пока «осталось» не
 * станет нулём. Сбой одного объекта пишется в журнал и не останавливает пачку.
 */
import { pathToFileURL } from "node:url";
import { prisma } from "../db.js";
import { logSystemError } from "./systemError.js";
import { describeError } from "./describeError.js";
import { FALLBACK_COVER_HASH_PREFIX, loadCoverRuntimeSettings, makePropertyCover } from "./video/coverOpenAi.js";
import type { CoverProvider } from "@royal-home/shared";

/** Предел пачки по умолчанию — правило репозитория: без предела выборки на
 *  растущей таблице рано или поздно кладём базу, а рендер ещё и ест память.
 *  ChatGPT платный — 10; наш шаблон бесплатный — 500. */
const DEFAULT_LIMIT: Record<CoverProvider, number> = { OPENAI: 10, TEMPLATE: 500 };
/** Сколько объектов рисуется одновременно; больше 8 упирается в лимиты OpenAI по запросам в минуту. */
const DEFAULT_PARALLEL = 4;
const MAX_PARALLEL = 8;

function argValue(name: string): string | null {
  const i = process.argv.indexOf(name);
  return i >= 0 ? (process.argv[i + 1] ?? null) : null;
}

export async function main(): Promise<void> {
  const apply = process.argv.includes("--apply") && !process.argv.includes("--dry-run");
  // --only-fallback (02.10.2026): после пополнения баланса OpenAI заменить ChatGPT-ом
  // запасные обложки нашего шаблона (метка в хэше). Это всегда перерисовка (force) и,
  // если провайдер не задан флагом, именно ChatGPT — шаблон запасную себе же не заменит.
  const onlyFallback = process.argv.includes("--only-fallback");
  const force = process.argv.includes("--force") || onlyFallback;
  const providerRaw = argValue("--provider")?.toUpperCase() ?? (onlyFallback ? "OPENAI" : null);
  if (providerRaw && providerRaw !== "TEMPLATE" && providerRaw !== "OPENAI") {
    throw new Error(`--provider: template или openai, а не «${providerRaw.toLowerCase()}»`);
  }
  const provider: CoverProvider = (providerRaw as CoverProvider | null) ?? (await loadCoverRuntimeSettings()).coverProvider;
  const defaultLimit = DEFAULT_LIMIT[provider];
  const limitRaw = Number(argValue("--limit") ?? defaultLimit);
  const limit = Number.isFinite(limitRaw) && limitRaw > 0 ? Math.min(Math.floor(limitRaw), 2000) : defaultLimit;

  // «Опубликованный» — тот, что висит на сайте: именно у него первая картинка
  // объявления видна людям. Без фото рисовать не из чего — такие пропускаем.
  // Запасные обложки — любого объекта, не только висящего на сайте: их строит и
  // публикация ролика.
  const where = onlyFallback
    ? { deletedAt: null, photos: { some: {} }, socialCoverInputHash: { startsWith: FALLBACK_COVER_HASH_PREFIX } }
    : {
        deletedAt: null,
        publishedOnSite: true,
        photos: { some: {} },
        ...(force ? {} : { socialCoverSquareUrl: null }),
      };

  const [total, candidates] = await Promise.all([
    prisma.property.count({ where }),
    prisma.property.findMany({ where, select: { id: true, title: true }, orderBy: { createdAt: "asc" }, take: limit }),
  ]);

  console.log(
    `Объектов для обложки: ${total}${onlyFallback ? " (запасные обложки шаблона, заменяем ChatGPT-ом)" : force ? " (с --force, включая тех, у кого она уже есть)" : ""}; в этой пачке: ${candidates.length} (предел ${limit}); рисует ${provider === "TEMPLATE" ? "наш шаблон" : "ChatGPT"}.`
  );
  if (!apply) {
    for (const p of candidates.slice(0, 20)) console.log(`  · ${p.id}  ${p.title}`);
    if (candidates.length > 20) console.log(`  … и ещё ${candidates.length - 20}`);
    console.log("Ничего не записано — запустите с --apply, чтобы дорисовать.");
    return;
  }

  const started = Date.now();
  let done = 0;
  let failed = 0;
  // Параллельно по `--parallel` объектов (владелец 30.09.2026: «быстрее, а не 3 часа»).
  // Каждый объект — минуты ожидания ChatGPT, а не работы сервера, так что 4 разом почти
  // вчетверо быстрее. Лимит дня читается перед каждым объектом из журнала — при
  // параллели он может перевалить на несколько картинок, это приемлемо.
  const parallelRaw = Number(argValue("--parallel") ?? DEFAULT_PARALLEL);
  const parallel = Number.isFinite(parallelRaw) && parallelRaw >= 1 ? Math.min(Math.floor(parallelRaw), MAX_PARALLEL) : DEFAULT_PARALLEL;
  console.log(`Рисуем по ${parallel} объекта одновременно.`);
  let next = 0;
  const worker = async (): Promise<void> => {
    while (next < candidates.length) {
      const index = next++;
      const property = candidates[index];
      try {
        const cover = await makePropertyCover(property.id, { force, provider });
        if (onlyFallback && cover?.fallback) {
          // ChatGPT опять не вышел: обложка осталась запасной, это не успех замены.
          failed++;
          console.log(`[${index + 1}/${candidates.length}] ✗ ${property.id}  ChatGPT снова не смог — запасная обложка осталась`);
        } else if (cover) {
          done++;
          console.log(`[${index + 1}/${candidates.length}] ✓ ${property.id}${cover.cached ? " (из кэша)" : ""}`);
        } else {
          failed++;
          console.log(`[${index + 1}/${candidates.length}] ✗ ${property.id}  обложка не создана (причина — в карточке объекта и журнале ошибок)`);
        }
      } catch (err) {
        failed++;
        const message = describeError(err);
        console.log(`[${index + 1}/${candidates.length}] ✗ ${property.id}  ${message}`);
        void logSystemError("storage", `Добор обложки объекта ${property.id} не удался — ${message}`, {
          dedupKey: `cover-backfill-fail:${property.id}`,
        });
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(parallel, candidates.length) }, () => worker()));

  const seconds = ((Date.now() - started) / 1000).toFixed(1);
  console.log(`Готово: дорисовано ${done}, не вышло ${failed}, за ${seconds} с.`);
  if (!force || onlyFallback) {
    const remaining = await prisma.property.count({ where });
    if (remaining > 0) console.log(`Осталось ещё ${remaining} — запустите скрипт повторно.`);
  }
}

// Запуск только как самостоятельного процесса: при импорте (тесты) — ничего.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main()
    .catch((err) => {
      console.error(err);
      process.exitCode = 1;
    })
    .finally(() => prisma.$disconnect());
}
