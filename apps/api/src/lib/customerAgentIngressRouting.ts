// Original authenticated routing ownership, separate from execution authority.
// Routing ownership, never a FINAL-IN/principal/mutation/outbound grant.
import { isDeepStrictEqual } from "node:util";
import type { CustomerAgentEnrollmentSubject } from "@royal-home/shared";
import { prisma } from "../db.js";
import { authenticatedCustomerRequestEvidence, verifyMetaCustomerReferralTarget } from "./customerIngressAuthority.js";
import { normalizeAuthenticatedCustomerIngress, normalizeAuthenticatedMetaRoutingSubjects } from "./customerIngressNormalize.js";
import type { CustomerNormalizedIngressInput } from "./customerIngressPayload.js";
import { ensureCustomerEndpoint, type CustomerTransportReference } from "./customerConversationScope.js";
import { customerPropertyEventKey, customerPropertyScopeKey } from "./customerPropertyScope.js";
import { enrollCustomerAgentSubjectTx, readCustomerDmSourceExecution, type CustomerAgentExecution } from "./customerAgentEnrollment.js";
import { captureCustomerDmRouting, inspectCustomerDmRouting, type CustomerDmRoutingWitness, type CustomerUnkeyedRoutingInput } from "./customerAgentRoutingReference.js";
import { customerIngressPayloadHash } from "./customerIngressPayload.js";
import { findOriginalNativeMid, persistOriginalLegacySource } from "./customerOriginalSource.js";
export { inspectCustomerDmRouting, type CustomerDmRoutingWitness } from "./customerAgentRoutingReference.js";

type Request = object & { rawBody?: Buffer; aborted?: boolean; get(name: string): string | undefined };
type MetaEntry = CustomerNormalizedIngressInput & { channel: "INSTAGRAM" | "FACEBOOK" | "WHATSAPP" };
const requestData = new WeakMap<object, { raw: Buffer; signature: string | undefined; witnesses: readonly CustomerDmRoutingWitness[] }>();
const key = (value: Pick<CustomerNormalizedIngressInput, "channel" | "peer" | "accountExternalId" | "eventKind"> & { eventId?: string }) =>
  JSON.stringify([value.channel, value.peer, value.accountExternalId ?? null, value.eventKind, value.eventId ?? null]);
function requestCurrent(request: Request, original: { raw: Buffer; signature: string | undefined }): boolean {
  return !request.aborted && request.rawBody?.equals(original.raw) === true &&
    request.get("x-hub-signature-256") === original.signature &&
    authenticatedCustomerRequestEvidence(request)?.provenance === "meta_signature";
}
/** Resolves only the same original server request/parser tuple. A lookalike
 * object, arbitrary MID, client body lane or copied JSON never obtains a witness.
 * This is routing evidence only; FINAL echo/staff classification remains real. */
export function customerDmRoutingForIncoming(request: Request, message: {
  channel: string; senderId: string; accountExternalId?: string; messageId?: string; payload?: string;
}): CustomerDmRoutingWitness | null {
  const batch = requestData.get(request);
  if (!batch || !requestCurrent(request, batch)) return null;
  const expected = JSON.stringify([message.channel, message.senderId, message.accountExternalId ?? null,
    message.payload ? "postback" : "message", message.messageId ?? null]);
  const found = batch.witnesses.filter(w => key(inspectCustomerDmRouting(w)!.input) === expected);
  return found.length === 1 ? found[0] : null;
}

/** Actual bounded RAW producer stage BEFORE OFF bypass and ALL legacy async
 * enrichment/funnel/model work. Persisting LEGACY while OFF closes activation
 * races without claiming any customer authority. No new native is created.
 * Caller must keep CORE/HELD out of the legacy controller by construction.
 * This leaf intentionally does not manufacture Website/TG/YT/voice namespaces. */
export async function prepareVerifiedCustomerDmRouting(request: Request): Promise<
  { status: "current"; witnesses: readonly CustomerDmRoutingWitness[]; unsupported: number } |
  { status: "not_applicable" } | { status: "held"; reason: string }
> {
  const evidence = authenticatedCustomerRequestEvidence(request);
  if (evidence?.provenance !== "meta_signature") return { status: "not_applicable" };
  if (!request.rawBody || request.aborted) return { status: "held", reason: "routing_raw_request_missing" };
  const original = { raw: Buffer.from(request.rawBody), signature: request.get("x-hub-signature-256") };
  let normalized: ReturnType<typeof normalizeAuthenticatedCustomerIngress>;
  try { normalized = normalizeAuthenticatedCustomerIngress(request); }
  catch { return { status: "held", reason: "routing_normalization_unavailable" }; }
  const keyed = normalized.entries.filter((entry): entry is MetaEntry =>
    ["INSTAGRAM", "FACEBOOK", "WHATSAPP"].includes(entry.channel) && !entry.observations.providerEcho &&
    !entry.observations.referralOnly && entry.observations.classifier?.bareTemplateEcho !== true);
  if (new Set(keyed.map(key)).size !== keyed.length) return { status: "held", reason: "routing_source_ambiguous" };
  let rawSubjects: ReturnType<typeof normalizeAuthenticatedMetaRoutingSubjects>;
  try { rawSubjects = normalizeAuthenticatedMetaRoutingSubjects(request); }
  catch { return { status: "held", reason: "routing_normalization_unavailable" }; }
  // Missing MID cannot get a fake event/ticket. Its genuine raw namespace can
  // still persist a LEGACY subject before async work, closing activation races.
  const unkeyed = [...new Map(rawSubjects.filter(row => !row.eventId).map(row => [key(row), {
    channel: row.channel, peer: row.peer, accountExternalId: row.accountExternalId, eventKind: row.eventKind,
  }])).values()];
  const inputs: Array<MetaEntry | CustomerUnkeyedRoutingInput> = [...keyed, ...unkeyed];
  if (!inputs.length) return { status: "not_applicable" };
  const prior = requestData.get(request);
  if (prior) return requestCurrent(request, prior)
    ? { status: "current", witnesses: prior.witnesses, unsupported: normalized.unsupported }
    : { status: "held", reason: "routing_request_changed" };
  try {
    const prepared: Array<{ input: MetaEntry | CustomerUnkeyedRoutingInput; transport: CustomerTransportReference; subject: Extract<CustomerAgentEnrollmentSubject, { surface: "dm" }> }> = [];
    for (const input of inputs) {
      const target = { channel: input.channel, peer: input.peer, accountExternalId: input.accountExternalId };
      if (!requestCurrent(request, original) || !await verifyMetaCustomerReferralTarget(request, target)) {
        return { status: "held", reason: "routing_target_not_verified" };
      }
      // Registration transaction precedes metadata/source locks, matching the
      // existing real RAW producer. No body account UUID/default account.
      const endpoint = await prisma.$transaction(tx => ensureCustomerEndpoint(tx, { channel: input.channel,
        subscriberId: input.peer, accountExternalId: input.accountExternalId }));
      if (!requestCurrent(request, original) || !await verifyMetaCustomerReferralTarget(request, target)) {
        return { status: "held", reason: "routing_target_changed" };
      }
      const transport = Object.freeze({ endpointScopeId: endpoint.endpointScopeId, channel: endpoint.channel,
        accountId: endpoint.accountId, accountExternalId: endpoint.accountExternalId,
        transportKey: endpoint.transportKey, scopeRevision: endpoint.scopeRevision });
      prepared.push({ input: structuredClone(input), transport,
        subject: { surface: "dm", endpoint: { endpointScopeId: transport.endpointScopeId, channel: input.channel,
          accountId: transport.accountId, scopeRevision: transport.scopeRevision, transportKey: transport.transportKey }, peer: input.peer } });
    }
    // Separate bounded TX, deterministic scope/subject ordering. It releases
    // policy/scope locks before the later DM source or public source commit.
    const sorted = [...prepared].sort((a, b) => a.transport.endpointScopeId.localeCompare(b.transport.endpointScopeId) || key(a.input).localeCompare(key(b.input)));
    const witnesses: CustomerDmRoutingWitness[] = [];
    for (const item of sorted) {
      if (!requestCurrent(request, original)) return { status: "held", reason: "routing_request_changed" };
      const { input, transport, subject } = item;
      const scopeKey = customerPropertyScopeKey(input.channel, input.peer, transport.accountId, transport.endpointScopeId);
      const eventKey = input.eventId ? customerPropertyEventKey(scopeKey, input.eventKind, input.eventId) : null;
      const selected = await prisma.$transaction(async tx => {
        // Namespace lock precedes source/native locks, including the history
        // guard that intentionally does not create an enrollment assignment.
        const scopes = await tx.$queryRaw<Array<{ id: string }>>`SELECT "id" FROM "CustomerEndpointScope"
          WHERE "id"=${transport.endpointScopeId} AND "kind"='NORMAL' AND "realmKey"='royal-home'
            AND "channel"=${transport.channel} AND "messengerAccountId" IS NOT DISTINCT FROM ${transport.accountId}
            AND "transportKey"=${transport.transportKey} AND "scopeRevision"=${BigInt(transport.scopeRevision)} FOR SHARE`;
        if (scopes.length !== 1) return { execution: { lane: "HELD" as const, reason: "captured_scope_changed" } };
        const source = eventKey && input.eventId ? await readCustomerDmSourceExecution(tx, eventKey, scopeKey, subject, customerIngressPayloadHash(input)) : null;
        // Historical source ownership never changes with a new rollout. For
        // old LEGACY without an assignment, also persist the subject baseline.
        if (source?.lane === "CORE" || source?.lane === "HELD") return { execution: source };
        if (!source && eventKey && input.eventId) {
          const nativeHistoryId = await findOriginalNativeMid(tx, input, transport);
          if (nativeHistoryId) {
            await persistOriginalLegacySource(tx, { input, transport, eventKey, scopeKey, assignmentId: null,
              nativeHistoryId, receivedAt: evidence.issuedAt });
            return { execution: { lane: "HELD" as const, reason: "original_native_source_already_observed" } };
          }
        }
        const enrolled = await enrollCustomerAgentSubjectTx(tx, subject, input.eventId ? {} : { legacyOnly: true });
        if (!eventKey && enrolled.lane === "CORE") return { execution: { lane: "HELD" as const, reason: "unkeyed_core_input_unsupported" } };
        if (source?.lane === "LEGACY") return { execution: enrolled.lane === "LEGACY" ? source : { lane: "HELD" as const, reason: "historical_legacy_selection_conflict" } };
        if (enrolled.lane === "LEGACY" && eventKey && input.eventId) {
          await persistOriginalLegacySource(tx, { input, transport, eventKey, scopeKey,
            assignmentId: enrolled.assignment?.id ?? null, receivedAt: evidence.issuedAt });
          return { execution: enrolled };
        }
        return { execution: enrolled };
      }, { maxWait: 5000, timeout: 10000 });
      const witness = captureCustomerDmRouting({ input, transport, scopeKey, eventKey, ...selected });
      witnesses.push(witness);
    }
    // Prevent caller mutations and awaited signing/config changes from being
    // accepted as this request's original normalized event membership.
    if (!requestCurrent(request, original) || !isDeepStrictEqual(normalizeAuthenticatedCustomerIngress(request), normalized)) {
      return { status: "held", reason: "routing_request_changed" };
    }
    const batch = { ...original, witnesses: Object.freeze(witnesses) };
    requestData.set(request, batch);
    return { status: "current", witnesses: batch.witnesses, unsupported: normalized.unsupported };
  } catch { return { status: "held", reason: "routing_persistence_unavailable" }; }
}
