import { createHash, randomUUID } from "node:crypto";
import { moderationErrorOutcome, type ModerationProvider } from "./commentModerationOutcome.js";

import type { PublicReplyReceipt, PublicReplyTarget } from "@royal-home/shared";
export type { PublicReplyOutcome, PublicReplyReceipt, PublicReplyTarget } from "@royal-home/shared";
export function publicReplyTargetHash(target: PublicReplyTarget): string {
  return createHash("sha256").update(JSON.stringify(Object.entries(target).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0))).digest("hex");
}
export class PublicReplyHeldError extends Error {
  constructor(readonly reason: string, readonly receipt?: PublicReplyReceipt) {
    super(`Public reply held: ${reason}`); this.name = "PublicReplyHeldError";
  }
}
export interface PublicReplyLease {
  attemptKey: string;
  targetHash: string;
  sourceRevision: bigint;
}
/** Server-only common P12 public-target port, not a second row journal or customer authority.
 * Root supplies atomic source/attempt claim, immutable observed receipt and conditional projection. */
export interface PublicReplyStore {
  claim(expectedSourceRevision: bigint, attemptKey: string, target: PublicReplyTarget, targetHash: string): Promise<PublicReplyLease | null>;
  isCurrent(lease: PublicReplyLease): Promise<boolean>;
  /** Always record the observed provider result for the original attempt.
   * Return false when current source changed: no new-status/text projection. */
  complete(lease: PublicReplyLease, receipt: PublicReplyReceipt, text: string): Promise<boolean | { applicable: boolean; receipt: PublicReplyReceipt }>;
}
export function publicReplyReceipt(provider: ModerationProvider, raw: unknown): PublicReplyReceipt {
  const object = raw && typeof raw === "object" && !Array.isArray(raw) ? raw as Record<string, unknown> : null;
  if (object && (Object.hasOwn(object, "error") || Object.hasOwn(object, "error_code") || object.success === false || object.ok === false)) return { outcome: "unknown", providerId: null, reason: "contradictory_provider_response" };
  const candidate = typeof raw === "string" ? raw : provider === "TELEGRAM" ? object?.message_id : object?.id;
  const id = typeof candidate === "string" && candidate.trim() === candidate && candidate.length > 0 && candidate.length <= 512 ? candidate
    : provider === "TELEGRAM" && typeof candidate === "number" && Number.isSafeInteger(candidate) && candidate > 0 ? String(candidate) : null;
  return id ? { outcome: "accepted", providerId: id, reason: "provider_id" }
    : { outcome: "unknown", providerId: null, reason: "missing_provider_id" };
}
function failedReply(provider: ModerationProvider, error: unknown): PublicReplyReceipt {
  // Reuse C02's conservative provider-error classification only. Its moderation
  // effect is not a public-reply permission or an acceptance predicate.
  const failure = moderationErrorOutcome(provider, provider === "YOUTUBE" ? "reject" : "delete", error);
  return { outcome: failure.outcome === "refused" ? "refused" : "unknown", providerId: null,
    reason: failure.outcome === "refused" ? failure.reason : "unconfirmed_post" };
}
export async function sendRecordedPublicReply(input: {
  provider: ModerationProvider; target: PublicReplyTarget; expectedSourceRevision: bigint;
  text: string; store: PublicReplyStore;
  send(beforePost: () => Promise<void>): Promise<unknown>;
}): Promise<string> {
  const hash = publicReplyTargetHash(input.target);
  const lease = await input.store.claim(input.expectedSourceRevision, randomUUID(), input.target, hash);
  if (!lease) throw new PublicReplyHeldError("source_changed_or_attempt_exists");
  const assertCurrent = async () => {
    if (!(await input.store.isCurrent(lease))) throw new PublicReplyHeldError("source_changed_before_post");
  };
  let physicalClaimed = false, physicalAdmitted = false, repeatedPhysicalClaim = false;
  const beforePhysicalPost = async () => {
    // Set before awaiting the freshness read: two concurrent/retried callbacks
    // cannot both pass under one logical attempt, even while the lease is current.
    if (physicalClaimed) { repeatedPhysicalClaim = true; throw new PublicReplyHeldError("physical_post_already_attempted"); }
    physicalClaimed = true;
    await assertCurrent();
    physicalAdmitted = true;
  };
  let receipt: PublicReplyReceipt;
  try {
    await assertCurrent();
    const raw = await input.send(beforePhysicalPost);
    receipt = !physicalAdmitted || repeatedPhysicalClaim
      ? { outcome: "unknown", providerId: null, reason: repeatedPhysicalClaim ? "repeated_physical_post_callback" : "physical_post_callback_missing" }
      : publicReplyReceipt(input.provider, raw);
  } catch (error) {
    // Even an interrupted pre-POST path is terminal in this bounded interim.
    // Reopening requires a future explicit safe reconciliation operation.
    receipt = failedReply(input.provider, error);
  }
  let applicable: boolean;
  try {
    const completed = await input.store.complete(lease, receipt, input.text);
    if (typeof completed === "boolean") applicable = completed;
    else { applicable = completed.applicable; receipt = completed.receipt; }
  }
  catch { throw new PublicReplyHeldError("receipt_persistence_unavailable", receipt); }
  if (receipt.outcome !== "accepted") throw new PublicReplyHeldError(receipt.reason, receipt);
  if (!applicable) throw new PublicReplyHeldError("source_changed_after_post", receipt);
  if (!receipt.providerId) throw new PublicReplyHeldError("missing_provider_id", receipt);
  return receipt.providerId;
}
