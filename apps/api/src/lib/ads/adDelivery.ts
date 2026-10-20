import { prisma } from "../../db.js";

/**
 * ИДЁТ ЛИ ОБЪЯВЛЕНИЕ НА САМОМ ДЕЛЕ.
 *
 * Meta отдаёт `effective_status`, и CRM показывала его дословно: ACTIVE →
 * «Идёт сейчас». На живых данных агентства 03.09.2026 это оказалось враньём в
 * четырёх случаях из пяти: 33 объявления из 41 числились ACTIVE, а деньги
 * тратили только шесть. Остальные закончились в апреле, мае и июле — у них
 * вышел срок показа группы (`stopTime` в прошлом), и Ads Manager рисует таким
 * «Завершено», но САМ СТАТУС при этом навсегда остаётся ACTIVE: Meta считает
 * объявление включённым, просто показывать его больше некогда.
 *
 * Поэтому состояние считаем сами, и главный довод — не статус, а ФАКТ ТРАТЫ:
 * объявление, которое сегодня или вчера списало деньги, идёт, что бы ни было
 * записано в расписании; объявление, не потратившее ничего неделю, не идёт,
 * какой бы статус Meta ни присылала.
 *
 * `asOf` — момент, НА КОТОРЫЙ мы судим, и это последняя сверка с кабинетом, а
 * не «сейчас». Иначе оборванная синхронизация (протухший маркер, недоступная
 * Meta) через сутки объявила бы всю рекламу остановленной, хотя мы про неё
 * просто ничего не знаем.
 */
export type AdDelivery =
  /** Тратит деньги прямо сейчас. */
  | "RUNNING"
  /** Включено, но денег не тратит — кончился бюджет, аудитория, модерация. */
  | "STALLED"
  /** Срок показа вышел: в Ads Manager это «Завершено». */
  | "FINISHED"
  /** Выключено руками — само объявление, группа или кампания. */
  | "PAUSED"
  /** На проверке у Meta или ждёт оплату — показов ещё не было. */
  | "REVIEW"
  /** Отклонено модерацией. */
  | "REJECTED"
  /** Запущено, но не потратило ни цента ни разу. */
  | "NEVER";

/** Выключенные руками — на любом из трёх уровней. */
const OFF = new Set(["PAUSED", "ADSET_PAUSED", "CAMPAIGN_PAUSED", "DELETED", "ARCHIVED"]);
const REVIEW = new Set(["PENDING_REVIEW", "PREAPPROVED", "PENDING_BILLING_INFO", "IN_PROCESS"]);
const REJECTED = new Set(["DISAPPROVED", "WITH_ISSUES", "ADSET_DISAPPROVED", "CAMPAIGN_DISAPPROVED"]);

/** Сколько суток без трат ещё считаются «идёт»: Meta досчитывает вчерашний день. */
const FRESH_DAYS = 1;

function dayStart(d: Date): number {
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
}

export interface AdDeliveryInput {
  /** effective_status, каким его прислала Meta. null у ручных объявлений. */
  status: string | null;
  /** Конец срока показа группы объявлений. */
  stopTime: Date | null;
  /** Последний день, за который объявление списало деньги. */
  lastSpendAt: Date | null;
  /** Момент последней сверки с кабинетом (или «сейчас», если сверок не было). */
  asOf: Date;
}

export function adDelivery({ status, stopTime, lastSpendAt, asOf }: AdDeliveryInput): AdDelivery {
  const spentRecently =
    lastSpendAt != null && (dayStart(asOf) - dayStart(lastSpendAt)) / 86_400_000 <= FRESH_DAYS;

  // Факт списания сильнее РАСПИСАНИЯ: если деньги ушли сегодня, объявление идёт,
  // даже когда срок показа по нашим данным вышел (в кабинете его продлили, а до
  // нас это доедет следующей сверкой).
  //
  // Но не сильнее ВЕРДИКТА. Выключенное руками и отклонённое модерацией сегодня
  // ещё могло потратить деньги утром — и всё же показывать «Идёт» на нём нельзя:
  // человеку важно, что оно уже не работает и почему.
  if (status && REJECTED.has(status)) return "REJECTED";
  if (status && OFF.has(status)) return "PAUSED";
  if (spentRecently) return "RUNNING";

  if (status && REVIEW.has(status)) return "REVIEW";

  if (stopTime && stopTime.getTime() <= asOf.getTime()) return "FINISHED";
  if (!lastSpendAt) return "NEVER";
  return "STALLED";
}

/** Идёт ли объявление — одним словом, для мест, где нужен только «да/нет». */
export function isDelivering(input: AdDeliveryInput): boolean {
  return adDelivery(input) === "RUNNING";
}

/**
 * Момент, на который судим о состоянии рекламы: последняя удачная сверка с
 * кабинетом. Её же видит человек в шапке раздела («сверено 3 сент., 17:05»).
 */
export async function deliveryAsOf(): Promise<Date> {
  const settings = await prisma.settings.findUnique({
    where: { id: "singleton" },
    select: { metaAdsSyncedAt: true },
  });
  return settings?.metaAdsSyncedAt ?? new Date();
}

/**
 * Последний день с тратами по каждому объявлению — одним запросом на всех.
 * Дни с нулевым расходом Meta присылает и для стоящих объявлений, поэтому
 * считаем только те, где деньги действительно ушли.
 */
export async function lastSpendByAd(adIds?: string[]): Promise<Map<string, Date>> {
  const rows = await prisma.adSpendDaily.groupBy({
    by: ["adId"],
    where: { spend: { gt: 0 }, ...(adIds ? { adId: { in: adIds } } : {}) },
    _max: { date: true },
  });
  const map = new Map<string, Date>();
  for (const r of rows) if (r._max.date) map.set(r.adId, r._max.date);
  return map;
}

/** Сколько объявлений в каком состоянии — для ИИ-разбора и сводок. */
export async function deliveryCounts(): Promise<Record<AdDelivery, number>> {
  const [ads, lastSpend, asOf] = await Promise.all([
    prisma.ad.findMany({ where: { excluded: false }, select: { id: true, status: true, stopTime: true } }),
    lastSpendByAd(),
    deliveryAsOf(),
  ]);
  const counts: Record<AdDelivery, number> = {
    RUNNING: 0,
    STALLED: 0,
    FINISHED: 0,
    PAUSED: 0,
    REVIEW: 0,
    REJECTED: 0,
    NEVER: 0,
  };
  for (const ad of ads) {
    counts[adDelivery({ status: ad.status, stopTime: ad.stopTime, lastSpendAt: lastSpend.get(ad.id) ?? null, asOf })]++;
  }
  return counts;
}
