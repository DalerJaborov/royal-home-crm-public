import { beforeEach, describe, expect, it, vi } from "vitest";
import type { TxClient } from "../src/db.js";
import { collectShowingDeliveryFacts } from "../src/lib/showingDeliveryFacts.js";
const at = new Date("2026-10-25T10:00:00Z");
const db = { smsMessage: { findMany: vi.fn() }, customerOutboxPart: { findMany: vi.fn() }, propertyExposure: { findMany: vi.fn() } };
const read = () => collectShowingDeliveryFacts(db as unknown as TxClient, "client", "property", at);
beforeEach(() => { for (const model of Object.values(db)) model.findMany.mockReset().mockResolvedValue([]); });
describe("showing delivery provenance", () => {
  it("absence is unknown coverage, never proof of not sending", async () => {
    expect(await read()).toEqual({ state: "DELIVERY_UNCONFIRMED", coverage: "UNKNOWN", references: [] });
  });
  it("legacy exposure is not a delivery receipt", async () => {
    db.propertyExposure.findMany.mockResolvedValue([{ id: "exposure", sentAt: at }]);
    expect(await read()).toMatchObject({ state: "EXPOSURE_RECORDED", coverage: "UNKNOWN" });
  });
  it("provider accepted SMS differs from device delivered and a later receipt cannot prove earlier delivery", async () => {
    const sms = { id: "sms", status: "SENT", providerMessageId: "provider-id", deliveryStatus: "SERVICE_ACCEPTED", deliveryStatusAt: at, createdAt: at };
    db.smsMessage.findMany.mockResolvedValue([sms]); expect((await read()).state).toBe("PROVIDER_ACCEPTED");
    db.smsMessage.findMany.mockResolvedValue([{ ...sms, deliveryStatus: "DELIVERED" }]); expect((await read()).state).toBe("DELIVERY_CONFIRMED");
    db.smsMessage.findMany.mockResolvedValue([{ ...sms, deliveryStatus: "DELIVERED", deliveryStatusAt: new Date(at.getTime() + 1) }]); expect((await read()).state).toBe("PROVIDER_ACCEPTED");
  });
  it("CORE website publication does not imply delivery or viewing", async () => {
    db.customerOutboxPart.findMany.mockResolvedValue([{ id: "part", status: "AVAILABLE_WIDGET", channel: "WEBSITE", acceptedAt: at }]);
    expect(await read()).toMatchObject({ state: "AVAILABLE_TO_VIEW", coverage: "UNKNOWN", references: [expect.objectContaining({ status: "WIDGET_AVAILABLE_NOT_VIEWED" })] });
    db.customerOutboxPart.findMany.mockResolvedValue([{ id: "part", status: "ACCEPTED", channel: "WHATSAPP", acceptedAt: at }]);
    expect((await read()).state).toBe("PROVIDER_ACCEPTED");
  });
});
