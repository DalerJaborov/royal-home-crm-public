import { prisma } from "../../db.js";
import { somonSellerKey } from "./contactIdentity.js";
import { SOMON_SELLER_UNKNOWN, SOMON_SELLER_UNKNOWN_DAYS } from "./sellerCount.js";

const validId = (id: string) => /^\d{1,20}$/.test(id);
/** `sellerId` — ID автора из выдачи; null, если в выдаче его не было. Храним только ключ. */
export type SeenListing = { id: string; slug: string; sellerId?: string | null };
export type BaselineListing = { id: string; sellerId: string | null };

const sellerKeyOf = (sellerId: string | null | undefined) => (sellerId ? somonSellerKey(sellerId) : null);

/** Дописывает ключ автора уже известным объявлениям, у которых его нет (записи до
 * появления поля или повторно увиденные). Существующий ключ не перезаписываем. */
async function backfillSellerKeys(tx: Pick<typeof prisma, "$executeRaw">, rows: Array<{ advertId: string; sellerKey: string | null }>, now: Date) {
  const known = rows.filter((r): r is { advertId: string; sellerKey: string } => r.sellerKey !== null);
  if (!known.length) return;
  // Отложенное «автор неизвестен» возвращаем в очередь, только если оно ещё свежее и
  // моложе текущего baseline (иначе резерв отправки всё равно ответил бы not_new).
  const freshSince = new Date(now.getTime() - SOMON_SELLER_UNKNOWN_DAYS * 24 * 60 * 60 * 1000);
  await tx.$executeRaw`UPDATE "SomonSeenAdvert" s SET "sellerKey" = v.k,
      "status" = CASE WHEN s."status" = ${SOMON_SELLER_UNKNOWN} AND s."seenAt" > ${freshSince}
        AND s."seenAt" > COALESCE((SELECT m."baselineAt" FROM "SomonMonitor" m WHERE m."id" = 'singleton'), s."seenAt") THEN 'PENDING' ELSE s."status" END
    FROM unnest(${known.map(r => r.advertId)}::text[], ${known.map(r => r.sellerKey)}::text[]) AS v(id, k)
    WHERE s."advertId" = v.id AND s."sellerKey" IS NULL`;
}

/** Store only IDs and keyed author fingerprints for the initial scan. Incomplete scans can never activate delivery.
 * Ключ автора пишем и здесь: иначе старые объявления того же автора не попадут в счёт,
 * и продавец с несколькими квартирами выглядел бы владельцем одной. */
export async function recordBaselinePage(page: number, lastPage: number, listings: BaselineListing[], now = new Date()): Promise<"saved" | "complete" | "duplicate" | "disabled"> {
  if (!Number.isInteger(page) || page < 1 || !Number.isInteger(lastPage) || lastPage < page || lastPage > 10000 || listings.length === 0 || listings.length > 300 || listings.some(x => !validId(x.id))) throw new Error("Invalid baseline page");
  const rows = [...new Map(listings.map(x => [x.id, { advertId: x.id, sellerKey: sellerKeyOf(x.sellerId) }])).values()];
  return prisma.$transaction(async tx => {
    await tx.$queryRaw`SELECT 1 FROM pg_advisory_xact_lock(hashtext('somon-owner-delivery'))`;
    const state = await tx.somonMonitor.findUnique({ where: { id: "singleton" } });
    if (!state?.enabled || state.baselineAt) return "disabled";
    if (page < state.baselineNextPage) return "duplicate";
    if (page !== state.baselineNextPage) throw new Error("Baseline pages out of order");
    await tx.somonSeenAdvert.createMany({ data: rows.map(r => ({ ...r, baseline: true, status: "BASELINE" })), skipDuplicates: true });
    await backfillSellerKeys(tx, rows, now);
    const end = Math.max(lastPage, state.baselineLastPage ?? 0);
    const complete = page >= end;
    await tx.somonMonitor.update({ where: { id: "singleton" }, data: { baselineNextPage: page + 1, baselineLastPage: end, ...(complete ? { baselineAt: now, activatedAt: now } : {}) } });
    return complete ? "complete" : "saved";
  }, { timeout: 35000 });
}

/** Finish after a missing next page only after a fresh first-page pagination
 * confirms that the list shrank below the already processed cursor. */
export async function finishShrunkBaseline(nextPage: number, currentLastPage: number, now = new Date()): Promise<boolean> {
  if (!Number.isInteger(nextPage) || !Number.isInteger(currentLastPage) || currentLastPage < 1 || currentLastPage >= nextPage) return false;
  return prisma.$transaction(async tx => {
    await tx.$queryRaw`SELECT 1 FROM pg_advisory_xact_lock(hashtext('somon-owner-delivery'))`;
    const state = await tx.somonMonitor.findUnique({ where: { id: "singleton" } });
    if (!state?.enabled || state.baselineAt || state.baselineNextPage !== nextPage || nextPage < 2) return false;
    await tx.somonMonitor.update({ where: { id: "singleton" }, data: { baselineAt: now, activatedAt: now, baselineLastPage: currentLastPage } });
    return true;
  }, { timeout: 35000 });
}

/** First observed after the complete baseline, not necessarily first published.
 * Such listings always require the explicitly requested date warning. */
export async function recordNewObservations(listings: SeenListing[], now = new Date()): Promise<number> {
  if (listings.length > 300 || listings.some(x => !validId(x.id) || !new RegExp(`^${x.id}_[\\w%-]{1,180}$`).test(x.slug))) throw new Error("Invalid Somon listings");
  const keyed = listings.map(x => ({ ...x, sellerKey: sellerKeyOf(x.sellerId) }));
  return prisma.$transaction(async tx => {
    await tx.$queryRaw`SELECT 1 FROM pg_advisory_xact_lock(hashtext('somon-owner-delivery'))`;
    const state = await tx.somonMonitor.findUnique({ where: { id: "singleton" } });
    if (!state?.enabled || !state.baselineAt || now <= state.baselineAt) return 0;
    const result = await tx.somonSeenAdvert.createMany({ data: keyed.map(x => ({ advertId: x.id, slug: x.slug, sellerKey: x.sellerKey, seenAt: now, lastCheckedAt: now, baseline: false, status: "PENDING" })), skipDuplicates: true });
    await backfillSellerKeys(tx, keyed.map(x => ({ advertId: x.id, sellerKey: x.sellerKey })), now);
    return result.count;
  }, { timeout: 35000 });
}

/** Отложенные из-за неполной дозаписи ключей (у объявления ключ есть, но старые записи
 * того же автора могли быть без ключа) — обратно в очередь, пока они свежие. */
async function requeueAfterRekey(tx: Pick<typeof prisma, "$executeRaw">, now: Date) {
  const freshSince = new Date(now.getTime() - SOMON_SELLER_UNKNOWN_DAYS * 24 * 60 * 60 * 1000);
  await tx.$executeRaw`UPDATE "SomonSeenAdvert" s SET "status" = 'PENDING'
    WHERE s."status" = ${SOMON_SELLER_UNKNOWN} AND s."baseline" = false AND s."sellerKey" IS NOT NULL AND s."slug" IS NOT NULL
      AND s."seenAt" > ${freshSince}
      AND s."seenAt" > COALESCE((SELECT m."baselineAt" FROM "SomonMonitor" m WHERE m."id" = 'singleton'), s."seenAt")`;
}

/**
 * Мягкая дозапись ключа автора записям, сделанным до появления `sellerKey` (решение
 * 01.11.2026 вместо сброса baseline: рассылка не останавливается). Проход по выдаче
 * ТОЛЬКО дописывает ключ уже известным объявлениям: новых записей не создаёт, статусы
 * не трогает (кроме возврата отложенного «автор неизвестен» — как в обычном проходе).
 * Пока проход не завершён, счёт по автору может быть занижен — `processSomonPending`
 * тогда не считает собственником никого, у кого на сайте больше одного объявления.
 */
export async function rekeySellerPage(page: number, lastPage: number, listings: BaselineListing[], now = new Date()): Promise<"saved" | "complete" | "stale"> {
  if (!Number.isInteger(page) || page < 1 || !Number.isInteger(lastPage) || lastPage < 1 || lastPage > 10000 || listings.length > 300 || listings.some(x => !validId(x.id))) throw new Error("Invalid rekey page");
  const rows = [...new Map(listings.map(x => [x.id, { advertId: x.id, sellerKey: sellerKeyOf(x.sellerId) }])).values()];
  return prisma.$transaction(async tx => {
    await tx.$queryRaw`SELECT 1 FROM pg_advisory_xact_lock(hashtext('somon-owner-delivery'))`;
    const state = await tx.somonMonitor.findUnique({ where: { id: "singleton" } });
    if (!state?.enabled || state.sellerKeyRekeyPage !== page) return "stale";
    await backfillSellerKeys(tx, rows, now);
    const complete = page >= lastPage;
    await tx.somonMonitor.update({ where: { id: "singleton" }, data: { sellerKeyRekeyPage: complete ? null : page + 1 } });
    if (complete) await requeueAfterRekey(tx, now);
    return complete ? "complete" : "saved";
  }, { timeout: 35000 });
}
