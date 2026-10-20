/**
 * АННУЛИРОВАНИЕ ЗАКРЫТОЙ СДЕЛКИ (глубокая проверка 02.10.2026, C10; решение
 * владельца 02.10 «да, по советам»).
 *
 * Раньше «аннулировать» можно было только долями 0/0 на закрытой сделке
 * (PATCH /deals/:id, isVoidingClosedDeal): снимались баллы и пересчитывалась
 * зарплата, но стадия оставалась COMPLETED — и доска почёта, отчёты, главная,
 * утренние цифры, «Команда», KPI, «Финансы» продолжали считать её продажей, а
 * объект навсегда оставался «Продано».
 *
 * ОДНО ПРАВИЛО ДЛЯ ВСЕХ СЧЁТЧИКОВ: продажа — это сделка в стадии COMPLETED.
 * Его уже соблюдают все места, где сделка считается продажей (больше тридцати
 * файлов, каждый — `stage: "COMPLETED"`). Поэтому аннулированная сделка
 * переводится в CANCELLED и получает отметку annulledAt/annulledById/
 * annulReason: ни один счётчик не нужно учить новому условию, и новый
 * счётчик, написанный завтра по тому же правилу, тоже не ошибётся. Суммы и
 * closedAt остаются как история (старые поля не удаляются).
 *
 * Объект возвращается в продажу, как при отмене живой сделки: SOLD → AVAILABLE,
 * клиенты (покупатель и продавец) выходят из «Сделка закрыта». Баллы «Сделка
 * закрыта» (и надбавка за возвращённого клиента) снимаются тем же событием, что
 * и при обнулении долей, — reverseDealClosedScore ниже, одна функция на оба пути.
 *
 * Вернуть аннулированную сделку в работу нельзя (PATCH отвечает 409): если
 * сделка на деле состоялась, её заводят заново.
 */
import { prisma } from "../db.js";
import { loadEventPoints, recordScoreEvent } from "./scoreJournal.js";
import { logTimeline } from "./timeline.js";
import { upsertSalaryExpenses } from "./financeAutomation.js";
import { dushanbeWallClock } from "./dushanbeTime.js";
import { logSystemError } from "./systemError.js";
import { describeError } from "./describeError.js";
import { notifyWaitingBuyersOfNewProperty } from "./propertyMatchFilter.js";
import { syncPropertiesToSite } from "./siteSync.js";

export class DealAnnulError extends Error {
  constructor(
    readonly status: 404 | 409,
    message: string
  ) {
    super(message);
  }
}

/**
 * Снять баллы за закрытую сделку: «Сделка закрыта» и, если была, надбавку за
 * возвращённого клиента. Журнал только на дозапись — пишутся компенсирующие
 * события с тем же sourceId, что у оригинала, поэтому повтор (обнуление долей,
 * потом аннулирование той же сделки) второй раз баллы не спишет.
 */
export async function reverseDealClosedScore(params: {
  dealId: string;
  agentId: string;
  client: { fullName: string; lostAt: Date | null; lastAgentId: string | null } | null;
  initiatorId: string;
  reason: string;
  points?: Awaited<ReturnType<typeof loadEventPoints>>;
}): Promise<void> {
  const points = params.points ?? (await loadEventPoints());
  await recordScoreEvent({
    agentId: params.agentId,
    kind: "deal_closed_reversed",
    delta: points.deal_closed_reversed,
    reason: params.reason,
    initiatorId: params.initiatorId,
    sourceId: params.dealId,
  });
  const client = params.client;
  if (client?.lostAt && client.lastAgentId && client.lastAgentId !== params.agentId) {
    await recordScoreEvent({
      agentId: params.agentId,
      kind: "client_recovered_bonus_reversed",
      delta: points.client_recovered_bonus_reversed,
      reason: `Надбавка за возвращённого клиента отменена вместе со сделкой — ${client.fullName}`,
      initiatorId: params.initiatorId,
      sourceId: `client-recovered-${params.dealId}`,
    });
  }
}

export interface AnnulResult {
  deal: { id: string; agentId: string; clientId: string; propertyId: string; stage: string };
  clientName: string;
  propertyReturnedToSale: boolean;
}

export async function annulDeal(params: {
  dealId: string;
  actorId: string;
  reason: string;
  /** Видимость рядового сотрудника (scopeDealsToOwnAgent): чужую сделку не трогает. */
  ownAgentId?: string;
}): Promise<AnnulResult> {
  const existing = await prisma.deal.findUnique({
    where: { id: params.dealId },
    include: { client: { select: { fullName: true, lostAt: true, lastAgentId: true } } },
  });
  if (!existing || (params.ownAgentId && existing.agentId !== params.ownAgentId)) {
    throw new DealAnnulError(404, "Сделка не найдена");
  }
  if (existing.annulledAt) throw new DealAnnulError(409, "Сделка уже аннулирована");
  if (existing.stage !== "COMPLETED") {
    throw new DealAnnulError(409, "Аннулировать можно только закрытую сделку — незакрытую просто отмените");
  }

  let propertyReturnedToSale = false;
  const deal = await prisma.$transaction(async (tx) => {
    // Условие «всё ещё закрыта и не аннулирована» — в самой записи: два
    // одновременных нажатия дают одну аннулированную сделку и один ответ 409.
    const marked = await tx.deal.updateMany({
      where: { id: existing.id, stage: "COMPLETED", annulledAt: null },
      data: {
        stage: "CANCELLED",
        annulledAt: new Date(),
        annulledById: params.actorId,
        annulReason: params.reason,
        version: { increment: 1 },
      },
    });
    if (marked.count !== 1) throw new DealAnnulError(409, "Сделку только что изменили — обновите страницу");

    // Объект и клиенты — так же, как при отмене живой сделки (routes/deals.ts,
    // isCancelling): только если других живых или закрытых сделок по ним нет.
    const [otherPropertyDeals, otherClientDeals] = await Promise.all([
      tx.deal.count({ where: { propertyId: existing.propertyId, id: { not: existing.id }, stage: { not: "CANCELLED" } } }),
      tx.deal.count({ where: { clientId: existing.clientId, id: { not: existing.id }, stage: { not: "CANCELLED" } } }),
    ]);
    if (otherPropertyDeals === 0) {
      const property = await tx.property.findUnique({
        where: { id: existing.propertyId },
        select: { assignedAgentId: true, sellerClientId: true },
      });
      const released = await tx.property.updateMany({
        where: { id: existing.propertyId, status: "SOLD" },
        data: {
          status: "AVAILABLE",
          soldAt: null,
          soldPrice: null,
          stageEnteredAt: new Date(),
          // Риелтор сделки снимается, как при отмене: появится снова с новой сделкой.
          ...(property?.assignedAgentId === existing.agentId ? { assignedAgentId: null } : {}),
        },
      });
      propertyReturnedToSale = released.count === 1;
      if (property?.sellerClientId) {
        await tx.client.updateMany({
          where: { id: property.sellerClientId, status: "DEAL_CLOSED" },
          data: { status: "CONTACTED" },
        });
      }
    }
    if (otherClientDeals === 0) {
      await tx.client.updateMany({ where: { id: existing.clientId, status: "DEAL_CLOSED" }, data: { status: "HOT" } });
    }

    await logTimeline({
      clientId: existing.clientId,
      actor: { kind: "agent", agentId: params.actorId },
      propertyId: existing.propertyId,
      type: "SYSTEM",
      notes: `Сделка аннулирована: ${params.reason}`,
      tx,
    });
    return tx.deal.findUniqueOrThrow({ where: { id: existing.id } });
  });

  // ПОСЛЕ КОММИТА — баллы, зарплатная строка, сайт и подбор. Каждый шаг сам
  // гасит свою ошибку: сделка уже аннулирована, отказ шага пишется в журнал ошибок.
  await reverseDealClosedScore({
    dealId: existing.id,
    agentId: existing.agentId,
    client: existing.client,
    initiatorId: params.actorId,
    reason: `Сделка аннулирована: ${params.reason}`,
  });

  if (existing.closedAt) {
    const w = dushanbeWallClock(existing.closedAt);
    const closedMonthKey = `${w.getUTCFullYear()}-${String(w.getUTCMonth() + 1).padStart(2, "0")}`;
    try {
      await upsertSalaryExpenses(closedMonthKey);
    } catch (err) {
      void logSystemError("api", `Зарплатная строка после аннулирования сделки ${existing.id} не обновлена: ${describeError(err)}`);
    }
  }

  if (propertyReturnedToSale) {
    const property = await prisma.property.findUnique({
      where: { id: existing.propertyId },
      include: { district: true, photos: { orderBy: { order: "asc" } } },
    });
    if (property) {
      if (property.publishedOnSite) {
        void syncPropertiesToSite([property], "unsold")
          .then((result) => {
            const problem = !result.ok ? result.error : result.results.find((r) => !r.ok)?.error;
            if (problem) {
              void logSystemError("site-sync", `Объект ${property.id} после аннулирования сделки не вернулся на сайт: ${problem}`, {
                url: `/properties/${property.id}`,
              });
            }
          })
          .catch((err) =>
            void logSystemError("site-sync", `Объект ${property.id} после аннулирования сделки: ${describeError(err)}`, {
              url: `/properties/${property.id}`,
            })
          );
      }
      void notifyWaitingBuyersOfNewProperty(property).catch((err) =>
        console.error("[автоподбор] сделка аннулирована, объект вернулся в продажу:", describeError(err))
      );
    }
  }

  return {
    deal: { id: deal.id, agentId: deal.agentId, clientId: deal.clientId, propertyId: deal.propertyId, stage: deal.stage },
    clientName: existing.client?.fullName ?? "клиент",
    propertyReturnedToSale,
  };
}
