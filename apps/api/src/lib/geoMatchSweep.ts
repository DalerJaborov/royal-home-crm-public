/**
 * НОЧНОЙ ПРОХОД ГЕО-ПОДБОРА (12.09.2026, docs/geo-match-plan-12-09.md блок E) —
 * СТРАХОВКА, а не основной механизм (план, раздел 1 п.4: «событие при появлении
 * объекта — основной механизм, ночной проход — страховка»). Событийный путь
 * (notifyWaitingBuyersOfNewProperty вызывается из pipeline/dealReservation/deals/
 * crud) ловит момент, когда объект появился или подешевел, но не ловит момент,
 * когда КЛИЕНТ обзавёлся новым желаемым местом уже ПОСЛЕ того, как подходящий
 * объект встал в продажу, — без ночного прохода такое совпадение не нашли бы
 * никогда.
 *
 * ПЕРЕИСПОЛЬЗУЕТ notifyWaitingBuyersOfNewProperty ЦЕЛИКОМ, а не пишет вторую
 * версию фильтра (D4): дедуп через Interaction-маркер «Автоподбор:» уже не даёт
 * повторно уведомлять того, кто это видел, так что ежедневный повторный вызов
 * для КАЖДОГО AVAILABLE объекта безопасен и делает ровно то же самое, что этот
 * же объект получил бы, появившись только что.
 */
import { prisma } from "../db.js";
import { dushanbeDayKey } from "./aiDailyBudget.js";
import { enqueueBackgroundJob } from "../jobs/enqueue.js";
import { logSystemError } from "./systemError.js";

/** Потолок объектов за один ночной проход — safety valve, не рабочий предел:
 *  в проде 12.09.2026 живых объектов 17, тысяча — запас на годы роста. */
const MAX_PROPERTIES_PER_SWEEP = 1000;

export interface GeoMatchSweepResult {
  candidates: number;
  enqueued: number;
}

/**
 * Тик, вызываемый кроном в 08:05 по Душанбе (после тихих часов — см. cron.ts).
 * Тяжёлую часть (сам подбор) не делает сам — только читает список AVAILABLE
 * объектов и ставит по одному заданию в очередь BackgroundJob на каждый, с
 * dedupeKey на сутки: повторный тик того же дня (ретрай крона, ручной перезапуск)
 * не заводит дублей.
 */
/** Сколько заданий ставим в очередь одновременно — балансирует скорость постановки
 *  (18.09.2026, docs/match-geo-analysis-18-09.md п.4.6: раньше строго
 *  последовательно, до 1000 round-trip'ов подряд) и нагрузку на пул соединений. */
const ENQUEUE_CONCURRENCY = 25;

export async function runNightlyGeoMatchSweepTick(now: Date = new Date()): Promise<GeoMatchSweepResult> {
  const dayKey = dushanbeDayKey(now);
  const properties = await prisma.property.findMany({
    where: { status: "AVAILABLE", deletedAt: null },
    // orderBy + предупреждение о срезе (18.09.2026, п.4.5) — раньше `take` без
    // сортировки: при росте портфеля выше MAX_PROPERTIES_PER_SWEEP часть объектов
    // молча выпадала бы из ночной страховки навсегда, без единого следа в логах.
    orderBy: { id: "asc" },
    select: { id: true },
    take: MAX_PROPERTIES_PER_SWEEP,
  });
  if (properties.length === MAX_PROPERTIES_PER_SWEEP) {
    void logSystemError(
      "matching",
      `Ночной геоподбор: объектов AVAILABLE ≥ ${MAX_PROPERTIES_PER_SWEEP}, список за эту ночь обрезан лимитом`
    );
  }

  let enqueued = 0;
  for (let i = 0; i < properties.length; i += ENQUEUE_CONCURRENCY) {
    const chunk = properties.slice(i, i + ENQUEUE_CONCURRENCY);
    const results = await Promise.all(
      chunk.map((property) =>
        enqueueBackgroundJob({
          type: "geo-match-sweep",
          payload: { propertyId: property.id, dayKey },
          maxAttempts: 5,
          dedupeKey: `geo-match-sweep:${dayKey}:${property.id}`,
        })
      )
    );
    enqueued += results.filter((r) => r.enqueued).length;
  }
  return { candidates: properties.length, enqueued };
}
