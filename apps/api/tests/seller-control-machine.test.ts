import { describe, expect, it } from "vitest";
import { planSellerControl, readSellerControlConfig, type SellerControlState } from "../src/lib/sellerControlMachine.js";

const now = new Date("2026-10-23T10:00:00Z");
const config = { agentDueWorkingDays: 1, ropReceiptDueWorkingDays: 1, ropActionDueWorkingDays: 2 };
const state: SellerControlState = { status: "AGENT_TASK", agentDueAt: now, ropReceiptDueAt: null,
  ropReceiptAt: null, ropActionDueAt: null, resolvedAt: null };
const input = { state, config, action: "TICK" as const, now, calendar: { companyDaysOff: [0], agentDaysOff: [] },
  assignmentCurrent: true, inventory: "MISSING" as const, hasRop: true, dataAvailable: true };

describe("seller control: deadlines are configuration, not accusations", () => {
  it("requires all positive explicit deadlines", () => {
    for (const value of [{}, null, { ...config, ropActionDueWorkingDays: 0 }, { ...config, agentDueWorkingDays: -1 }, { ...config, mode: "LIVE" }])
      expect(readSellerControlConfig(value)).toBeNull();
    expect(readSellerControlConfig(config)).toEqual(config);
    expect(planSellerControl({ ...input, config: null })).toEqual({ event: "NOT_CONFIGURED", patch: {} });
  });
  it("walks agent deadline → receipt → actual action deadline → director without skipping stages", () => {
    const first = planSellerControl(input);
    expect(first.patch.status).toBe("ROP_RECEIPT");
    expect(first.patch.ropReceiptDueAt).toEqual(new Date("2026-10-24T10:00:00Z"));
    const received = planSellerControl({ ...input, state: { ...state, ...first.patch }, action: "RECEIPT" });
    expect(received.patch.status).toBe("ROP_ACTION");
    // Sunday is excluded; Saturday remains a working day.
    expect(received.patch.ropActionDueAt).toEqual(new Date("2026-10-26T10:00:00Z"));
    const action = planSellerControl({ ...input, state: { ...state, ...received.patch }, action: "ACTION" });
    expect(action).toEqual({ event: "ROP_ACTION_RECORDED", patch: {} });
    const overdue = planSellerControl({ ...input, state: { ...state, ...received.patch }, now: new Date("2026-10-27T10:00:00Z") });
    expect(overdue).toEqual({ event: "ROP_RESULT_NOT_CONFIRMED", patch: { status: "DIRECTOR" } });
  });
  it("absence of receipt is distinct from confirmed inaction and late receipt cannot rewind director stage", () => {
    const waiting = { ...state, status: "ROP_RECEIPT", ropReceiptDueAt: now };
    expect(planSellerControl({ ...input, state: waiting }).event).toBe("ROP_RECEIPT_NOT_RECORDED");
    expect(planSellerControl({ ...input, state: { ...waiting, status: "DIRECTOR" }, action: "RECEIPT" }).patch).toEqual({});
  });
  it("unknown data, recipient or inventory never escalates", () => {
    for (const override of [{ dataAvailable: false }, { inventory: "UNCERTAIN" as const }, { hasRop: false }])
      expect(planSellerControl({ ...input, ...override }).patch).toEqual({});
    expect(planSellerControl({ ...input, hasRop: false, state: { ...state, status: "ROP_RECEIPT", ropReceiptDueAt: now } }).patch).toEqual({});
    expect(planSellerControl({ ...input, hasRop: false, state: { ...state, status: "DIRECTOR" }, inventory: "COMPLETE" }).patch.status).toBe("RESOLVED");
  });
  it("resolved inventory closes; reassignment cancels; closed episodes cannot revive", () => {
    expect(planSellerControl({ ...input, inventory: "COMPLETE" }).patch.status).toBe("RESOLVED");
    expect(planSellerControl({ ...input, assignmentCurrent: false }).patch.status).toBe("CANCELLED");
    expect(planSellerControl({ ...input, state: { ...state, status: "CANCELLED" }, action: "RECEIPT" }).patch).toEqual({});
  });
});
