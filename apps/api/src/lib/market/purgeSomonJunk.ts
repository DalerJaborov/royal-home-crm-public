/**
 * ЧИСТКА КАТАЛОГА SOMON ОТ ЧУЖИХ РУБРИК (разовый, 12.11.2026).
 *
 * Предыстория — шапка `somonRubrics.ts`: ручной обход 11.11.2026 прошёл по общей ленте Somon
 * (старый адрес раздела домов) и записал в MarketListing ~13,5 тыс. объявлений автозапчастей,
 * окон, ноутбуков, услуг — «квартирами/домами на продажу». Вперёд мусор больше не пишется
 * (правило рубрик в сборщике и парсере лидов), а читать его уже сейчас не даёт
 * `marketCatalogWhere`. Скрипт убирает то, что уже лежит.
 *
 * Что делает:
 *  1. печатает строки Somon по рубрикам (номер, slug, сколько) — что останется и что уйдёт;
 *  2. с `--apply` удаляет строки Somon, чья рубрика НЕ из списка недвижимости (или рубрики нет
 *     вовсе), пачками по `--batch` (по умолчанию 500). Вместе с ними каскадом уходят их снимки цен
 *     (MarketPriceSnapshot) и совпадения с нашими объектами (PropertyMarketMatch) — их число
 *     печатается заранее;
 *  3. с `--apply` переписывает строки СВОИХ рубрик, записанные старым разбором с другим типом
 *     (дома рубрики 218 лежат «квартирами», этаж = этажность дома): тип, этаж, этажность, сотки,
 *     площадь и цена за м² — тем же разбором, что у сборщика.
 * Paydo и прочие площадки не трогаются вообще.
 *
 * ЗАПУСК:
 *   локально (из apps/api):  npx tsx src/lib/market/purgeSomonJunk.ts [--apply] [--batch 500]
 *   на проде (контейнер api): node dist/lib/market/purgeSomonJunk.js [--apply] [--batch 500]
 * Без `--apply` не пишет НИЧЕГО. Повторный запуск безопасен: второй раз удалять нечего.
 * Перед `--apply` на проде — копия таблицы (pg_dump -t '"MarketListing"' -t '"MarketPriceSnapshot"'
 * -t '"PropertyMarketMatch"'): удаление необратимо.
 *
 * Страховка: если по списку рубрик НЕ осталось бы ни одной строки Somon, а удалить есть что, —
 * отказ (значит, сменился формат сырья, а не «всё мусор»).
 *
 * Вторая страховка (ревью #160): среди удаляемых может оказаться НЕДВИЖИМОСТЬ, которой просто нет в
 * списке рубрик (новая подрубрика Somon, «7 комнат», аренда гаражей). Подозрительной считается рубрика,
 * чей slug похож на недвижимость (kvartir|komnat|dom|uchast|arend|ofis|nedvizh) или чей предок —
 * «Недвижимость» (id 121 / slug nedvizhimost в сырье). Просмотр печатает их отдельным списком, а
 * `--apply` при них отказывает, пока не добавлен `--force` (сначала решить: дописать рубрику в
 * somonRubrics.ts или удалить осознанно). Ложные срабатывания («dlya-doma», «domashnie-zhivotnye»)
 * возможны — на то и отдельный список глазами.
 *
 *   node dist/lib/market/purgeSomonJunk.js --apply --force   — удалить и подозрительные тоже
 */
import { pathToFileURL } from "node:url";
import { prisma } from "../../db.js";
import { pricePerSqm } from "./marketStore.js";
import { toListing, type SomonRawAd } from "./somonParser.js";
import { SOMON_REAL_ESTATE_RUBRICS, SOMON_SOURCE, somonRubricOf } from "./somonRubrics.js";

const DEFAULT_BATCH = 500;
const MAX_BATCH = 5000;
const KEEP_IDS = SOMON_REAL_ESTATE_RUBRICS.map((r) => String(r.id));

export interface RubricCount {
  rubricId: string | null;
  slug: string | null;
  count: number;
  /** Хоть у одной строки рубрики предок — «Недвижимость» (id 121 / slug nedvizhimost). */
  realEstateParent?: boolean;
}

export interface PurgePlan {
  keep: number;
  junk: number;
  /** Удаляемые рубрики, похожие на недвижимость: без --force не удаляются. */
  suspicious: Array<RubricCount & { keep: boolean }>;
  byRubric: Array<RubricCount & { keep: boolean }>;
}

const REAL_ESTATE_SLUG = /kvartir|komnat|dom|uchast|arend|ofis|nedvizh/i;

/** Удаляемая рубрика может оказаться недвижимостью, которой нет в списке. */
export function looksLikeRealEstate(r: RubricCount): boolean {
  return r.realEstateParent === true || REAL_ESTATE_SLUG.test(r.slug ?? "");
}

/** Чистая часть: какие рубрики остаются, какие уходят и какие из уходящих подозрительны. */
export function planFromCounts(rows: RubricCount[]): PurgePlan {
  const keepSet = new Set(KEEP_IDS);
  const byRubric = rows.map((r) => ({ ...r, keep: r.rubricId != null && keepSet.has(r.rubricId) })).sort((a, b) => b.count - a.count);
  return {
    keep: byRubric.filter((r) => r.keep).reduce((s, r) => s + r.count, 0),
    junk: byRubric.filter((r) => !r.keep).reduce((s, r) => s + r.count, 0),
    suspicious: byRubric.filter((r) => !r.keep && looksLikeRealEstate(r)),
    byRubric,
  };
}

export type ApplyVerdict = { ok: true } | { ok: false; reason: "nothing_kept" | "suspicious" };

/** Можно ли выполнять `--apply` по этому плану. */
export function applyVerdict(plan: PurgePlan, force: boolean): ApplyVerdict {
  if (plan.keep === 0 && plan.junk > 0) return { ok: false, reason: "nothing_kept" };
  if (plan.suspicious.length > 0 && !force) return { ok: false, reason: "suspicious" };
  return { ok: true };
}

export async function countByRubric(): Promise<RubricCount[]> {
  const rows = await prisma.$queryRaw<Array<{ rubric_id: string | null; slug: string | null; n: number; re_parent: boolean | null }>>`
    SELECT raw->'rubric'->>'id' AS rubric_id, raw->'rubric'->>'slug' AS slug, count(*)::int AS n,
           bool_or(COALESCE(raw->'rubric'->'ancestors', '[]'::jsonb) @> '[{"id":121}]'::jsonb
                OR COALESCE(raw->'rubric'->'ancestors', '[]'::jsonb) @> '[{"slug":"nedvizhimost"}]'::jsonb) AS re_parent
    FROM "MarketListing" WHERE source = ${SOMON_SOURCE}
    GROUP BY 1, 2`;
  return rows.map((r) => ({ rubricId: r.rubric_id, slug: r.slug, count: Number(r.n), realEstateParent: r.re_parent === true }));
}

/** Сколько снимков цен и совпадений с нашими объектами уйдёт каскадом вместе с мусором. */
async function countCascade(): Promise<{ snapshots: number; matches: number }> {
  const [row] = await prisma.$queryRaw<Array<{ snapshots: number; matches: number }>>`
    WITH junk AS (
      SELECT id FROM "MarketListing"
      WHERE source = ${SOMON_SOURCE} AND COALESCE(raw->'rubric'->>'id', '') <> ALL(${KEEP_IDS}::text[])
    )
    SELECT (SELECT count(*)::int FROM "MarketPriceSnapshot" WHERE "listingId" IN (SELECT id FROM junk)) AS snapshots,
           (SELECT count(*)::int FROM "PropertyMarketMatch" WHERE "listingId" IN (SELECT id FROM junk)) AS matches`;
  return { snapshots: Number(row?.snapshots ?? 0), matches: Number(row?.matches ?? 0) };
}

/**
 * Удаляет мусор пачками. Возвращает, сколько строк удалено. `sourceIdPrefix` — только для тестов
 * (своя полоса строк в общей тестовой базе); в скрипте не задаётся.
 */
export async function deleteJunk(batch = DEFAULT_BATCH, sourceIdPrefix = ""): Promise<number> {
  let deleted = 0;
  const like = `${sourceIdPrefix}%`;
  for (;;) {
    const ids = await prisma.$queryRaw<Array<{ id: string }>>`
      SELECT id FROM "MarketListing"
      WHERE source = ${SOMON_SOURCE} AND "sourceId" LIKE ${like}
        AND COALESCE(raw->'rubric'->>'id', '') <> ALL(${KEEP_IDS}::text[])
      LIMIT ${batch}`;
    if (ids.length === 0) return deleted;
    const res = await prisma.marketListing.deleteMany({ where: { id: { in: ids.map((r) => r.id) }, source: SOMON_SOURCE } });
    deleted += res.count;
    console.log(`  удалено ${deleted}`);
  }
}

/** Строки своих рубрик, записанные с другим типом: переписывает тем же разбором, что у сборщика. */
export async function fixMisclassified(apply: boolean, sourceIdPrefix = ""): Promise<number> {
  let fixed = 0;
  let cursor: string | undefined;
  for (;;) {
    const rows = await prisma.marketListing.findMany({
      where: { source: SOMON_SOURCE, ...(sourceIdPrefix ? { sourceId: { startsWith: sourceIdPrefix } } : {}), ...(cursor ? { id: { gt: cursor } } : {}) },
      select: { id: true, raw: true, dealType: true, propertyType: true, priceTjs: true },
      orderBy: { id: "asc" },
      take: 1000,
    });
    if (rows.length === 0) return fixed;
    cursor = rows[rows.length - 1].id;
    for (const row of rows) {
      const rubric = somonRubricOf(row.raw);
      if (!rubric || (rubric.dealType === row.dealType && rubric.propertyType === row.propertyType)) continue;
      const parsed = toListing(row.raw as unknown as SomonRawAd);
      if (!parsed) continue;
      fixed++;
      if (!apply) continue;
      const priceTjs = row.priceTjs != null ? Number(row.priceTjs) : null;
      await prisma.marketListing.update({
        where: { id: row.id },
        data: {
          dealType: parsed.dealType,
          propertyType: parsed.propertyType,
          rooms: parsed.rooms,
          floor: parsed.floor,
          totalFloors: parsed.totalFloors ?? null,
          landSotki: parsed.landSotki ?? null,
          areaSqm: parsed.areaSqm,
          landmark: parsed.landmark,
          pricePerSqmTjs: pricePerSqm(priceTjs, parsed.areaSqm),
        },
      });
    }
  }
}

function parseArgs(argv: string[]): { apply: boolean; force: boolean; batch: number } {
  const apply = argv.includes("--apply");
  const force = argv.includes("--force");
  const i = argv.indexOf("--batch");
  const raw = i >= 0 ? Number(argv[i + 1]) : DEFAULT_BATCH;
  const batch = Number.isInteger(raw) && raw > 0 ? Math.min(raw, MAX_BATCH) : DEFAULT_BATCH;
  return { apply, force, batch };
}

async function main(): Promise<void> {
  const { apply, force, batch } = parseArgs(process.argv.slice(2));
  const plan = planFromCounts(await countByRubric());
  console.log(`Somon в каталоге: останется ${plan.keep}, уйдёт ${plan.junk}.`);
  for (const r of plan.byRubric) {
    console.log(`  ${r.keep ? "оставить" : "удалить "}  рубрика ${r.rubricId ?? "—"} ${r.slug ?? "(нет)"}: ${r.count}`);
  }
  if (plan.suspicious.length) {
    console.log(`ВНИМАНИЕ: среди удаляемых похожи на недвижимость (${plan.suspicious.length}) — без --force не удаляются:`);
    for (const r of plan.suspicious) {
      console.log(`  ?  рубрика ${r.rubricId ?? "—"} ${r.slug ?? "(нет)"}: ${r.count}${r.realEstateParent ? " (предок «Недвижимость»)" : ""}`);
    }
  }
  const cascade = await countCascade();
  console.log(`Вместе с мусором каскадом уйдут: снимков цен ${cascade.snapshots}, совпадений с нашими объектами ${cascade.matches}.`);
  const misclassified = await fixMisclassified(false);
  console.log(`Строк своих рубрик с неверным типом (будут переписаны): ${misclassified}.`);

  if (!apply) {
    console.log("Это просмотр: ничего не изменено. Выполнить — с флагом --apply.");
    return;
  }
  const verdict = applyVerdict(plan, force);
  if (!verdict.ok) {
    console.error(
      verdict.reason === "nothing_kept"
        ? "Отказ: по списку рубрик не осталось бы ни одной строки Somon — похоже, сменился формат сырья."
        : "Отказ: среди удаляемых есть рубрики, похожие на недвижимость (список выше). Дописать их в somonRubrics.ts или запустить с --force."
    );
    process.exitCode = 1;
    return;
  }
  const deleted = await deleteJunk(batch);
  const fixed = await fixMisclassified(true);
  console.log(`Готово: удалено ${deleted}, переписано ${fixed}.`);
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
