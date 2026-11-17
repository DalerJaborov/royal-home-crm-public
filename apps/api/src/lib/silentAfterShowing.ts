import { prisma } from "../db.js";
import { isConductedShowing } from "./conductedShowing.js";
import { canViewInvestigations } from "@royal-home/shared";

const agentRefSelect = { select: { id: true, fullName: true, avatarUrl: true } } as const;
async function loadSellerSilenceDays(): Promise<number> {
  const s = await prisma.settings.findUnique({ where: { id: "singleton" }, select: { sellerSilenceAfterShowingDays: true } });
  return s?.sellerSilenceAfterShowingDays ?? 7;
}


/**
 * Сигнал «Тишина после показа» (антифрод, мозговой штурм владельца 20-21.08.2026):
 * у клиента был проведённый показ (см. lib/conductedShowing.ts) больше
 * Settings.sellerSilenceAfterShowingDays дней назад, а после него — ни одного
 * НОВОГО касания через CRM (звонок/сообщение/показ), и карточка ещё не закрыта
 * (не LOST/DEAL_CLOSED/ARCHIVED).
 *
 * Приём: сперва сужаем клиентов по lastContactAt (дешёвый индексированный фильтр —
 * lastContactAt читает КАЖДЫЙ живой человеческий контакт, включая сам показ), а
 * затем одним запросом с `distinct` достаём ПОСЛЕДНЕЕ не-SYSTEM взаимодействие
 * каждого кандидата и проверяем, что это и есть показ, и что он проведён. Если
 * после показа было хоть одно новое человеческое действие — lastContactAt сдвинулся
 * бы вперёд, кандидат сюда вообще не попал бы.
 */
// Экспортирована для mission-control (routes/dashboardMissionControl.ts) — «первая
// линия» переиспользует тот же сигнал, второй копии логики не заводим.
export async function findSilentAfterShowing(now: Date, viewerRole?: string) {
  const days = await loadSellerSilenceDays();
  const cutoff = new Date(now.getTime() - days * 24 * 60 * 60 * 1000);

  const candidates = await prisma.client.findMany({
    where: {
      deletedAt: null,
      status: { notIn: ["LOST", "DEAL_CLOSED", "ARCHIVED"] },
      lastContactAt: { lt: cutoff },
    },
    orderBy: { lastContactAt: "asc" },
    take: 500,
    select: { id: true, shortId: true, fullName: true, workStatus: true, lastContactAt: true, assignedAgent: agentRefSelect },
  });
  if (candidates.length === 0) return { days, items: [] as typeof candidates };

  const lastTouches = await prisma.interaction.findMany({
    where: { clientId: { in: candidates.map((c) => c.id) }, type: { not: "SYSTEM" } },
    orderBy: [{ clientId: "asc" }, { createdAt: "desc" }],
    distinct: ["clientId"],
    select: { clientId: true, type: true, completedAt: true, nextActionDate: true, declinedAt: true, createdAt: true,
      taskCancelledAt: true, showingEvidenceVersion: true, propertyId: true, showingOffCrm: true, showingOffCrmDetails: true, investigationOnly: true },
    // Потолок — строки, а не id клиентов: distinct уже держит по одной строке на
    // клиента, но потолок здесь пишем явно (22.09.2026, класс «Пагинация»), чтобы
    // граница не зависела от того, что distinct не уберут при следующей правке.
    take: candidates.length,
  });
  const touchByClient = new Map(lastTouches.map((t) => [t.clientId, t]));

  const items = candidates.filter((c) => {
    const touch = touchByClient.get(c.id);
    if (!touch) return false;
    // Read the actual latest contact before checking visibility: hiding a later
    // private contact must not resurrect an older public showing as a new flag.
    if (viewerRole !== undefined && !canViewInvestigations(viewerRole) && touch.investigationOnly) return false;
    return isConductedShowing(touch, now);
  });
  return { days, items };
}


