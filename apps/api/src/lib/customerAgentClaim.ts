import { randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import type { TxClient } from "../db.js";
import { isActiveTransactionClient } from "./transactionScope.js";
import { isCustomerPrincipal, type CustomerPrincipal } from "./customerPrincipal.js";
import { pinCustomerAgentTurnTx, type CustomerAgentTurnPin } from "./customerAgentRevision.js";

declare const claimBrand: unique symbol;
export type CustomerAgentClaim = Readonly<{ eventKey: string; owner: string; revision: string;
  deadlineAt: number; pin: CustomerAgentTurnPin }> & { readonly [claimBrand]: true };
const claims = new WeakMap<object, { principal: CustomerPrincipal }>();
export type CustomerAgentClaimResult = { status: "claimed"; claim: CustomerAgentClaim } |
  { status: "already_planned" } | { status: "held"; reason: string };

/** Relation only, not a fresh current/OUT grant. Both objects must be genuine.
 * A same-IN local intent/receipt may change semantic revisions, never the
 * controller, namespace, privacy level, source, age or original pinned turn.
 * Callers still revalidate the latest principal and actual claim lease. */
export function customerAgentClaimAcceptsPrincipal(claim: unknown, principal: unknown): boolean {
  const original = claim && typeof claim === "object" ? claims.get(claim)?.principal : undefined;
  if (!original || !isCustomerPrincipal(principal)) return false;
  const a = original.authority.fence, b = principal.authority.fence;
  return isDeepStrictEqual(original.admission, principal.admission) && isDeepStrictEqual(original.scope, principal.scope) &&
    isDeepStrictEqual(original.knownContact, principal.knownContact) && original.visibility === principal.visibility &&
    original.provenance === principal.provenance && original.assurance === principal.assurance &&
    a.inquiryId === b.inquiryId && a.nativeId === b.nativeId && isDeepStrictEqual(a.endpoint, b.endpoint) &&
    a.ownerToken === b.ownerToken && a.ownershipEpoch === b.ownershipEpoch && a.bindingRevision === b.bindingRevision &&
    a.scopeRevision === b.scopeRevision && a.policyRevision === b.policyRevision;
}

/** The native/scope/policy/Inquiry/Ticket locks are acquired by genuine pinning
 * before CAS. No controller exists from a parsed lease JSON. The lease spans
 * the ORIGINAL deadline; no timeout retries a possibly active model loop.
 * Crash recovery of short leases is deliberately not inferred here. */
export async function claimCustomerAgentTurnTx(tx: TxClient, principal: unknown): Promise<CustomerAgentClaimResult> {
  if (!isActiveTransactionClient(tx) || !isCustomerPrincipal(principal)) return { status: "held", reason: "invalid_context" };
  const pinned = await pinCustomerAgentTurnTx(tx, principal);
  if (pinned.status !== "pinned") return pinned;
  const owner = randomUUID(), pin = pinned.pin;
  const [row] = await tx.$queryRaw<Array<{ claimRevision: bigint }>>`UPDATE "CustomerPropertyIngressTicket"
    SET "processingState"='CLAIMED',"claimRevision"="claimRevision"+1,"leaseOwner"=${owner},
      "leaseUntil"=${new Date(pin.providerDeadlineAt)},"attempts"="attempts"+1,"errorCode"=NULL
    WHERE "eventKey"=${pin.eventKey} AND "order"=${BigInt(pin.order)} AND "tombstonedAt" IS NULL
      AND "inputRecordedAt" IS NOT NULL AND "originVersion"=1
      AND "processingState" IN ('RECEIVED','HELD') AND "leaseOwner" IS NULL
      AND "agentRevisionId"=${pin.agentRevisionId} AND "providerOperationId"=${pin.providerOperationId}
      AND "providerDeadlineAt">clock_timestamp()
    RETURNING "claimRevision"`;
  if (!row) return { status: "held", reason: "turn_already_owned" };
  const claim = Object.freeze({ eventKey: pin.eventKey, owner, revision: row.claimRevision.toString(),
    deadlineAt: pin.providerDeadlineAt, pin }) as CustomerAgentClaim;
  claims.set(claim, { principal });
  return { status: "claimed", claim };
}

/** Call only after the ORIGINAL native/controller check. This is ownership,
 * never a substitute for current input, facts, policy or receipt validation. */
export async function customerAgentClaimCurrentTx(tx: Pick<TxClient, "$queryRaw">, claim: unknown): Promise<boolean> {
  if (!claim || typeof claim !== "object" || !claims.has(claim)) return false;
  const value = claim as CustomerAgentClaim;
  if (Date.now() >= value.deadlineAt) return false;
  const [row] = await tx.$queryRaw<Array<{ current: boolean }>>`SELECT EXISTS(SELECT 1 FROM "CustomerPropertyIngressTicket"
    WHERE "eventKey"=${value.eventKey} AND "processingState"='CLAIMED' AND "leaseOwner"=${value.owner}
      AND "claimRevision"=${BigInt(value.revision)} AND "leaseUntil">clock_timestamp() AND "tombstonedAt" IS NULL
      AND "agentRevisionId"=${value.pin.agentRevisionId} AND "providerOperationId"=${value.pin.providerOperationId}
      AND "providerDeadlineAt"=${new Date(value.deadlineAt)}) AS current`;
  return row?.current === true;
}
