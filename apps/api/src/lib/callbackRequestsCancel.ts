import { prisma } from "../db.js";

/**
 * Закрыть незакрытые просьбы о звонке по карточке, ушедшей в Корзину
 * (27.08.2026, тот же класс, что и cancelClientSummaries в pendingSummaries.ts).
 *
 * Без этого запрос продолжал висеть в баннере оператора — «клиент ждёт звонка»
 * по человеку, которого агентство уже удалило, — а автопрозвон (callbackConnect.ts)
 * рано или поздно до него дозвонился бы.
 *
 * В СВОЁМ файле, а не в callbackRequests.ts (07.09.2026): та зовёт
 * callbackConnect.ts → callTracker.ts → callRecordings.ts → autoLeadFromCall.ts →
 * qualifyIncoming.ts, а этой функции нужно быть доступной именно из
 * qualifyIncoming.ts (через clientSatellites.ts) — импорт из callbackRequests.ts
 * замкнул бы цикл (поймано `depcruise` на CI: `no-circular`). Здесь зависимость
 * ровно одна — prisma, лист без исходящих связей на телефонию.
 */
export async function cancelClientCallbackRequests(clientId: string): Promise<number> {
  const { count } = await prisma.callbackRequest.updateMany({
    // Managed resources have their own scoped lifecycle/revision contract.
    where: { clientId, doneAt: null, customerActionId: null },
    data: { doneAt: new Date() },
  });
  return count;
}
