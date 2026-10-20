import { prisma } from "../db.js";
import { changeClientAgent } from "./changeClientAgent.js";
import { transferPropertyToAgent, type TransferPropertyInput, type TransferPropertyResult } from "./propertyHandover.js";

/**
 * ПЕРЕДАЧА ОБЪЕКТА ВМЕСТЕ С ЕГО ПРОДАВЦОМ — вход для людей и для раздачи дел.
 *
 * Почему отдельный модуль. Связка «продавец + объект» (24.09.2026,
 * lib/propertyHandover.ts, шапка) работает в обе стороны: продавец сменил
 * агента → объекты едут за ним (это делает `changeClientAgent`, единственная
 * точка записи, через `transferSellerPropertiesWithClient`); объект передан →
 * продавец едет за ним (это здесь). Второе направление нуждается в
 * `changeClientAgent`, а та уже импортирует `propertyHandover.ts` — положить
 * обратный вызов в тот же файл значило бы завести цикл импортов, который
 * `audit:deps` запрещает не зря: порядок инициализации становится неявным.
 * Поэтому ядро передачи объекта живёт в propertyHandover.ts без знания о
 * клиентах, а «объект + продавец» собирается здесь, этажом выше.
 *
 * Продавец едет только если он был у ПРЕЖНЕГО хозяина объекта: чужого
 * продавца у другого агента объектом не отбирают. Приходит новому агенту как
 * лид (acceptedAt = null) — как при любой передаче клиента.
 */
export interface TransferPropertyWithSellerResult extends TransferPropertyResult {
  /** Продавец объекта переехал вместе с ним. */
  sellerMoved: boolean;
}

/**
 * Поедет ли продавец вместе с объектом при передаче от `fromAgentId` к
 * `toAgentId`. Одно правило на две точки: саму передачу ниже и проверку прав
 * в routes/properties/transfer.ts (глубокая проверка 02.10.2026, A4) — смена
 * держателя клиента требует clients.assign, и маршрут обязан знать заранее,
 * будет ли она. Возвращает id продавца или null.
 */
export async function sellerFollowingTransfer(
  propertyId: string,
  fromAgentId: string | null,
  toAgentId: string
): Promise<string | null> {
  const property = await prisma.property.findUnique({
    where: { id: propertyId },
    select: { sellerClientId: true },
  });
  if (!property?.sellerClientId) return null;

  const seller = await prisma.client.findUnique({
    where: { id: property.sellerClientId },
    select: { id: true, assignedAgentId: true, deletedAt: true, status: true },
  });
  const follows =
    !!seller &&
    !seller.deletedAt &&
    seller.assignedAgentId === fromAgentId &&
    seller.assignedAgentId !== toAgentId &&
    !["DEAL_CLOSED", "ARCHIVED"].includes(seller.status);
  return follows ? seller.id : null;
}

export async function transferPropertyWithSeller(
  input: Omit<TransferPropertyInput, "tx">
): Promise<TransferPropertyWithSellerResult> {
  const result = await transferPropertyToAgent(input);
  if (!result.changed) return { ...result, sellerMoved: false };

  const sellerId = await sellerFollowingTransfer(input.propertyId, result.fromAgentId, input.toAgentId);
  if (!sellerId) return { ...result, sellerMoved: false };

  const moved = await changeClientAgent({
    clientId: sellerId,
    toAgentId: input.toAgentId,
    reason: `Объект №${result.shortId} передан другому агенту — продавец переходит вместе с ним. ${input.reason}`,
    actorId: input.actorId,
    actorName: input.actorName,
    interactionAgentId: input.toAgentId,
    source: "property-transfer",
    data: { assignedAt: new Date(), acceptedAt: null },
    // Объект уже переехал строкой выше — обратный вызов из changeClientAgent
    // сделал бы вторую запись о передаче того же объекта.
    skipProperties: true,
  });
  return { ...result, sellerMoved: moved.ok };
}
