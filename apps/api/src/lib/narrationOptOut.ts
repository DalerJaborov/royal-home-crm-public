import { prisma } from "../db.js";
import { logAgentAudit } from "./audit.js";

/**
 * «БЕЗ ОЗВУЧКИ» — ОДНА ДВЕРЬ (12.11.2026, решение владельца). Мастер CRM, мастер Шабнам и
 * кнопка карточки зовут только её. Выключено — ничего не генерируется и не тратится:
 * ждущая генерация снимается, неотправленная передача монтажёру гасится, смена цены
 * новую озвучку не создаёт (обход narration-auto-flow смотрит Property.narrationOff).
 * Уже отправленный монтажёру mp3 не отзывается: он только для монтажа, в сеть не уходит;
 * монтажёру уходит одна строка, если объект сейчас у него (зовёт вызывающий).
 *
 * Включить обратно можно из карточки: флаг снимается, а новую версию ставит вызывающий
 * (requestAutoNarration — та же дверь генерации, тот же дневной потолок).
 */
/** Проданный и снятый объект новую озвучку не получает (одно место для обхода и снятия с продажи). */
export const NARRATION_CLOSED_STATUSES = ["SOLD", "WITHDRAWN"] as const;
const CLOSED_STATUSES = NARRATION_CLOSED_STATUSES;

export type NarrationOffChange = { changed: boolean; off: boolean; heldByMontajer: boolean; shortId: number } | null;

export async function setPropertyNarrationOff(propertyId: string, off: boolean, actorId: string): Promise<NarrationOffChange> {
  const result = await prisma.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT id FROM "Property" WHERE id = ${propertyId} FOR UPDATE`;
    const p = await tx.property.findUnique({ where: { id: propertyId }, select: { id: true, shortId: true, deletedAt: true, narrationOff: true, videoHandoffStatus: true, videoHandoffManualSince: true } });
    if (!p || p.deletedAt) return null;
    const heldByMontajer = p.videoHandoffStatus === "SENT_TO_EDITOR" && !p.videoHandoffManualSince;
    if (p.narrationOff === off) return { changed: false, off, heldByMontajer, shortId: p.shortId };
    await tx.property.update({ where: { id: propertyId }, data: { narrationOff: off, narrationOffAt: off ? new Date() : null } });
    if (off) {
      await tx.propertyNarrationVersion.updateMany({ where: { propertyId, status: "DRAFT", generateAfter: { not: null } }, data: { generateAfter: null } });
      await tx.propertyNarrationDelivery.updateMany({ where: { propertyId, status: { in: ["QUEUED", "PREVIEW"] } }, data: { status: "CANCELLED", lastError: "Выбрано «Без озвучки»" } });
    }
    return { changed: true, off, heldByMontajer, shortId: p.shortId };
  });
  if (result?.changed) logAgentAudit(actorId, off ? "PROPERTY_NARRATION_OFF" : "PROPERTY_NARRATION_ON", "Property", propertyId, { shortId: result.shortId });
  return result;
}

/**
 * ОБЪЕКТ ПРОДАН, СНЯТ ИЛИ УДАЛЁН ВО ВРЕМЯ МОНТАЖА (12.11.2026, класс «осиротевший спутник»).
 * Ждущая генерация снимается (денег не тратим), неотправленная передача монтажёру гасится.
 * Сам монтаж гасит closeWorkAfterLeavingSale; этот обход — страховка для любого пути.
 */
export async function retireNarrationsOfClosedProperties(propertyId?: string): Promise<number> {
  const closed = { OR: [{ deletedAt: { not: null } }, { status: { in: [...CLOSED_STATUSES] } }, { narrationOff: true }] };
  const where = propertyId ? { id: propertyId, ...closed } : closed;
  const drafts = await prisma.propertyNarrationVersion.updateMany({ where: { status: "DRAFT", generateAfter: { not: null }, property: where }, data: { generateAfter: null } });
  const deliveries = await prisma.propertyNarrationDelivery.updateMany({ where: { status: "QUEUED", property: where }, data: { status: "CANCELLED", lastError: "Объект продан, снят, удалён или без озвучки — передача не нужна" } });
  return drafts.count + deliveries.count;
}
