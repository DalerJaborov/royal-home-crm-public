import { z } from "zod";
import { prisma } from "../db.js";
import { logSystemError } from "../lib/systemError.js";
import { syncPropertiesToSite } from "../lib/siteSync.js";
import { notifySellerSideOfSale } from "../lib/sellerSaleNotice.js";
import { isDealStillClosed } from "../lib/dealStillClosed.js";
import type { JobHandler } from "./registry.js";

/**
 * ПОСТ-КОММИТ ЗАКРЫТИЯ СДЕЛКИ (Пачка 8, 11.09.2026, docs/flow-audit-deal-11-09.md п.3).
 *
 * Раньше три шага после закрытия сделки (снятие с сайта и уведомление стороны
 * продавца) были fire-and-forget в routes/deals.ts:
 * при падении процесса между commit транзакции и этими вызовами ни один из
 * них не повторялся — сайт продолжал висеть с проданной квартирой, продавец
 * оставался неуведомлённым, «Итог объекта» не гасился. Теперь это одно
 * задание очереди — ретраится сам, если упало посередине.
 *
 * Идемпотентно: notifySellerSideOfSale не повторяет уже записанную продажу
 * (JOB-04); перед шагами проверяется, что сделка всё ещё закрыта (JOB-01);
 * syncPropertiesToSite — upsert полного снимка объекта на сайте, повтор
 * отправляет то же самое. Безопасно исполнить дважды.
 */
const schema = z.object({
  dealId: z.string(),
  propertyId: z.string(),
  closedById: z.string(),
  buyerName: z.string().nullable(),
});

export const dealCloseFollowupJob: JobHandler<z.infer<typeof schema>> = {
  type: "deal-close-followup",
  schema,
  // Три относительно быстрых шага (своя БД + один внешний вызов к сайту на
  // том же VPS) — короткая лесенка хватает: 1м → 2м → 4м → 8м.
  backoff: (attempt) => Math.min(2 ** attempt, 8) * 60_000,
  async run(payload) {
    // Родитель жив? Сделку могли аннулировать между постановкой/упавшей попыткой
    // и этим запуском: тогда объект уже вернулся в продажу, и «sold» на сайт или
    // запись «продан» в хронологию продавца были бы ложью (JOB-01).
    const deal = await prisma.deal.findUnique({
      where: { id: payload.dealId },
      select: { stage: true, annulledAt: true, property: { select: { status: true } } },
    });
    if (!deal || !isDealStillClosed(deal) || deal.property.status !== "SOLD") return;

    await notifySellerSideOfSale({
      propertyId: payload.propertyId,
      closedById: payload.closedById,
      buyerName: payload.buyerName,
    });

    const property = await prisma.property.findUnique({
      where: { id: payload.propertyId },
      include: { district: true, photos: true },
    });
    if (!property?.publishedOnSite) return;
    const result = await syncPropertiesToSite([property], "sold");
    const problem = !result.ok ? result.error : result.results.find((r) => !r.ok)?.error;
    if (!problem) return;
    // Отказ сайта — не программная ошибка (сайт может быть временно недоступен),
    // но именно он должен вызвать повтор: бросаем, чтобы задание получило
    // следующую попытку по backoff, а не тихо считалось выполненным.
    throw new Error(`Проданный объект ${payload.propertyId} не снят с сайта: ${problem}`);
  },
  async onGiveUp(payload) {
    await logSystemError(
      "site-sync",
      `Пост-закрытие сделки (${payload.dealId}) не выполнено после всех попыток — объект ${payload.propertyId} мог остаться на сайте, продавец мог остаться неуведомлённым`,
      { dedupKey: "Пост-закрытие сделки (…) не выполнено после всех попыток — объект … мог остаться на сайте, продавец мог остать…", url: "/deals" }
    );
  },
};
