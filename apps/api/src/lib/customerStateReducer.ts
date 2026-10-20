import {
  customerActionIntentsSchema, customerPublicStateSchema, customerStateEventSchema,
  type CustomerActionIntents, type CustomerStateEvent, type CustomerStateSnapshot,
} from "@royal-home/shared";

/** Private reducer storage; never included in the model-facing public state. */
export interface CustomerReducerState {
  snapshot: CustomerStateSnapshot;
  actionIntents: CustomerActionIntents;
  lastAcceptedEventKey: string | null;
  lastAcceptedOrder: string | null;
}
export type CustomerReduction =
  | { status: "applied"; state: CustomerReducerState }
  | { status: "same_event" | "stale" | "denied"; state: CustomerReducerState };
const MAX_REVISION = 9223372036854775807n;
function next(value: string): string {
  const result = BigInt(value) + 1n;
  if (result > MAX_REVISION) throw new Error("Customer state revision exhausted");
  return result.toString();
}
function sameEvidence(left: string[], right: string[]): boolean {
  const sortedRight = [...right].sort();
  return left.length === right.length && [...left].sort().every((value, index) => value === sortedRight[index]);
}

/** Shape validation is not authorization. The transaction adapter validates the
 * authenticated event source, accepted IN and captured fence before applying. */
export function reduceCustomerState(current: CustomerReducerState, rawEvent: CustomerStateEvent): CustomerReduction {
  const parsed = customerStateEventSchema.safeParse(rawEvent);
  if (!parsed.success || current.snapshot.closedAt) return { status: "denied", state: current };
  const event = parsed.data;
  const state = structuredClone(current);
  state.actionIntents = customerActionIntentsSchema.parse(state.actionIntents);
  const fence = state.snapshot.fence;
  if (event.type === "accepted_inbound") {
    if (state.lastAcceptedEventKey === event.eventKey && state.lastAcceptedOrder === event.order) {
      return { status: "same_event", state: current };
    }
    if (state.lastAcceptedOrder && BigInt(event.order) <= BigInt(state.lastAcceptedOrder)) {
      return { status: "stale", state: current };
    }
    state.lastAcceptedEventKey = event.eventKey;
    state.lastAcceptedOrder = event.order;
    if (event.publicState) state.snapshot.publicState = customerPublicStateSchema.parse(event.publicState);
  } else if (event.type === "intent") {
    const prior = state.actionIntents[event.kind];
    if (!state.lastAcceptedEventKey || !event.evidenceRefs.includes(state.lastAcceptedEventKey)) {
      return { status: "denied", state: current };
    }
    if (new Set(event.evidenceRefs).size !== event.evidenceRefs.length) return { status: "denied", state: current };
    // Replaying the same accepted customer event after a local commit must
    // never create a second generation/effect, even before an OUT is stamped.
    if (prior && sameEvidence(prior.evidenceRefs, event.evidenceRefs) && prior.status !== "open") {
      return { status: prior.commandDigest === event.commandDigest ? "same_event" : "denied", state: current };
    }
    if (prior && prior.commandDigest === event.commandDigest && sameEvidence(prior.evidenceRefs, event.evidenceRefs) &&
        (event.change === "cancel" ? prior.status === "cancelled" : event.change === "review" ? prior.status === "needs_review" : prior.status === "open")) return { status: "same_event", state: current };
    if (event.change === "cancel" && (!prior || prior.status === "cancelled")) return { status: "same_event", state: current };
    state.actionIntents[event.kind] = {
      generation: next(prior?.generation ?? "0"),
      status: event.change === "cancel" ? "cancelled" : event.change === "review" ? "needs_review" : "open",
      evidenceRefs: event.evidenceRefs,
      ...(event.commandDigest ? { commandDigest: event.commandDigest } : {}),
    };
    fence.intentRevision = next(fence.intentRevision);
  } else if (event.type === "callback_consent") {
    const proof = event.consent, prior = state.actionIntents.callback;
    if (proof.originalEventKey !== state.lastAcceptedEventKey || proof.originalOrder !== state.lastAcceptedOrder ||
        proof.nativeId !== fence.nativeId || proof.endpointScopeId !== fence.endpoint.endpointScopeId ||
        proof.accountId !== fence.endpoint.accountId || proof.ownershipEpoch !== fence.ownershipEpoch ||
        proof.bindingRevision !== fence.bindingRevision || proof.scopeRevision !== fence.scopeRevision ||
        proof.policyRevision !== fence.policyRevision || proof.ownerToken !== fence.ownerToken) return { status: "denied", state: current };
    if (prior?.consent?.originalEventKey === proof.originalEventKey) return { status: "same_event", state: current };
    state.actionIntents.callback = { generation: next(prior?.generation ?? "0"), status: "open",
      evidenceRefs: [proof.originalEventKey], consent: proof };
    fence.intentRevision = next(fence.intentRevision);
  } else if (event.type === "intent_evidence") {
    const prior = state.actionIntents.callback, proof = prior?.consent;
    if (!prior || prior.status !== "open" || prior.generation !== event.generation || !proof ||
        event.eventKey !== state.lastAcceptedEventKey || proof.nativeId !== fence.nativeId ||
        proof.endpointScopeId !== fence.endpoint.endpointScopeId || proof.accountId !== fence.endpoint.accountId ||
        proof.ownershipEpoch !== fence.ownershipEpoch || proof.bindingRevision !== fence.bindingRevision ||
        proof.scopeRevision !== fence.scopeRevision || proof.policyRevision !== fence.policyRevision ||
        proof.ownerToken !== fence.ownerToken) return { status: "stale", state: current };
    if (prior.evidenceRefs.includes(event.eventKey)) return { status: "same_event", state: current };
    if (prior.evidenceRefs.length >= 16) return { status: "denied", state: current };
    prior.evidenceRefs.push(event.eventKey);
  } else if (event.type === "intent_committed") {
    const prior = state.actionIntents[event.kind];
    if (!prior || prior.generation !== event.generation || (prior.status !== "open" && prior.status !== "committed")) return { status: "stale", state: current };
    if (prior.status === "committed") return { status: "same_event", state: current };
    prior.status = "committed";
  } else if (event.type === "owner") {
    if ((event.mode === "HUMAN") !== (event.agentId !== null)) return { status: "denied", state: current };
    if (state.snapshot.ownerMode === event.mode && state.snapshot.ownerAgentId === event.agentId &&
        fence.ownerToken === event.token && state.snapshot.ownerLeaseUntil === event.leaseUntil) return { status: "same_event", state: current };
    state.snapshot.ownerMode = event.mode;
    state.snapshot.ownerAgentId = event.agentId;
    state.snapshot.ownerLeaseUntil = event.leaseUntil;
    fence.ownerToken = event.token;
    fence.ownershipEpoch = next(fence.ownershipEpoch);
  } else {
    state.snapshot.closedAt = event.at;
    state.snapshot.ownerMode = "HOLD";
    state.snapshot.ownerAgentId = null;
    state.snapshot.ownerLeaseUntil = null;
    fence.ownerToken = null;
    fence.bindingRevision = next(fence.bindingRevision);
    fence.ownershipEpoch = next(fence.ownershipEpoch);
  }
  fence.stateRevision = next(fence.stateRevision);
  return { status: "applied", state };
}
