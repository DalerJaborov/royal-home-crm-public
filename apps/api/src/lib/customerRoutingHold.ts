// What a HELD routing decision for ONE incoming DM means for the Meta webhook
// (13.11.2026, incident 12.11: echo → "historical_subject_owned_or_closed").
//
// Before: any held witness turned the WHOLE webhook into 503 "not saved yet".
// A permanent hold never clears on retry, so Meta retried for ~15 minutes and
// then dropped the customer's message, and nothing reached the error log.
//
// Now each reason has one of three dispositions:
//  - "retry": a race that a redelivery can resolve -> keep 503, Meta retries;
//  - "already_handled": the event was already seen by the old bot -> ACK quietly;
//  - "report" (DEFAULT for every other and every future reason): ACK 200, the
//    message stays OUT of both bots exactly as before (HELD never falls into the
//    legacy controller, the webhook skips it by its routing witness), and the
//    error log gets a line per person so staff answer by hand from the app.
// A new reason therefore never silently becomes "503 forever" again; the guard
// test `customer-routing-hold-disposition.test.ts` lists every held() literal of
// the routing chain and fails until the new one is classified on purpose.
import { logSystemError } from "./systemError.js";

export type CustomerRoutingHoldDisposition = "retry" | "already_handled" | "report";

/** Transient: the same delivery can succeed a moment later. */
export const CUSTOMER_ROUTING_HOLD_RETRY = ["captured_scope_changed", "assignment_commit_missing"] as const;
/** The original MID is already in the legacy native history: it was handled. */
export const CUSTOMER_ROUTING_HOLD_ALREADY_HANDLED = ["original_native_source_already_observed"] as const;
/** Permanent until a person changes data/settings; listed so the guard test
 * can tell "classified on purpose" from "added and forgotten". */
export const CUSTOMER_ROUTING_HOLD_REPORT = [
  "subject_invalid", "core_assignment_invalid", "source_tombstoned_or_ambiguous", "original_source_changed",
  "source_assignment_changed", "active_transaction_required", "surface_enrollment_unavailable", "policy_missing_or_invalid",
  "owned_subject_stopped", "rollout_config_required", "shadow_not_implemented", "candidate_policy_mismatch",
  "pinned_campaign_unavailable", "cohort_candidate_changed", "registered_candidate_missing", "legacy_native_scope_collision",
  "historical_subject_owned_or_closed", "historical_public_subject_owned_or_unbounded", "unkeyed_core_input_unsupported",
  "historical_legacy_selection_conflict", "historical_brains_conflict",
  // Public-comment ownership reads in the same module (not a DM witness today).
  "source_reference_invalid", "source_missing", "staff_public_source_owned", "legacy_source_managed_conflict", "core_public_origin_missing",
] as const;

const retry = new Set<string>(CUSTOMER_ROUTING_HOLD_RETRY);
const handled = new Set<string>(CUSTOMER_ROUTING_HOLD_ALREADY_HANDLED);

export function customerRoutingHoldDisposition(reason: string): CustomerRoutingHoldDisposition {
  if (retry.has(reason)) return "retry";
  if (handled.has(reason)) return "already_handled";
  return "report";
}

const CHANNEL_NAME: Record<string, string> = { INSTAGRAM: "Instagram", FACEBOOK: "Facebook", WHATSAPP: "WhatsApp" };

/** Durable, deduplicated trace of a DM that NO bot will answer. One line per
 * person per window (scope = channel/account/peer), a director push only the
 * first time this reason is ever seen (logSystemError's own rule). No message
 * text: the conversation itself stays in the provider's app. */
export function reportCustomerRoutingHold(hold: { reason: string; channel: string; accountExternalId?: string | null; peer: string }): void {
  const channel = CHANNEL_NAME[hold.channel] ?? hold.channel;
  void logSystemError(
    "meta",
    `Сообщение клиента в ${channel} не передано ни одному боту (причина «${hold.reason}», ` +
      `собеседник ${hold.peer}, аккаунт ${hold.accountExternalId ?? "не указан"}). ` +
      `Meta получила ответ «принято» и повторять не будет: ответьте человеку вручную из приложения ${channel}.`,
    // Scope = the person: logSystemError keeps the first 120 characters of it.
    { dedupKey: `customer-dm-routing-held:${hold.reason}`, dedupScope: `${hold.channel}:${hold.peer}` },
  );
}

/** A 503 to Meta is a promise that the retry may succeed. Make every one visible:
 * if it repeats for ~15 minutes, Meta gives up and the event is lost. */
export function reportMetaWebhookNotSaved(kind: "dm" | "public_comment", reason: string): void {
  void logSystemError(
    "meta",
    `Вебхук Meta ответил 503 (${kind === "dm" ? "личное сообщение" : "комментарий"} не сохранено, причина «${reason}»). ` +
      `Meta повторяет доставку около 15 минут; если ошибка не уходит, событие потеряется.`,
    { dedupKey: `meta-webhook-503:${kind}:${reason}` },
  );
}
