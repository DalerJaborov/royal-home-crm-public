import type { TxClient } from "../db.js";

export type ShowingDeliveryState = "DELIVERY_CONFIRMED" | "PROVIDER_ACCEPTED" | "AVAILABLE_TO_VIEW" | "EXPOSURE_RECORDED" | "DELIVERY_UNCONFIRMED";
export interface ShowingDeliveryFacts {
  state: ShowingDeliveryState;
  coverage: "UNKNOWN";
  references: Array<{ source: "SMS" | "CORE_OUTBOX" | "PROPERTY_EXPOSURE"; id: string; status: string; occurredAt: string }>;
}

/** Receipt semantics are intentionally distinct: accepted is not delivered/read.
 * An empty local journal is never evidence that no delivery happened elsewhere. */
export async function collectShowingDeliveryFacts(tx: TxClient, clientId: string, propertyId: string, before: Date): Promise<ShowingDeliveryFacts> {
  const [sms, outbox, exposures] = await Promise.all([
    tx.smsMessage.findMany({ where: { clientId, propertyId, createdAt: { lte: before }, status: "SENT" },
      select: { id: true, status: true, providerMessageId: true, deliveryStatus: true, deliveryStatusAt: true, createdAt: true }, orderBy: { createdAt: "desc" }, take: 30 }),
    tx.customerOutboxPart.findMany({ where: { conversation: { clientId }, p03Json: { path: ["propertyId"], equals: propertyId },
      status: { in: ["ACCEPTED", "AVAILABLE_WIDGET"] }, createdAt: { lte: before }, acceptedAt: { lte: before } },
      select: { id: true, status: true, acceptedAt: true, channel: true }, orderBy: { createdAt: "desc" }, take: 30 }),
    tx.propertyExposure.findMany({ where: { clientId, propertyId, sentAt: { lte: before } },
      select: { id: true, sentAt: true }, orderBy: { sentAt: "desc" }, take: 30 }),
  ]);
  const confirmed = sms.filter(row => row.providerMessageId && row.deliveryStatus === "DELIVERED" && row.deliveryStatusAt && row.deliveryStatusAt <= before);
  const accepted = sms.filter(row => row.providerMessageId && !["UNDELIVERABLE", "REJECTED", "EXPIRED"].includes(row.deliveryStatus ?? ""));
  return { state: confirmed.length ? "DELIVERY_CONFIRMED" : accepted.length || outbox.some(row => row.channel !== "WEBSITE") ? "PROVIDER_ACCEPTED"
    : outbox.length ? "AVAILABLE_TO_VIEW"
    : exposures.length ? "EXPOSURE_RECORDED" : "DELIVERY_UNCONFIRMED", coverage: "UNKNOWN", references: [
    ...sms.map(row => ({ source: "SMS" as const, id: row.id, status: row.deliveryStatus ?? row.status, occurredAt: row.createdAt.toISOString() })),
    ...outbox.map(row => ({ source: "CORE_OUTBOX" as const, id: row.id, status: row.channel === "WEBSITE" ? "WIDGET_AVAILABLE_NOT_VIEWED" : row.status,
      occurredAt: row.acceptedAt!.toISOString() })),
    ...exposures.map(row => ({ source: "PROPERTY_EXPOSURE" as const, id: row.id, status: "EXPOSURE_NOT_RECEIPT", occurredAt: row.sentAt.toISOString() })),
  ] };
}
