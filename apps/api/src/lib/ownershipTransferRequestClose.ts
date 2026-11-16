import { prisma } from "../db.js";
import { publish } from "./eventBus.js";

/**
 * СПУТНИК СМЕНЫ ХОЗЯИНА: ЖДУЩИЙ ЗАПРОС ПЕРЕДАЧИ ЗАКРЫВАЕТСЯ (ревью 16.11.2026).
 *
 * Если у объекта или клиента хозяин сменился другим путём (директор передал напрямую,
 * «Передача дел» при увольнении, автопереназначение, переезд продавца вместе с объектом),
 * запрос, ждущий ответа прежнего хозяина, больше не имеет смысла: окно висело бы у человека,
 * у которого карточки уже нет. Зовётся из единых точек записи хозяина
 * (`transferPropertyToAgent`, `closeOwnershipSatellites`). Не использует lib/ownershipTransferRequest.ts
 * (там импорт changeClientAgent — получился бы цикл). Best-effort: передачу не роняет.
 */
export async function closeTransferRequestsForTarget(
  target: { propertyId: string } | { clientId: string },
  newOwnerId: string | null
): Promise<number> {
  try {
    const where = {
      status: "PENDING" as const,
      ...("propertyId" in target ? { propertyId: target.propertyId } : { clientId: target.clientId }),
    };
    // Запрос, чей «прежний хозяин» уже и есть текущий хозяин, остаётся: хозяин не менялся.
    const rows = await prisma.ownershipTransferRequest.findMany({
      where: { ...where, ...(newOwnerId ? { fromAgentId: { not: newOwnerId } } : {}) },
      select: { id: true, fromAgentId: true, requestedById: true, toAgentId: true },
    });
    if (rows.length === 0) return 0;
    const res = await prisma.ownershipTransferRequest.updateMany({
      where: { id: { in: rows.map((r) => r.id) }, status: "PENDING" },
      data: { status: "EXPIRED", resultNote: "Хозяин карточки сменился, запрос больше не нужен" },
    });
    for (const row of rows) {
      void Promise.resolve(
        publish({
          type: "transfer.pending",
          payload: { requestId: row.id },
          agentIds: [...new Set([row.fromAgentId, row.requestedById, row.toAgentId])],
        })
      ).catch(() => {});
    }
    return res.count;
  } catch (err) {
    console.error("[transfer-request] не закрыт запрос при смене хозяина:", err);
    return 0;
  }
}
