import { pathToFileURL } from "node:url";
import { prisma } from "../../db.js";
import { recordNewObservations, type SeenListing } from "./discoveryStore.js";
import { somonKeyFingerprint, somonSellerKey } from "./contactIdentity.js";
import { SOMON_SELLER_GONE_STATUSES } from "./sellerCount.js";
import { somonCategoryCountAllowsOwner } from "./sellerAssessment.js";
import { isTelegramPortalAlertsPaused } from "../telegramPortalPause.js";
import { marketCatalogWhere, SOMON_SOURCE } from "../market/somonRubrics.js";

/**
 * РАЗОВЫЙ ДОБОР ЗАЯВОК СОБСТВЕННИКОВ SOMON ЗА ПОСЛЕДНИЕ ДНИ (17.11.2026).
 *
 * С 03.11 по 17.11 монитор стоял на паузе площадок и не видел новых объявлений.
 * Решение владельца 17.11 («да, как советуешь по Somon»): добрать только последние
 * 3–5 дней, а не две недели.
 *
 * КАК: объявления-кандидаты берутся из рыночного каталога (`MarketListing`, его ведёт
 * сбор рынка) — сам добор к Somon НЕ ходит. Кандидаты кладутся в очередь монитора
 * штатной дверью `recordNewObservations` (та же запись, тот же ключ автора, тот же
 * замок), а дальше их разбирает обычный тик монитора: те же фильтры (#94 — свои
 * номера, агентства, счёт автора), та же раздача по очереди получателей, тот же
 * общий бюджет запросов к Somon (не чаще раза в 10 с, остановка на 403, пауза на 429).
 * Своего пути отправки у добора нет.
 *
 * Свежие объявления важнее старых: добранным ставится `lastCheckedAt` на двое суток
 * вперёд — очередь монитора сортирует по нему, поэтому свежие уходят первыми, а добор
 * идёт в свободное время тиков. Поле больше ничем не читается (кроме отметки шага
 * проверки продавца). Живёт запись в очереди 3 дня по `seenAt` — как любая.
 *
 * Предосторожности: окно 1–5 дней, предел штук (`--max`, по умолчанию 150 → не больше
 * ~3 запросов к Somon на штуку), только объявления новее всего, что монитор уже видел,
 * без флага «бизнес-аккаунт» в каталоге, ещё живые в каталоге. Повторный запуск
 * дублей не создаёт (`createMany skipDuplicates` по `advertId`).
 *
 *   локально (из apps/api):  npx tsx src/lib/somonLeads/backfillFromMarket.ts [--apply] [--days=5] [--max=150]
 *   на проде (контейнер api): node dist/lib/somonLeads/backfillFromMarket.js [--apply] [--days=5] [--max=150]
 * Без `--apply` — только отчёт, база не меняется.
 */
export const BACKFILL_MAX_DAYS = 5;
export const BACKFILL_DEFAULT_MAX = 150;
export const BACKFILL_HARD_MAX = 300;
/** Сколько строк каталога за окно читаем самое большее (≈400 новых квартир Somon в сутки × 5 дней с запасом). */
export const BACKFILL_SCAN_LIMIT = 5000;
/** Верхняя оценка запросов к Somon на одно объявление: карточка, телефон, страница автора. */
export const BACKFILL_REQUESTS_PER_ADVERT_MAX = 3;
const DEFER_MS = 2 * 24 * 60 * 60 * 1000;

export type BackfillOptions = { days: number; max: number; apply: boolean; now?: Date };
export type BackfillReport = {
  mode: "dry-run" | "apply";
  blocked: string | null;
  windowFrom: string;
  newerThanAdvertId: string | null;
  candidates: number;
  skippedAgencyFlag: number;
  skippedAlreadySeen: number;
  selected: number;
  /** Пройдут ли локальный фильтр «одно объявление автора в категории» — до любых запросов. */
  passLocalOwnerCount: number;
  goToReviewByCount: number;
  noSellerId: number;
  somonRequestsMax: number;
  recipients: Array<{ name: string; projectedMax: number }>;
  inserted: number;
};

export function parseBackfillArgs(argv: string[]): BackfillOptions {
  const get = (name: string) => argv.find(a => a.startsWith(`--${name}=`))?.split("=")[1];
  const days = Number(get("days") ?? BACKFILL_MAX_DAYS);
  const max = Number(get("max") ?? BACKFILL_DEFAULT_MAX);
  if (!Number.isInteger(days) || days < 1 || days > BACKFILL_MAX_DAYS) throw new Error(`--days: целое от 1 до ${BACKFILL_MAX_DAYS}`);
  if (!Number.isInteger(max) || max < 1 || max > BACKFILL_HARD_MAX) throw new Error(`--max: целое от 1 до ${BACKFILL_HARD_MAX}`);
  const unknown = argv.filter(a => !/^--(apply|days=\d+|max=\d+)$/.test(a));
  if (unknown.length) throw new Error(`Неизвестные параметры: ${unknown.join(" ")}`);
  return { days, max, apply: argv.includes("--apply") };
}

const slugOf = (sourceId: string, url: string): string | null => {
  const m = /^https:\/\/somon\.tj\/adv\/(\d+_[\w%-]{1,180})\/$/.exec(url);
  return m && m[1].startsWith(`${sourceId}_`) ? m[1] : null;
};
const keyOf = (sellerId: string | null): string | null => {
  if (!sellerId || !/^[1-9]\d{0,19}$/.test(sellerId)) return null;
  return somonSellerKey(sellerId);
};

export async function runSomonBackfill(options: BackfillOptions): Promise<BackfillReport> {
  const now = options.now ?? new Date();
  const from = new Date(now.getTime() - options.days * 24 * 60 * 60 * 1000);
  const report: BackfillReport = {
    mode: options.apply ? "apply" : "dry-run", blocked: null, windowFrom: from.toISOString(), newerThanAdvertId: null,
    candidates: 0, skippedAgencyFlag: 0, skippedAlreadySeen: 0, selected: 0, passLocalOwnerCount: 0, goToReviewByCount: 0, noSellerId: 0,
    somonRequestsMax: 0, recipients: [], inserted: 0,
  };
  const state = await prisma.somonMonitor.findUnique({ where: { id: "singleton" } });
  if (!state?.enabled || !state.baselineAt) report.blocked = "монитор выключен или стартовая разметка не закончена";
  else if (state.sourceStopped) report.blocked = "источник Somon остановлен — сначала снять остановку";
  else {
    try { if (state.contactKeyFingerprint !== somonKeyFingerprint()) report.blocked = "ключ сверки контактов не совпадает — монитор всё равно стоит"; }
    catch { report.blocked = "ключ сверки контактов недоступен"; }
  }
  if (!report.blocked && await isTelegramPortalAlertsPaused()) report.blocked = "включена пауза площадок — добранное не уйдёт, пока её не снимут";

  // Только объявления новее всего, что монитор уже видел: старое (до паузы) он уже разобрал.
  const maxSeen = await prisma.$queryRaw<Array<{ max: bigint | null }>>`
    SELECT max("advertId"::bigint) AS max FROM "SomonSeenAdvert" WHERE "advertId" ~ '^[0-9]{1,18}$'`;
  const newerThan = maxSeen[0]?.max ?? null;
  report.newerThanAdvertId = newerThan === null ? null : String(newerThan);
  // Каталог читается только через правило рубрик (одна дверь `marketCatalogWhere`): аренда,
  // дома и чужие рубрики не попадают в добор ещё до проверки монитором. Номер объявления —
  // строка разной длины, поэтому «новее увиденного» и порядок «свежие первыми» — числом в коде.
  const listed = await prisma.marketListing.findMany({
    where: { AND: [marketCatalogWhere(), { source: SOMON_SOURCE, dealType: "SALE", propertyType: "APARTMENT", city: "Душанбе", isActive: true, firstSeenAt: { gte: from } }] },
    orderBy: { firstSeenAt: "desc" },
    take: BACKFILL_SCAN_LIMIT,
    select: { sourceId: true, sourceUrl: true, sellerId: true, isAgency: true },
  });
  const rows = listed
    .filter(r => /^[0-9]{1,18}$/.test(r.sourceId) && BigInt(r.sourceId) > (newerThan ?? 0n))
    .sort((a, b) => (BigInt(b.sourceId) > BigInt(a.sourceId) ? 1 : BigInt(b.sourceId) < BigInt(a.sourceId) ? -1 : 0));
  report.candidates = rows.length;
  const seen = new Set((await prisma.somonSeenAdvert.findMany({ where: { advertId: { in: rows.map(r => r.sourceId) } }, select: { advertId: true } })).map(s => s.advertId));
  const picked: Array<SeenListing & { sellerKey: string | null }> = [];
  for (const r of rows) {
    if (r.isAgency) { report.skippedAgencyFlag++; continue; }
    if (seen.has(r.sourceId)) { report.skippedAlreadySeen++; continue; }
    const slug = slugOf(r.sourceId, r.sourceUrl);
    if (!slug) continue;
    if (picked.length >= options.max) break;
    picked.push({ id: r.sourceId, slug, sellerId: r.sellerId, sellerKey: keyOf(r.sellerId) });
  }
  report.selected = picked.length;

  // Прогноз локального фильтра монитора: «одно объявление автора в категории» по нашим записям,
  // включая сами добираемые (после вставки они тоже в счёте). Запросов к Somon здесь нет.
  const keys = [...new Set(picked.map(p => p.sellerKey).filter((k): k is string => !!k))];
  const existing = keys.length
    ? await prisma.somonSeenAdvert.groupBy({ by: ["sellerKey"], where: { sellerKey: { in: keys }, status: { notIn: SOMON_SELLER_GONE_STATUSES } }, _count: { _all: true } })
    : [];
  const counts = new Map(existing.map(e => [e.sellerKey as string, e._count._all]));
  for (const p of picked) if (p.sellerKey) counts.set(p.sellerKey, (counts.get(p.sellerKey) ?? 0) + 1);
  for (const p of picked) {
    if (!p.sellerKey) report.noSellerId++;
    else if (somonCategoryCountAllowsOwner(counts.get(p.sellerKey) ?? null)) report.passLocalOwnerCount++;
    else report.goToReviewByCount++;
  }
  report.somonRequestsMax = report.passLocalOwnerCount * BACKFILL_REQUESTS_PER_ADVERT_MAX;

  // Получатели — те же, что у монитора: включён, активен, агент, есть Telegram.
  const recipients = await prisma.somonRecipient.findMany({ where: { enabled: true }, orderBy: { position: "asc" }, select: { agentId: true } });
  const agents = await prisma.agent.findMany({ where: { id: { in: recipients.map(r => r.agentId) }, isActive: true, role: "AGENT", telegramChatId: { not: null } }, select: { id: true, fullName: true } });
  const eligible = recipients.map(r => agents.find(a => a.id === r.agentId)).filter((a): a is { id: string; fullName: string } => !!a);
  report.recipients = eligible.map((a, i) => ({
    name: a.fullName.split(" ")[0] ?? "",
    projectedMax: Math.floor(report.passLocalOwnerCount / eligible.length) + (i < report.passLocalOwnerCount % eligible.length ? 1 : 0),
  }));
  if (!eligible.length && !report.blocked) report.blocked = "нет получателей с Telegram";

  if (!options.apply || report.blocked || !picked.length) return report;
  for (let i = 0; i < picked.length; i += 100) {
    const chunk = picked.slice(i, i + 100).map(({ id, slug, sellerId }) => ({ id, slug, sellerId }));
    report.inserted += await recordNewObservations(chunk, now);
  }
  // Свежие — вперёд: добранные встают в очередь после всего, что монитор увидит в ближайшие двое суток.
  await prisma.somonSeenAdvert.updateMany({
    where: { advertId: { in: picked.map(p => p.id) }, status: "PENDING", baseline: false, seenAt: now },
    data: { lastCheckedAt: new Date(now.getTime() + DEFER_MS) },
  });
  return report;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  (async () => {
    const options = parseBackfillArgs(process.argv.slice(2));
    const report = await runSomonBackfill(options);
    console.log(JSON.stringify(report, null, 2));
    await prisma.$disconnect();
    process.exit(report.blocked && options.apply ? 2 : 0);
  })().catch(async error => {
    console.error(error instanceof Error ? error.message : String(error));
    await prisma.$disconnect().catch(() => undefined);
    process.exit(1);
  });
}
