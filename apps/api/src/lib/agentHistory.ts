import { prisma } from "../db.js";

/**
 * ЕСТЬ ЛИ У СОТРУДНИКА ИСТОРИЯ, КОТОРУЮ УДАЛЕНИЕ СТЁРЛО БЫ КАСКАДОМ
 * (находка №195, ночная проверка 24.09.2026).
 *
 * В схеме у этих таблиц `onDelete: Cascade` на сотрудника: удалишь строку —
 * база молча унесёт журнал входов, Royal Score, KPI, журнал ИИ-ассистента,
 * его заявки на удаление клиентов и объектов, споры о счёте, запросы
 * перемонтажа, черновики, разборы звонков и требования. Раньше «Удалить
 * сотрудника» без звонков и сделок (маркетолог, монтажёр, безопасник, админ)
 * стирал всё это и уходил без следа. Схему не меняем (это миграция), поэтому
 * маршрут удаления спрашивает здесь заранее и при любой записи идёт той же
 * веткой, что и при сделках: учётка отключается, телефон освобождается, история
 * остаётся.
 *
 * Не входят: Session, PushSubscription, Notification, PushActionToken, Passkey,
 * LoginSmsCode — это состояние устройств, а не история. И AgentHandoverBatch:
 * снимок раздачи создаёт сам маршрут удаления прямо перед проверкой, а после
 * удаления учётки «вернуть как было» всё равно некому.
 *
 * Новая таблица с `onDelete: Cascade` на сотрудника — дописать сюда.
 */
export async function agentHasCascadeHistory(agentId: string): Promise<boolean> {
  const byAgent = { where: { agentId }, select: { id: true } } as const;
  const byAuthor = { where: { requestedById: agentId }, select: { id: true } } as const;
  const found = await Promise.all([
    prisma.loginLog.findFirst(byAgent),
    prisma.royalScoreEvent.findFirst(byAgent),
    prisma.kpiDailyScore.findFirst(byAgent),
    prisma.aiAssistantAuditLog.findFirst(byAgent),
    prisma.callAnalysis.findFirst(byAgent),
    prisma.cardSuggestion.findFirst(byAgent),
    prisma.propertyDraft.findFirst(byAgent),
    prisma.pendingSummary.findFirst(byAgent),
    prisma.clientDeleteRequest.findFirst(byAuthor),
    prisma.propertyDeleteRequest.findFirst(byAuthor),
    prisma.propertyCountDispute.findFirst(byAuthor),
    prisma.videoRemakeRequest.findFirst(byAuthor),
  ]);
  return found.some((row) => row !== null);
}
