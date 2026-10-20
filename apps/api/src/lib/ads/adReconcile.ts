import type { AdIssue, AdIssueKind, AdReconcileReport } from "@royal-home/shared";
import { prisma } from "../../db.js";
import { describeError } from "../describeError.js";
import { centsToTjs, fromCents, loadMoneyContext, toCents, toTjs, type MoneyContext } from "../money.js";
import { logSystemError } from "../systemError.js";
import { loadAdAllocations } from "./adAllocation.js";
import { buildAdSpendReport } from "./adSpendReport.js";
import {
  fetchAccountSpendTotal,
  fetchAdAccountCurrency,
  isMetaAdsConfigured,
  loadMetaAdsCredentials,
  type MetaAdsCredentials,
} from "./metaAdsApi.js";

/**
 * СТОРОЖ СВЕРКИ РЕКЛАМЫ (03.10.2026).
 *
 * Появился после истории с «гибким» объявлением «Умед хонахо»: четыре ролика про
 * четыре квартиры, весь расход на одной, у трёх остальных нули — и никто об этом не
 * узнал, пока владелец не посмотрел глазами. Такой класс поломок (деньги на не том
 * объекте или потерянные по дороге) не ловят ни сборка, ни тесты, поэтому сверка
 * идёт на живых данных после каждой синхронизации:
 *
 *   NO_OBJECT          идёт и тратит, а объекта, «бренда» и «чужого» нет;
 *   ASSETS_NOT_LINKED  материалов в объявлении больше, чем привязанных объектов;
 *   SHARE_SUM_BROKEN   деньги по объектам не равны расходу объявления до дирама, или
 *                      Ad.propertyId разошёлся со строками AdProperty (ИНВАРИАНТ);
 *   SPEND_MISMATCH     итог расхода в CRM против итога кабинета Meta;
 *   STALE_SYNC         сверка давно не проходила или Meta не ответила;
 *   AD_REJECTED        Meta отклонила объявление / у него проблемы доставки.
 *
 * Привязку, сделанную человеком (MANUAL), сторож считает решённым вопросом:
 * ASSETS_NOT_LINKED на неё не заводится — иначе пять фото одной квартиры вечно
 * висели бы «неполным» объявлением, хотя человек уже сказал, что это за объект.
 */

/** Допуск сверки с Meta: больше из 1 % итога и одного доллара (в сомони по курсу CRM). */
const MISMATCH_PCT = 1;
const MISMATCH_USD = 1;
/** Сверка с кабинетом не выходила дольше этого — считаем сбой синхронизации (шаг крона 15 минут). */
const STALE_AFTER_MS = 3 * 60 * 60 * 1000;
const MAX_ADS = 1000;
const MAX_ISSUES = 200;
/** Отклонённые давно (месяцы назад) в сверку не лезут: интересны свежие и те, что тратили в периоде. */
const REJECTED_FRESH_MS = 30 * 24 * 60 * 60 * 1000;
const REJECTED = new Set(["DISAPPROVED", "WITH_ISSUES", "ADSET_DISAPPROVED", "CAMPAIGN_DISAPPROVED"]);
/** Те же статусы читает сторож тревог директору (adAlerts.ts) — один список на оба. */
export const REJECTED_AD_STATUSES: ReadonlySet<string> = REJECTED;

const META_TOTAL_TTL_MS = 60 * 1000;
const metaTotalCache = new Map<string, { at: number; value: number; currency: "USD" | "TJS" }>();

function day(d: Date): string {
  return d.toISOString().slice(0, 10);
}

/**
 * Начало текста «итог кабинета Meta не получен». Это ОТКАЗ Meta (сеть, права), а не
 * «давно не сверялись»: в журнал он идёт тихо (без пуша), а «давно не сверялись» — громко,
 * но из крона (watchStaleSync), чтобы одно моргание Graph не будило директора.
 */
const META_TOTAL_FAILED_TEXT = "Итог кабинета Meta не получен";

export interface ReconcileRange {
  from: Date;
  to: Date;
}

export interface ReconcileOptions {
  /** Креды Meta; не переданы — читаются из Настроек. */
  credentials?: MetaAdsCredentials | null;
  /** false — без похода в Meta (сверка с итогом кабинета пропускается). */
  checkMeta?: boolean;
}

/** Итог расхода кабинетов по самой Meta, в сомони. null — Meta не ответила. */
async function loadMetaTotalTjs(
  credentials: MetaAdsCredentials,
  range: ReconcileRange,
  money: MoneyContext
): Promise<{ total: number | null; error: string | null }> {
  const since = day(range.from);
  const until = day(range.to);
  let totalCents = 0;
  try {
    for (const accountId of credentials.adAccountIds) {
      const cacheKey = `${accountId}|${since}|${until}`;
      let hit = metaTotalCache.get(cacheKey);
      if (!hit || Date.now() - hit.at >= META_TOTAL_TTL_MS) {
        const currency = await fetchAdAccountCurrency(credentials, accountId);
        // Валюта не прочитана: итог без неё посчитать нельзя (доллар по умолчанию
        // исказил бы сумму кабинета в сомони в разы) — уходим в «итог не получен».
        if (!currency) throw new Error(`валюта кабинета ${accountId} не прочитана`);
        const value = await fetchAccountSpendTotal(credentials, accountId, since, until);
        hit = { at: Date.now(), value, currency };
        metaTotalCache.set(cacheKey, hit);
      }
      totalCents += centsToTjs(toCents(hit.value), hit.currency, money);
    }
    return { total: fromCents(totalCents), error: null };
  } catch (err) {
    return { total: null, error: describeError(err) };
  }
}

export async function buildReconcileReport(
  range: ReconcileRange,
  options: ReconcileOptions = {}
): Promise<AdReconcileReport> {
  const issues: AdIssue[] = [];
  const push = (kind: AdIssueKind, adId: string | null, text: string) => {
    if (issues.length < MAX_ISSUES) issues.push({ kind, adId, text });
  };
  const money = await loadMoneyContext();
  const now = Date.now();

  const credentials = options.credentials === undefined ? await loadMetaAdsCredentials() : options.credentials;
  const metaConfigured = !!credentials && isMetaAdsConfigured(credentials);
  const accountIds = credentials?.adAccountIds ?? [];
  // Объявления кабинетов, которые читаем (и старые строки без кабинета): так итог
  // CRM сравнивается с итогом ТЕХ ЖЕ кабинетов, а не со всем, что когда-то лежало в базе.
  const accountFilter = metaConfigured ? { OR: [{ adAccountId: { in: accountIds } }, { adAccountId: null }] } : {};

  // ── 1. Деньги по объявлениям за период (все, включая «чужие»: Meta считает и их).
  const spendRows = await prisma.adSpendDaily.groupBy({
    by: ["adId", "currency"],
    where: { date: { gte: range.from, lte: range.to }, ad: accountFilter },
    _sum: { spend: true },
    orderBy: { _sum: { spend: "desc" } },
    take: MAX_ADS * 2,
  });
  const centsByAd = new Map<string, { currency: string; cents: number }[]>();
  let crmCents = 0;
  for (const r of spendRows) {
    const cents = toCents(r._sum.spend ?? 0);
    crmCents += centsToTjs(cents, r.currency, money);
    const list = centsByAd.get(r.adId) ?? [];
    list.push({ currency: r.currency, cents });
    centsByAd.set(r.adId, list);
  }

  // ── 2. Объявления: те, что тратили, и те, что включены прямо сейчас.
  const adSelect = {
    id: true,
    name: true,
    excluded: true,
    brand: true,
    status: true,
    stopTime: true,
    createdTime: true,
    matchSource: true,
    assetCount: true,
    propertyId: true,
  } as const;
  const [spending, active] = await Promise.all([
    prisma.ad.findMany({ where: { id: { in: Array.from(centsByAd.keys()).slice(0, MAX_ADS) } }, select: adSelect }),
    prisma.ad.findMany({
      where: { excluded: false, brand: false, status: "ACTIVE", ...accountFilter },
      select: adSelect,
      orderBy: [{ createdTime: "desc" }, { firstSeenAt: "desc" }],
      take: MAX_ADS,
    }),
  ]);
  const adById = new Map([...spending, ...active].map((a) => [a.id, a]));
  const ads = Array.from(adById.values()).filter((a) => !a.excluded);
  const allocations = await loadAdAllocations(ads.map((a) => a.id));

  // Связи, у которых Ad.propertyId разошёлся со строками AdProperty (два источника правды):
  // основной объект обязан входить в связи, а связи — существовать при заполненном propertyId.
  const rowsDrift = await prisma.ad.findMany({
    where: { excluded: false, OR: [{ properties: { some: {} } }, { propertyId: { not: null } }] },
    select: { id: true, name: true, propertyId: true, properties: { select: { propertyId: true } } },
    take: MAX_ADS,
  });
  for (const a of rowsDrift) {
    const ids = a.properties.map((p) => p.propertyId);
    if (a.propertyId ? !ids.includes(a.propertyId) : ids.length > 0) {
      push(
        "SHARE_SUM_BROKEN",
        a.id,
        a.propertyId && ids.length === 0
          ? `«${a.name}»: основной объект указан, а строк долей (AdProperty) нет`
          : `«${a.name}»: основной объект объявления разошёлся с долями (Ad.propertyId и AdProperty)`
      );
    }
  }

  // ЖИВАЯ проверка денег: сумма строк отчёта «по объектам» против суммы по объявлениям.
  // Отчёт собирает деньги другим путём (деление allocateCents по долям, «Не привязано»),
  // чем сумма выше (groupBy по объявлению) — потеря цента или целой доли в делении видна
  // как расхождение. Собственные доли саму с собой (прежняя проверка) этого не ловили.
  // Сумма по объявлениям берётся ТЕМ ЖЕ условием, что у отчёта (все кабинеты, без чужой
  // рекламы), но БЕЗ деления по объектам: расходятся они только если деление теряет деньги.
  const adTotals = await prisma.adSpendDaily.groupBy({
    by: ["adId", "currency"],
    where: { date: { gte: range.from, lte: range.to }, ad: { excluded: false } },
    _sum: { spend: true },
    orderBy: { _sum: { spend: "desc" } },
    take: MAX_ADS + 1,
  });
  if (adTotals.length > 0 && adTotals.length <= MAX_ADS) {
    let adsCents = 0;
    for (const r of adTotals) adsCents += centsToTjs(toCents(r._sum.spend ?? 0), r.currency, money);
    const report = await buildAdSpendReport({ from: range.from, to: range.to });
    if (!report.truncated) {
      const objectsCents = report.rows.reduce((acc, row) => acc + toCents(row.spendTjs), 0);
      if (objectsCents !== adsCents) {
        push(
          "SHARE_SUM_BROKEN",
          null,
          `Сумма отчёта по объектам ${fromCents(objectsCents).toFixed(2)} с. не равна сумме по объявлениям ${fromCents(adsCents).toFixed(2)} с. ` +
            `за ${day(range.from)} — ${day(range.to)}: часть денег потеряна при делении по объектам`
        );
      }
    }
  }

  for (const ad of ads) {
    const items = allocations.get(ad.id) ?? [];
    const spent = centsByAd.get(ad.id) ?? [];
    const spentCents = spent.reduce((acc, s) => acc + s.cents, 0);
    const liveNow = ad.status === "ACTIVE" && (!ad.stopTime || ad.stopTime.getTime() > now);

    if (items.length === 0) {
      if (!ad.brand && (spentCents > 0 || liveNow)) {
        push("NO_OBJECT", ad.id, `«${ad.name}»: ${spentCents > 0 ? "тратит деньги" : "включено"}, а объекта нет`);
      }
    } else {
      if (ad.matchSource !== "MANUAL" && ad.assetCount > items.length) {
        push(
          "ASSETS_NOT_LINKED",
          ad.id,
          `«${ad.name}»: материалов ${ad.assetCount}, а объектов привязано ${items.length} — расход лежит не на всех объектах`
        );
      }
    }

    if (ad.status && REJECTED.has(ad.status)) {
      const fresh = !ad.createdTime || now - ad.createdTime.getTime() < REJECTED_FRESH_MS;
      if (spentCents > 0 || fresh) push("AD_REJECTED", ad.id, `«${ad.name}»: Meta отклонила объявление или нашла проблемы (${ad.status})`);
    }
  }

  // ── 3. Сверка с итогом кабинета Meta.
  let metaTotalTjs: number | null = null;
  if (metaConfigured && options.checkMeta !== false && credentials) {
    const meta = await loadMetaTotalTjs(credentials, range, money);
    metaTotalTjs = meta.total;
    if (meta.total == null) {
      push("STALE_SYNC", null, `${META_TOTAL_FAILED_TEXT} (${meta.error ?? "нет ответа"}): сверка расхода не проверена`);
    } else {
      const crm = fromCents(crmCents);
      const tolerance = Math.max((meta.total * MISMATCH_PCT) / 100, toTjs(MISMATCH_USD, "USD", money));
      if (Math.abs(crm - meta.total) > tolerance) {
        push(
          "SPEND_MISMATCH",
          null,
          `Расход в CRM ${crm.toFixed(2)} с., в кабинете Meta ${meta.total.toFixed(2)} с. за ${day(range.from)} — ${day(range.to)}: ` +
            `разница ${(crm - meta.total).toFixed(2)} с.`
        );
      }
    }
  }

  // ── 4. Давно ли сверялись.
  const settings = await prisma.settings.findUnique({
    where: { id: "singleton" },
    select: { metaAdsSyncedAt: true, metaAdsEnabled: true },
  });
  if (settings?.metaAdsEnabled && settings.metaAdsSyncedAt && now - settings.metaAdsSyncedAt.getTime() > STALE_AFTER_MS) {
    const hours = Math.round((now - settings.metaAdsSyncedAt.getTime()) / 3_600_000);
    push("STALE_SYNC", null, `Последняя синхронизация рекламы была ${hours} ч назад — цифры могли устареть`);
  }

  const crmTotalTjs = fromCents(crmCents);
  return {
    ok: issues.length === 0,
    checkedAt: new Date(now).toISOString(),
    from: day(range.from),
    to: day(range.to),
    crmTotalTjs,
    metaTotalTjs,
    diffPct:
      metaTotalTjs != null && metaTotalTjs > 0
        ? Math.round(((crmTotalTjs - metaTotalTjs) / metaTotalTjs) * 10000) / 100
        : null,
    issues,
  };
}

/** Сутки для сквозных проблем (разница с кабинетом, давность сверки), месяц — для привязок. */
const PER_AD_WINDOW_MS = 30 * 24 * 60 * 60 * 1000;
const ACCOUNT_WINDOW_MS = 24 * 60 * 60 * 1000;

/**
 * Пишет найденные проблемы в журнал ошибок — оттуда их берёт утренний отчёт
 * директору. ОДИН РАЗ на объявление и вид: ключ дедупликации стабильный, окно
 * длинное, пуш «Новая проблема» по объявлениям не шлём (silent) — на первой сверке
 * их может быть десятки, и будить ими директора нельзя. Сквозные (разница с
 * кабинетом, давность сверки) идут без silent: это первое, что директор хочет знать.
 * Исчезнувшие проблемы ничего не пишут.
 */
export async function logAdIssues(issues: AdIssue[]): Promise<void> {
  for (const issue of issues) {
    const perAd = issue.adId != null;
    // Отказ итога Meta (сеть, права) — тихо: одно моргание Graph не должно будить директора.
    // «Давно не сверялись» громко пишет крон (watchStaleSync), а не эта сверка после
    // УДАЧНОЙ синхронизации — внутри неё давность по построению нулевая.
    const metaTotalFailed = issue.kind === "STALE_SYNC" && issue.text.startsWith(META_TOTAL_FAILED_TEXT);
    await logSystemError("ads", `Реклама [${issue.kind}] ${issue.text}`, {
      dedupKey: `ads-issue:${issue.kind}:${issue.adId ?? (metaTotalFailed ? "meta-total" : "account")}`,
      dedupWindowMs: perAd ? PER_AD_WINDOW_MS : ACCOUNT_WINDOW_MS,
      silent: perAd || metaTotalFailed,
    });
  }
}

/**
 * Сторож «синхронизация давно не проходила» — зовёт КРОН (cron.ts), независимо от
 * синхронизации. Раньше проверка жила только внутри сверки, которая запускается после
 * УДАЧНОЙ синхронизации, то есть при сломанной синхронизации не срабатывала вовсе.
 * Тот же ключ дедупликации, что у общей сверки: одна запись на сутки. Возвращает true,
 * если пора бить тревогу. Никогда не бросает.
 */
export async function watchStaleSync(nowMs: number = Date.now()): Promise<boolean> {
  try {
    const settings = await prisma.settings.findUnique({
      where: { id: "singleton" },
      select: { metaAdsSyncedAt: true, metaAdsEnabled: true },
    });
    if (!settings?.metaAdsEnabled || !settings.metaAdsSyncedAt) return false;
    const age = nowMs - settings.metaAdsSyncedAt.getTime();
    if (age <= STALE_AFTER_MS) return false;
    const hours = Math.round(age / 3_600_000);
    await logAdIssues([
      { kind: "STALE_SYNC", adId: null, text: `Последняя синхронизация рекламы была ${hours} ч назад — цифры могли устареть` },
    ]);
    return true;
  } catch (err) {
    void logSystemError("ads", `Проверка давности синхронизации рекламы не выполнена: ${describeError(err)}`, {
      dedupKey: "ads-stale-watch-failed",
      dedupWindowMs: ACCOUNT_WINDOW_MS,
    });
    return false;
  }
}

/**
 * Сверка после синхронизации: период — те же дни, что только что перезалиты.
 * Никогда не бросает: сторож не имеет права сорвать синхронизацию, за которой
 * следит.
 */
export async function runReconcileAfterSync(
  credentials: MetaAdsCredentials,
  range: ReconcileRange
): Promise<AdIssue[]> {
  try {
    const report = await buildReconcileReport(range, { credentials });
    await logAdIssues(report.issues);
    return report.issues;
  } catch (err) {
    void logSystemError("ads", `Сверка рекламы не выполнена: ${describeError(err)}`);
    return [];
  }
}
