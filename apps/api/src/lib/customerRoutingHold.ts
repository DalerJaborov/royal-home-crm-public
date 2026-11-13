// What a HELD routing decision for ONE incoming DM means for the Meta webhook
// (13.11.2026, incident 12.11: echo → "historical_subject_owned_or_closed").
//
// Before: any held witness turned the WHOLE webhook into 503 "not saved yet".
// A permanent hold never clears on retry, so Meta retried for ~15 minutes and
// then dropped the customer's message, and nothing reached the error log.
//
// Now each reason has one of two dispositions:
//  - "unavailable" (503, Meta retries, nothing written): a race a redelivery can
//    resolve; a REDELIVERY of a MID that already has its original source; the
//    deliberate cross-account collision guard. Every 503 is logged per account.
//  - "report" (DEFAULT for every other and every future reason): a NEW message
//    held for good. Its text is written into the person's CRM chat BEFORE the ACK
//    (customerHeldMessage.ts), Meta gets 200, no bot answers it (the webhook skips
//    it by its witness before any Graph lookup), and after the ACK the responsible
//    agent gets one notification with the client's name and a link to the chat.
// A new reason therefore never silently becomes "503 forever" again; the guard
// test `customer-routing-hold-disposition.test.ts` lists every held() literal of
// the routing chain and fails until the new one is classified on purpose.
import { logSystemError } from "./systemError.js";

export type CustomerRoutingHoldDisposition = "unavailable" | "report";

/** Transient: the same delivery can succeed a moment later. */
export const CUSTOMER_ROUTING_HOLD_RETRY = ["captured_scope_changed", "assignment_commit_missing"] as const;
/** A REDELIVERY of a MID that already has an original source (ticket or legacy
 * native history): the message itself was already taken in once. Nothing is
 * written again (no second chat line, no recreated chat, tombstone kept) and
 * the webhook keeps answering 503 without a turn, as before 13.11
 * (customer-original-source / legacy-cutover tests guard this). */
export const CUSTOMER_ROUTING_HOLD_REDELIVERY = ["original_source_changed", "source_tombstoned_or_ambiguous",
  "source_assignment_changed", "original_native_source_already_observed", "historical_legacy_selection_conflict"] as const;
/** Deliberate boundary: the same raw peer on another account is refused until
 * the contract-cutover release (Phase-A collision guard). Stays 503, now logged. */
export const CUSTOMER_ROUTING_HOLD_GUARD = ["legacy_native_scope_collision"] as const;
/** Permanent hold of a NEW message: ACK 200, text into the CRM chat, staff
 * notified. Listed so the guard test can tell "classified on purpose" from
 * "added and forgotten"; any unknown reason is treated as "report" too. */
export const CUSTOMER_ROUTING_HOLD_REPORT = [
  "subject_invalid", "core_assignment_invalid", "active_transaction_required", "surface_enrollment_unavailable", "policy_missing_or_invalid",
  "owned_subject_stopped", "rollout_config_required", "shadow_not_implemented", "candidate_policy_mismatch",
  "pinned_campaign_unavailable", "cohort_candidate_changed", "registered_candidate_missing",
  "historical_subject_owned_or_closed", "historical_public_subject_owned_or_unbounded", "unkeyed_core_input_unsupported",
  "historical_brains_conflict",
  // Public-comment ownership reads in the same module (not a DM witness today).
  "source_reference_invalid", "source_missing", "staff_public_source_owned", "legacy_source_managed_conflict", "core_public_origin_missing",
] as const;

const unavailable = new Set<string>([...CUSTOMER_ROUTING_HOLD_RETRY, ...CUSTOMER_ROUTING_HOLD_REDELIVERY, ...CUSTOMER_ROUTING_HOLD_GUARD]);

export function customerRoutingHoldDisposition(reason: string): CustomerRoutingHoldDisposition {
  return unavailable.has(reason) ? "unavailable" : "report";
}

/** A 503 to Meta is a promise that the retry may succeed. Make every one visible:
 * if it repeats for ~15 minutes, Meta gives up and the event is lost. */
export function reportMetaWebhookNotSaved(kind: "dm" | "public_comment", reason: string, accountExternalId?: string): void {
  void logSystemError(
    "meta",
    `Вебхук Meta ответил 503 (${kind === "dm" ? "личное сообщение" : "комментарий"} не сохранено, причина «${reason}»). ` +
      `Meta повторяет доставку около 15 минут; если ошибка не уходит, событие потеряется.`,
    // Scope = the receiving account: one line per account and reason per window.
    { dedupKey: `meta-webhook-503:${kind}:${reason}`, ...(accountExternalId ? { dedupScope: `account:${accountExternalId}` } : {}), quietPult: true },
  );
}
