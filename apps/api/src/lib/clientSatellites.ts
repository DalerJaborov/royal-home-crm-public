import { prisma } from "../db.js";
import { cancelClientCallbackRequests } from "./callbackRequestsCancel.js";
import { logSystemError } from "./systemError.js";

/**
 * ТРЕБОВАНИЯ И ПРОСЬБЫ О ЗВОНКЕ ГАСНУТ ВМЕСТЕ С КАРТОЧКОЙ (27.08.2026, разведка 07.09).
 *
 * Вынесено в отдельный файл (07.09.2026): жила в `trashClient.ts`, но
 * `qualifyIncoming.ts` тоже нужна эта функция (ветка «не по делу»), а
 * `qualifyIncoming.ts` сам стоит в конце цепочки `callbackRequests.ts` →
 * `callbackConnect` → `callTracker` → `callRecordings` → `autoLeadFromCall` →
 * `qualifyIncoming` — импорт из `trashClient.ts` (который зовёт
 * `callbackRequests.ts`) замкнул бы цикл. `cancelClientCallbackRequests` по той
 * же причине живёт в своём файле `callbackRequestsCancel.ts`, а не в
 * `callbackRequests.ts` (см. его заголовок). Здесь зависимости — только листья,
 * цикла нет (поймано `depcruise` на CI: `no-circular`).
 *
 * Используется trashClient (прямое удаление, одобрение заявки), слиянием
 * дубликатов (routes/clients/duplicates.ts) и запасным путём «не по делу» при
 * звонке (lib/telephony/qualifyIncoming.ts). Все три раньше писали `deletedAt`
 * напрямую и не гасили ничего — тот же класс бага, что у незакрытых заявок на
 * удаление объекта.
 *
 * Best-effort и НЕ в общей транзакции с самим удалением НАРОЧНО — карточка
 * обязана уйти в Корзину, даже если гашение споткнётся, а выдача окон отсеивает
 * удалённых клиентов сама (routes/me.ts).
 *
 * PropertyCountDispute добавлена сюда ночной проверкой 24.09.2026: таблица
 * заведена 07.09.2026 (тем же днём, что и предыдущий разбор осиротевших
 * спутников) и в тот разбор не попала — заявка «оспорить число объектов»
 * вечно висела в очереди руководителя по клиенту, ушедшему в Корзину.
 */
export async function closeClientSatellites(
  clientId: string
): Promise<{ cancelledCallbacks: number; rejectedPropertyCountDisputes: number }> {
  /* Гашение требований-окон отсюда ушло вместе с самим механизмом
     (13.09.2026). Спутник, который нечему пережить родителя, гасить не нужно. */
  const cancelledCallbacks = await cancelClientCallbackRequests(clientId).catch((err) => {
    void logSystemError(
      "api",
      `Просьбы о звонке удалённого клиента не погашены (${clientId}): ${err instanceof Error ? err.message : err}`
    );
    return 0;
  });

  const rejectedPropertyCountDisputes = await prisma.propertyCountDispute
    .updateMany({
      where: { clientId, status: "PENDING" },
      data: {
        status: "REJECTED",
        decidedAt: new Date(),
        decisionNote: "Карточка удалена в Корзину",
      },
    })
    .then((r) => r.count)
    .catch((err) => {
      void logSystemError(
        "api",
        `Заявки на пересмотр числа объектов удалённого клиента не погашены (${clientId}): ${err instanceof Error ? err.message : err}`
      );
      return 0;
    });

  return { cancelledCallbacks, rejectedPropertyCountDisputes };
}
