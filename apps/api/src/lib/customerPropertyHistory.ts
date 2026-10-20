import type { ChatMessage } from "../ai/shared.js";

/** Pending/held/unknown text is a diagnostic record, never a spoken anchor. */
export function customerPropertyMessageVisible(message: ChatMessage): boolean {
  if (!message || typeof message !== "object") return false;
  return !message.customerPropertyDelivery || message.customerPropertyDelivery.status === "accepted";
}
/** A captured denied entry cannot disappear behind an earlier admitted object. */
export function boundedCustomerPropertyBatch(batch: readonly import("@royal-home/shared").CustomerPropertyAdmissionResult[]): import("@royal-home/shared").CustomerPropertyAdmissionResult[] {
  return batch.length <= 16 ? [...batch] : [...batch.slice(0, 15), { status: "denied", reason: "invalid_input" }];
}
export function customerPropertyPromptHistory(history: readonly ChatMessage[]): ChatMessage[] {
  return history.filter(customerPropertyMessageVisible);
}
/** No legacy full-turn replay after a managed part was persisted, even if the
 * provider accepted it but the process crashed before stamping the receipt. */
export function customerPropertyTurnTerminal(history: readonly ChatMessage[]): boolean {
  let lastInput = history.length - 1;
  while (lastInput >= 0 && history[lastInput].role !== "user") lastInput--;
  if (lastInput < 0) return false;
  const key = history[lastInput].customerPropertyAdmission?.eventKey;
  return history.slice(lastInput + 1).some((message) => message.role === "assistant" &&
    !!message.customerPropertyDelivery && (!key || message.customerPropertyDelivery.inputEventKey === key));
}
