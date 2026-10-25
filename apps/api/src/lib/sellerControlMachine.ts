import { sellerControlConfigSchema, type SellerControlCommand, type SellerControlConfig, type DaysOffCalendar } from "@royal-home/shared";
import { addAlarmWorkingDays } from "./alarmCalendar.js";

export type SellerControlState = {
  status: string; agentDueAt: Date | null; ropReceiptDueAt: Date | null;
  ropReceiptAt: Date | null; ropActionDueAt: Date | null; resolvedAt: Date | null;
};
export function readSellerControlConfig(value: unknown): SellerControlConfig | null {
  const parsed = sellerControlConfigSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}
/** Deterministic transition planner: no guilt, score, delivery, or implicit deadlines. */
export function planSellerControl(input: {
  state: SellerControlState; config: SellerControlConfig | null; action: SellerControlCommand["action"];
  now: Date; calendar: DaysOffCalendar; assignmentCurrent: boolean; inventory: "COMPLETE" | "MISSING" | "UNCERTAIN";
  hasRop: boolean; dataAvailable: boolean;
}): { event: string; patch: Partial<SellerControlState> } {
  const { state, now, config } = input;
  if (["RESOLVED", "CANCELLED"].includes(state.status)) return { event: "ALREADY_CLOSED", patch: {} };
  if (!input.assignmentCurrent) return { event: "ASSIGNMENT_ENDED", patch: { status: "CANCELLED", resolvedAt: now } };
  if (input.action === "CANCEL") return { event: "CANCELLED_BY_MANAGER", patch: { status: "CANCELLED", resolvedAt: now } };
  if (input.action === "RESOLVE") return { event: "RESOLVED_BY_MANAGER", patch: { status: "RESOLVED", resolvedAt: now } };
  if (!input.dataAvailable) return { event: "DATA_UNAVAILABLE", patch: {} };
  if (input.inventory === "COMPLETE") return { event: "INVENTORY_COMPLETE", patch: { status: "RESOLVED", resolvedAt: now } };
  if (input.inventory === "UNCERTAIN") return { event: "FACTS_UNCERTAIN", patch: {} };
  if (!config) return { event: "NOT_CONFIGURED", patch: {} };
  if (!input.hasRop && state.status !== "DIRECTOR") return { event: "ROP_NOT_ASSIGNED", patch: {} };
  if (input.action === "RECEIPT") {
    if (state.status !== "ROP_RECEIPT") return { event: "RECEIPT_NOT_APPLICABLE", patch: {} };
    return { event: "ROP_RECEIVED", patch: { status: "ROP_ACTION", ropReceiptAt: now,
      ropActionDueAt: addAlarmWorkingDays(now, config.ropActionDueWorkingDays, input.calendar) } };
  }
  if (input.action === "ACTION") return { event: state.status === "ROP_ACTION" ? "ROP_ACTION_RECORDED" : "ACTION_NOT_APPLICABLE", patch: {} };
  if (state.status === "AGENT_TASK" && state.agentDueAt && now >= state.agentDueAt) {
    if (!input.hasRop) return { event: "ROP_NOT_ASSIGNED", patch: {} };
    return { event: "AGENT_DEADLINE_ELAPSED", patch: { status: "ROP_RECEIPT",
      ropReceiptDueAt: addAlarmWorkingDays(now, config.ropReceiptDueWorkingDays, input.calendar) } };
  }
  if (state.status === "ROP_RECEIPT" && state.ropReceiptDueAt && now >= state.ropReceiptDueAt)
    return { event: "ROP_RECEIPT_NOT_RECORDED", patch: { status: "DIRECTOR" } };
  if (state.status === "ROP_ACTION" && state.ropActionDueAt && now >= state.ropActionDueAt)
    return { event: "ROP_RESULT_NOT_CONFIRMED", patch: { status: "DIRECTOR" } };
  return { event: "WAITING", patch: {} };
}
