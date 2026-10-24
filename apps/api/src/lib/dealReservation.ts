/**
 * Резерв объекта (Путь покупателя). Решение владельца 30.07.2026 — «резерв
 * только на сделке» (docs/lead-lifecycle-plan.md §5.1) — ОТМЕНЕНО уточнением
 * 13.08.2026 ночью: объект теперь встаёт в PropertyStatus.RESERVED раньше,
 * при выборе ветки «Договор» в «Итоге показа» (routes/me.ts::completeMeetingSummary),
 * не дожидаясь оформления Deal. Создание самой сделки (routes/deals.ts) принимает
 * уже свою раннюю бронь и переставляет reservedAt на момент оформления. Срок —
 * N РАБОЧИХ дней (Settings.dealReservationBusinessDays, суббота/воскресенье не
 * считаются, по умолчанию 3 — как в исходном ТЗ), после чего, если сделка ещё не
 * закрыта и не отменена, объект автоматически возвращается в продажу — иначе
 * объект, с которым просто перестали работать, висел бы заблокированным бессрочно.
 */

import { prisma } from "../db.js";
import { reportCronRowError } from "./cronHeartbeat.js";
import { addBusinessDays } from "./businessDays.js";
import { sendPushToAgent } from "../push.js";
import { notifyWaitingBuyersOfNewProperty } from "./propertyMatchFilter.js";
import { enqueueDirectorAlert } from "./directorAlertQueue.js";
import { logSystemAudit } from "./audit.js";
import { logTimeline } from "./timeline.js";
import { shouldAlert } from "./notifications.js";

async function loadReservationSettings(): Promise<{ days: number; expiryAction: "cancel" | "keep" }> {
  const s = await prisma.settings.findUnique({
    where: { id: "singleton" },
    select: { dealReservationBusinessDays: true, dealReservationExpiryAction: true },
  });
  return {
    days: s?.dealReservationBusinessDays ?? 3,
    expiryAction: s?.dealReservationExpiryAction === "keep" ? "keep" : "cancel",
  };
}

/**
 * ВОЗВРАТ ОДНОГО ОБЪЕКТА В ПРОДАЖУ — ОБЪЕКТ И СДЕЛКА В ОДНОЙ ТРАНЗАКЦИИ
 * (атомарность восстановлена 22.09.2026).
 *
 * БАГ, закрытый Пачкой 8 (11.09.2026, docs/flow-audit-deal-11-09.md, «БАГ»№1):
 * объект возвращался в AVAILABLE, а сделка по нему не трогалась вовсе — висела
 * открытой по уже свободному объекту, и если объект уходил в другую сделку,
 * первую закрыть было нельзя (409 «объект уже в другой активной сделке» на
 * POST /deals).
 *
 * Та правка починила логику, но оставила две записи В РАЗНЫХ транзакциях: объект
 * освобождался своим `updateMany`, сделка закрывалась своей транзакцией следом.
 * Перезапуск процесса между ними (а крон резерва идёт раз в час и переживает
 * выкаты) давал ровно то же состояние, что и исходный баг, только теперь его
 * никакой повторный проход не чинит: объект уже НЕ в RESERVED, значит следующий
 * тик его не найдёт, а сделка так и останется висеть. Теперь обе записи в одной
 * транзакции — либо объект свободен и сделка закрыта, либо не изменилось ничего.
 *
 * Settings.dealReservationExpiryAction: "cancel" (по умолчанию) переводит сделку
 * в CANCELLED с записью в ленту; "keep" оставляет сделку как есть, только
 * помечает reservationExpiredAt для канбана.
 *
 * Уведомления (пуш агенту, аларм руководству, автоподбор) в транзакцию НЕ
 * заходят намеренно — это внешние вызовы, им место после коммита.
 *
 * Возвращает отменённую сделку, если она была, или null; сам факт возврата
 * объекта — во втором поле, потому что объект мог уйти из RESERVED между
 * выборкой и этим моментом (нормальная гонка, не ошибка).
 */
/** Стадии, на которых таймер резерва сделку не отменяет (C1). */
const HELD_STAGES = ["PENDING_APPROVAL", "CONTRACT_SIGNED"] as const;
type HeldStage = (typeof HELD_STAGES)[number];

/** Напоминание руководству о такой сделке — не чаще раза в сутки (решение владельца 02.10). */
const HELD_REMINDER_INTERVAL_MS = 24 * 3600_000;

async function releaseOneReservation(
  property: { id: string; shortId: number | string; title: string; reservedAt: Date | null },
  expiryAction: "cancel" | "keep"
): Promise<{
  released: boolean;
  cancelledDeal: { id: string; agentId: string } | null;
  /** Сделка ждёт одобрения или договор уже подписан — объект не тронут, руководству напоминание. */
  heldDeal: { id: string; agentId: string; stage: HeldStage } | null;
}> {
  return prisma.$transaction(async (tx) => {
    // The scan can be stale by the time this transaction starts: another request
    // may have renewed the reservation. Lock and match that exact reservation
    // before either releasing it or marking a held deal as expired.
    const currentReservation = await tx.$queryRaw<Array<{ id: string }>>`
      SELECT "id" FROM "Property"
      WHERE "id" = ${property.id} AND "status" = 'RESERVED'
        AND "reservedAt" = ${property.reservedAt} AND "deletedAt" IS NULL
      FOR UPDATE
    `;
    if (currentReservation.length === 0) return { released: false, cancelledDeal: null, heldDeal: null };
    // СДЕЛКА ЖДЁТ ОДОБРЕНИЯ ИЛИ ДОГОВОР ПОДПИСАН — НЕ ОТМЕНЯЕМ (глубокая проверка
    // 02.10.2026, C1; «Договор подписан» — решение владельца 02.10 «да, по советам»).
    // Агент всё сдал (документы, цена, доли) или договор с покупателем уже
    // подписан; срок резерва считается от создания сделки, и директор в отъезде
    // на три дня раньше получал отменённую сделку и объект снова на сайте.
    // Объект остаётся в резерве, руководству — напоминание не чаще раза в сутки
    // на сделку (shouldAlert в releaseExpiredReservations). reservationExpiredAt
    // ставится один раз — отметка «резерв истёк» для канбана.
    const held = await tx.deal.findFirst({
      where: { propertyId: property.id, stage: { in: [...HELD_STAGES] } },
      select: { id: true, agentId: true, stage: true },
    });
    if (held) {
      await tx.deal.updateMany({
        where: { id: held.id, reservationExpiredAt: null },
        data: { reservationExpiredAt: new Date() },
      });
      return { released: false, cancelledDeal: null, heldDeal: { ...held, stage: held.stage as HeldStage } };
    }

    // Строго по условию RESERVED внутри одного апдейта — если объект успел
    // перейти в SOLD/CANCELLED-возврат между выборкой и этим моментом, тихо
    // пропускаем: count будет 0, и это не ошибка, а нормальная гонка.
    const updated = await tx.property.updateMany({
      where: { id: property.id, status: "RESERVED" },
      data: { status: "AVAILABLE", reservedAt: null, assignedAgentId: null, reservedForClientId: null },
    });
    if (updated.count !== 1) return { released: false, cancelledDeal: null, heldDeal: null };

    const liveDeal = await tx.deal.findFirst({
      where: { propertyId: property.id, stage: { notIn: ["COMPLETED", "CANCELLED"] } },
      select: { id: true, agentId: true, clientId: true },
    });
    if (!liveDeal) return { released: true, cancelledDeal: null, heldDeal: null };

    if (expiryAction === "keep") {
      await tx.deal.update({ where: { id: liveDeal.id }, data: { reservationExpiredAt: new Date() } });
      return { released: true, cancelledDeal: null, heldDeal: null };
    }

    await tx.deal.update({
      where: { id: liveDeal.id },
      data: { stage: "CANCELLED", reservationExpiredAt: new Date() },
    });
    await logTimeline({
      clientId: liveDeal.clientId,
      actor: { kind: "system", source: "dealReservation", subjectAgentId: liveDeal.agentId },
      propertyId: property.id,
      type: "SYSTEM",
      notes: "Резерв истёк, объект возвращён в продажу — сделка автоматически отменена",
      tx,
    });
    return { released: true, cancelledDeal: { id: liveDeal.id, agentId: liveDeal.agentId }, heldDeal: null };
  });
}

/**
 * Напоминание руководству: резерв истёк, а сделка ждёт одобрения или договор
 * подписан. Тик раз в час, объект остаётся в резерве — значит повод есть на
 * каждом тике; shouldAlert пропускает не чаще раза в сутки на сделку.
 */
async function remindHeldDeal(
  property: { shortId: number | string; title: string },
  deal: { id: string; stage: HeldStage },
  now: Date
): Promise<void> {
  const tag = `reservation-expired-held-${deal.id}`;
  if (!(await shouldAlert(tag, HELD_REMINDER_INTERVAL_MS, now))) return;
  if (deal.stage === "PENDING_APPROVAL") {
    await enqueueDirectorAlert({
      title: "⏳ Резерв истёк — сделка ждёт одобрения",
      body: `№${property.shortId} — ${property.title}: срок резерва прошёл, но агент уже отправил сделку на закрытие. Объект держим в резерве — одобрите или верните на доработку.`,
      url: "/deals",
      tag,
      recipientPermission: "deals.complete",
    });
    return;
  }
  await enqueueDirectorAlert({
    title: "⏳ Резерв истёк — договор подписан",
    body: `№${property.shortId} — ${property.title}: срок резерва прошёл, договор уже подписан, а сделка не отправлена на закрытие. Объект держим в резерве — узнайте у агента, что мешает.`,
    url: "/deals",
    tag,
    recipientPermission: "clients.assign",
  });
}

/** Уведомления об ОТМЕНЁННОЙ сделке — только после коммита транзакции выше. */
function notifyDealCancelled(
  property: { id: string; shortId: number | string; title: string },
  deal: { id: string; agentId: string }
): void {
  logSystemAudit("DEAL_CANCEL", "Deal", deal.id, { reason: "reservation-expired", propertyId: property.id });

  void sendPushToAgent(deal.agentId, {
    title: "❌ Сделка отменена — резерв истёк",
    body: `«${property.title}»: объект вернулся в продажу, сделка автоматически отменена`,
    url: "/deals",
    tag: `deal-reservation-expired-${deal.id}`,
  }).catch(() => {});
  void enqueueDirectorAlert({
    title: "❌ Сделка отменена — резерв истёк",
    body: `№${property.shortId} — ${property.title}: сделка отменена автоматически, резерв истёк`,
    url: `/properties/${property.shortId}`,
    tag: `deal-reservation-expired-supervisors-${deal.id}`,
    recipientPermission: "clients.assign",
  });
}

/**
 * Вызывается кроном раз в час (тот же тик, что requirePropertySummaries).
 * Идемпотентно: как только объект уходит из RESERVED, повторный проход его
 * больше не находит — отдельного флага "уже уведомили" не нужно.
 */
export async function releaseExpiredReservations(now: Date = new Date()): Promise<number> {
  const { days, expiryAction } = await loadReservationSettings();

  const candidates = await prisma.property.findMany({
    where: { status: "RESERVED", reservedAt: { not: null }, deletedAt: null },
    // districtId/type/rooms/price/currency — не для самого возврата в продажу, а
    // для автоподбора ниже (notifyWaitingBuyersOfNewProperty): объект реально вернулся
    // в AVAILABLE, значит те же ждущие покупатели, что и для нового объекта, снова
    // должны его увидеть (docs/auto-match-alert-plan-31-08-2026.md).
    select: {
      id: true,
      shortId: true,
      title: true,
      reservedAt: true,
      assignedAgentId: true,
      districtId: true,
      type: true,
      rooms: true,
      price: true,
      currency: true,
      // Площадь и этаж — такие же условия подбора, как район и цена (владелец
      // 09.09.2026). Поле, не попавшее в select, фильтр молча не проверяет.
      areaSqm: true,
      floor: true,
      totalFloors: true,
    },
    // Самые давние резервы первыми и с пределом выборки (№173 ночной проверки
    // 24.09): тик раз в час, остаток разберёт следующий проход.
    orderBy: { reservedAt: "asc" },
    take: 500,
  });
  const expired = candidates.filter((p) => addBusinessDays(p.reservedAt!, days) <= now);
  if (expired.length === 0) return 0;

  let released = 0;
  for (const property of expired) {
    try {
      // Объект и сделка по нему — одной транзакцией (см. releaseOneReservation).
      const { released: ok, cancelledDeal, heldDeal } = await releaseOneReservation(property, expiryAction);
      if (heldDeal) await remindHeldDeal(property, heldDeal, now);
      if (!ok) continue;
      released++;
      if (cancelledDeal) notifyDealCancelled(property, cancelledDeal);

      if (property.assignedAgentId) {
        void sendPushToAgent(property.assignedAgentId, {
          title: "🏠 Резерв объекта истёк",
          body: `«${property.title}» вернулся в продажу — сделка не закрыта за отведённый срок`,
          url: `/properties/${property.shortId}`,
          tag: `reservation-expired-${property.id}`,
        }).catch(() => {});
      }
      // Часы алармов (владелец 07.09.2026): объект уже вернулся в продажу
      // (updateMany выше) — откладывается только уведомление руководству,
      // агент своё уже получил мгновенно (это его объект).
      void enqueueDirectorAlert({
        title: "🏠 Резерв объекта истёк",
        body: `№${property.shortId} — ${property.title}: вернулся в продажу`,
        url: `/properties/${property.shortId}`,
        tag: `reservation-expired-supervisors-${property.id}`,
        recipientPermission: "clients.assign",
      });
      void notifyWaitingBuyersOfNewProperty(property).catch((err) =>
        console.error("[автоподбор] резерв истёк, объект вернулся в продажу:", err instanceof Error ? err.message : err)
      );
    } catch (err) {
      // Сбой одной записи не обрывает тик для остальных (№173 ночной проверки 24.09).
      reportCronRowError("Истёкший резерв объекта", property.shortId, err);
    }
  }
  return released;
}
