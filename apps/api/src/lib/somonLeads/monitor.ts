import { randomUUID } from "node:crypto";
import { prisma } from "../../db.js";
import { parseSomonListingPage, SomonEmptyListing } from "./strictListing.js";
import { finishShrunkBaseline, recordBaselinePage, recordNewObservations, rekeySellerPage } from "./discoveryStore.js";
import { fetchSomon, SomonSourceUnavailable } from "./sourceClient.js";
import { processSomonPending } from "./processPending.js";
import { cleanupSomonReceipts } from "./deliveryStore.js";
import { logSystemError } from "../systemError.js";
import { somonKeyFingerprint } from "./contactIdentity.js";

const wait = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));
const MAX_PAGES_PER_TICK = 8;
const MAX_SCAN_PAGES = 25;
async function page(n: number) {
  const response = await fetchSomon(`/nedvizhimost/prodazha-kvartir/dushanbe/${n === 1 ? "" : `?page=${n}`}`);
  const html = await response.text();
  // An empty page is treated as a possible shrinking baseline only after a
  // fresh first-page pagination check; malformed nonempty pages fail closed.
  if (!html.includes('self.__next_f.push')) throw new Error("Somon listing payload unavailable");
  return parseSomonListingPage(html, n);
}

/** Only an explicit sufficiently old time permits an early stop. */
export function clearlyOlderThanTenMinutes(text: string | undefined): boolean {
  const value = (text ?? "").toLocaleLowerCase("ru");
  const minutes = /^(\d+)\s*(?:минут|дақиқа)/.exec(value);
  return minutes ? Number(minutes[1]) >= 10 : /^(?:\d+\s*)?(?:час|вчера|день|дня|дней|недел|месяц|год|соат|дирӯз)/.test(value);
}

async function claimRegularScan(now: Date): Promise<string | null> {
  return prisma.$transaction(async tx => {
    await tx.$queryRaw`SELECT 1 FROM pg_advisory_xact_lock(hashtext('somon-owner-delivery'))`;
    const state = await tx.somonMonitor.findUnique({ where: { id: "singleton" } });
    if (!state?.enabled || !state.baselineAt || state.sourceStopped || (state.scanLeaseUntil && state.scanLeaseUntil > now) || (state.scanPage === 1 && state.nextScanAt && state.nextScanAt > now)) return null;
    const token = randomUUID();
    await tx.somonMonitor.update({ where: { id: "singleton" }, data: { scanLeaseToken: token, scanLeaseUntil: new Date(now.getTime() + 100000) } });
    return token;
  }, { timeout: 35000 });
}
async function advanceScan(token: string, currentPage: number, regularPage: number | null, done: boolean): Promise<boolean> {
  const result = await prisma.somonMonitor.updateMany({ where: { id: "singleton", enabled: true, scanLeaseToken: token, scanPage: currentPage }, data: done ? { scanPage: 1, scanRegularPage: null, nextScanAt: new Date(Date.now() + 180000) } : { scanPage: currentPage + 1, scanRegularPage: regularPage } });
  return result.count === 1;
}
async function releaseScan(token: string): Promise<void> {
  await prisma.somonMonitor.updateMany({ where: { id: "singleton", scanLeaseToken: token }, data: { scanLeaseToken: null, scanLeaseUntil: null } });
}

/** Bounded work per tick; no seller photos, texts or phone numbers are stored. */
export async function runSomonMonitorTick(pause: (ms: number) => Promise<void> = wait): Promise<void> {
  const deadline = Date.now() + 45000;
  const stuck = await prisma.somonDelivery.count({ where: { status: "SENDING", updatedAt: { lt: new Date(Date.now() - 120000) } } });
  if (stuck) await logSystemError("telegram", "Somon: обнаружены отправки с неизвестным результатом; автоматического повтора нет", { dedupKey: "somon-delivery-stuck" });
  let state = await prisma.somonMonitor.findUnique({ where: { id: "singleton" } });
  if (!state?.enabled || state.sourceStopped || (state.blockedUntil && state.blockedUntil > new Date())) return;
  try {
    if (!state.contactKeyFingerprint || state.contactKeyFingerprint !== somonKeyFingerprint()) throw new Error("contact identity key changed");
  } catch {
    await logSystemError("cron", "Somon: проверка повторных контактов недоступна; мониторинг остановлен", { dedupKey: "somon-contact-key" });
    return;
  }
  try {
    if (!state.baselineAt) {
      for (let count = 0; count < MAX_PAGES_PER_TICK && Date.now() < deadline; count++) {
        state = await prisma.somonMonitor.findUnique({ where: { id: "singleton" } });
        if (!state?.enabled || state.baselineAt || state.sourceStopped) return;
        const n = state.baselineNextPage;
        let data: Awaited<ReturnType<typeof page>>;
        try { data = await page(n); }
        catch (error) {
          if (n > 1 && ((error instanceof SomonSourceUnavailable && error.status === 404) || error instanceof SomonEmptyListing)) {
            await pause(10200); const first = await page(1);
            if (await finishShrunkBaseline(n, first.last)) return;
          }
          throw error;
        }
        if (data.last < n) {
          await pause(10200); const first = await page(1);
          if (await finishShrunkBaseline(n, first.last)) return;
          throw new Error("Somon baseline pagination changed unexpectedly");
        }
        if (data.ads.some(a => a.sellerId === null)) await logSystemError("cron", "Somon: в выдаче нет ID автора у части объявлений; счёт объявлений продавца неизвестен — такие продавцы уходят на проверку", { dedupKey: "somon-seller-id-missing" });
        const result = await recordBaselinePage(n, data.last, data.ads.map(a => ({ id: String(a.id), sellerId: a.sellerId })));
        if (result === "complete" || result === "disabled") return;
        if (Date.now() < deadline) await pause(10200);
      }
      return;
    }
    const token = await claimRegularScan(new Date());
    if (token) {
      try {
        for (let count = 0; count < MAX_PAGES_PER_TICK && Date.now() < deadline; count++) {
          state = await prisma.somonMonitor.findUnique({ where: { id: "singleton" } });
          if (!state?.enabled || state.sourceStopped || state.scanLeaseToken !== token) return;
          const n = state.scanPage;
          const data = await page(n);
          let rejectedSlug = false;
          const listings = data.ads.flatMap(a => {
            const m = /^\/adv\/(\d+_[\w%-]+)\/$/.exec(a.url ?? "");
            if (!m || !m[1].startsWith(`${a.id}_`) || m[1].length > String(a.id).length + 181) { rejectedSlug = true; return []; }
            return [{ id: String(a.id), slug: m[1], sellerId: a.sellerId }];
          });
          if (rejectedSlug) await logSystemError("cron", "Somon: часть ссылок объявлений не удалось обработать", { dedupKey: "somon-invalid-slug" });
          if (data.ads.some(a => a.sellerId === null)) await logSystemError("cron", "Somon: в выдаче нет ID автора у части объявлений; счёт объявлений продавца неизвестен — такие продавцы уходят на проверку", { dedupKey: "somon-seller-id-missing" });
          await recordNewObservations(listings);
          const regular = data.ads.filter(a => a.ad_type?.type === "regular");
          const firstRegular = state.scanRegularPage ?? (regular.length ? n : null);
          const safeTail = firstRegular !== null && n > firstRegular && regular.length > 0 && clearlyOlderThanTenMinutes(regular[regular.length - 1].published ?? undefined);
          const capped = n >= MAX_SCAN_PAGES;
          const done = safeTail || n >= data.last || capped;
          if (!(await advanceScan(token, n, firstRegular, done))) return;
          if (capped && !safeTail && n < data.last) await logSystemError("cron", "Somon: достигнут предел страниц; часть новых объявлений могла быть пропущена", { dedupKey: "somon-coverage-limit" });
          if (done) break;
          if (Date.now() < deadline) await pause(10200);
        }
      } finally { await releaseScan(token); }
      if (Date.now() < deadline) await pause(10200);
    }
    if (Date.now() < deadline) {
      const pending = await prisma.somonSeenAdvert.findMany({ where: { status: "PENDING", baseline: false }, orderBy: [{ lastCheckedAt: { sort: "asc", nulls: "first" } }, { seenAt: "asc" }], take: 2, select: { advertId: true, seenAt: true } });
      if (pending[0] && Date.now() - pending[0].seenAt.getTime() > 15 * 60_000) await logSystemError("cron", "Somon: очередь объявлений задерживается более 15 минут", { dedupKey: "somon-pending-delay" });
      for (const item of pending) {
        if (Date.now() >= deadline) break;
        const result = await processSomonPending(item.advertId, pause);
        if (result === "waiting" || result === "unknown") break;
        if (Date.now() < deadline) await pause(10200);
      }
    }
    await cleanupSomonReceipts();
    // Мягкая дозапись ключа автора старым записям: одна страница за тик, после доставки,
    // чтобы не отнимать у неё бюджет источника (сброса baseline нет — рассылка идёт).
    // Источник ещё не готов (интервал запросов) — not_ready ниже, повтор в следующий тик.
    state = await prisma.somonMonitor.findUnique({ where: { id: "singleton" } });
    if (state?.enabled && !state.sourceStopped && state.sellerKeyRekeyPage !== null && deadline - Date.now() > 12000) {
      const n = state.sellerKeyRekeyPage;
      let data: Awaited<ReturnType<typeof page>> | null;
      try { data = await page(n); }
      catch (error) {
        // Выдача стала короче курсора — дописывать больше нечего, проход завершён.
        if (n > 1 && ((error instanceof SomonSourceUnavailable && error.status === 404) || error instanceof SomonEmptyListing)) data = null;
        else throw error;
      }
      await rekeySellerPage(n, data ? data.last : n, data ? data.ads.map(a => ({ id: String(a.id), sellerId: a.sellerId })) : []);
    }
  } catch (error) {
    if (error instanceof SomonSourceUnavailable && error.reason === "not_ready") return;
    throw error;
  }
}
