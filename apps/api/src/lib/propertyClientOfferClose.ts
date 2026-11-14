/**
 * Спутник смены владельца клиента (lib/ownershipSatellites.ts): открытые
 * предложения объектов (lib/propertyClientOffers.ts) прежнему агенту
 * закрываются — отвечать на них ему больше не за кого. Отдельный модуль без
 * подбора и прав, чтобы спутники не тянули за собой цепочку импортов подбора.
 */
import { prisma } from "../db.js";

export async function closePropertyClientOffersOnTransfer(clientId: string, toAgentId: string | null): Promise<void> {
  await prisma.propertyClientOffer.updateMany({
    where: { clientId, status: { in: ["PENDING", "SENT"] }, ...(toAgentId ? { NOT: { toAgentId } } : {}) },
    data: { status: "CLOSED" },
  });
}
