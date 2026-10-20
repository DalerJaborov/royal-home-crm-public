import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ consume: vi.fn(), dispatch: vi.fn(), expire: vi.fn(), diagnostic: vi.fn() }));
vi.mock("../src/lib/customerIngressProducer.js", async importOriginal => ({
  ...(await importOriginal<typeof import("../src/lib/customerIngressProducer.js")>()), consumeCustomerInboxTicket: mocks.consume,
}));
vi.mock("../src/lib/customerDeliveryDispatcher.js", async importOriginal => ({
  ...(await importOriginal<typeof import("../src/lib/customerDeliveryDispatcher.js")>()),
  dispatchCustomerOutboxPart: mocks.dispatch, holdExpiredCustomerDeliveryClaims: mocks.expire,
}));
vi.mock("../src/lib/systemError.js", async importOriginal => ({
  ...(await importOriginal<typeof import("../src/lib/systemError.js")>()), logSystemError: mocks.diagnostic,
}));
const { customerInboxConsumeJob } = await import("../src/jobs/customerInboxConsume.js");
const { customerOutboxDispatchJob } = await import("../src/jobs/customerOutboxDispatch.js");
const partId = "540bd9c7-97a2-4429-915a-1e8da2fa22a4", eventKey = "a".repeat(64);

beforeEach(() => {
  vi.clearAllMocks(); mocks.consume.mockResolvedValue({ status: "held", reason: "planner_unavailable" });
  mocks.dispatch.mockResolvedValue({ status: "unknown" }); mocks.expire.mockResolvedValue(0);
  mocks.diagnostic.mockResolvedValue(undefined);
});

describe("durable customer queue adapters", () => {
  it("validates persisted payload versions and rejects caller-added routing fields", () => {
    expect(customerInboxConsumeJob.schema.safeParse({ version: 1, eventKey, peer: "foreign" }).success).toBe(false);
    expect(customerInboxConsumeJob.schema.safeParse({ version: 2, eventKey }).success).toBe(false);
    expect(customerOutboxDispatchJob.schema.safeParse({ version: 1, partId, retry: true }).success).toBe(false);
    expect(customerOutboxDispatchJob.schema.safeParse({ version: 1, partId: "bad" }).success).toBe(false);
  });
  it("examines an inbox ticket without converting HELD into planned success", async () => {
    await customerInboxConsumeJob.run({ version: 1, eventKey });
    expect(mocks.consume).toHaveBeenCalledExactlyOnceWith(eventKey);
    expect(mocks.dispatch).not.toHaveBeenCalled();
  });
  it.each(["unknown", "not_sent", "suppressed", "missing", "accepted", "available_widget"])("%s finishes the queue attempt without generating a new message", async status => {
    mocks.dispatch.mockResolvedValue({ status });
    await customerOutboxDispatchJob.run({ version: 1, partId });
    expect(mocks.expire).toHaveBeenCalledTimes(1);
    expect(mocks.dispatch).toHaveBeenCalledExactlyOnceWith(partId);
    expect(mocks.expire.mock.invocationCallOrder[0]).toBeLessThan(mocks.dispatch.mock.invocationCallOrder[0]);
    expect(mocks.consume).not.toHaveBeenCalled();
    if (status === "unknown" || status === "not_sent") {
      expect(mocks.diagnostic).toHaveBeenCalledExactlyOnceWith("background-jobs",
        "Площадка не подтвердила сохранённую отправку; автоматический повтор не выполнен, нужна проверка квитанции",
        { dedupKey: `customer-outbox-dispatch:${partId}` });
    } else expect(mocks.diagnostic).not.toHaveBeenCalled();
  });
  it.each([{ status: "waiting" }, { status: "accepted", projectionPending: true }])("retries only the existing part/projection: %j", async result => {
    mocks.dispatch.mockResolvedValue(result);
    await expect(customerOutboxDispatchJob.run({ version: 1, partId })).rejects.toThrow(/pending|busy/);
    expect(mocks.dispatch).toHaveBeenCalledExactlyOnceWith(partId);
    expect(mocks.consume).not.toHaveBeenCalled();
  });
  it("a storage failure reaches the queue retry policy", async () => {
    mocks.expire.mockRejectedValueOnce(new Error("synthetic database failure"));
    await expect(customerOutboxDispatchJob.run({ version: 1, partId })).rejects.toThrow("synthetic database failure");
    expect(mocks.dispatch).not.toHaveBeenCalled();
  });
});
