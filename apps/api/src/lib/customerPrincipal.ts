import { createHash } from "node:crypto";
import { z } from "zod";
import { customerPropertyAdmissionSchema, customerToolAdmissionReferenceSchema, customerStateSchema, type CustomerToolAdmissionReference, type CustomerStateSnapshot, type CustomerFence } from "@royal-home/shared";
import { prisma } from "../db.js";
import { customerPropertyScopeKey, customerPropertyEventKey } from "./customerPropertyScope.js";
import { loadCustomerTransportForConversation, type CustomerTransportReference } from "./customerConversationScope.js";
import { authenticatedInputMatchesFence, inspectAuthenticatedCustomerInput, type AuthenticatedCustomerInput } from "./customerIngressAuthority.js";
import { loadAcceptedCustomerState, assertCustomerFence, type CustomerFenceResult } from "./customerState.js";

const inputSchema = z.object({
  admission: customerPropertyAdmissionSchema,
  visibility: z.enum(["private_dm", "website_chat"]),
  authenticatedInput: z.unknown(),
}).strict();

/** Read-only adapter. No recognition, healing, linking, phone lookup or creation. */
export interface CustomerPrincipalSnapshot {
  reference: CustomerToolAdmissionReference;
  peer: string;
  account: { id: string; channel: string; enabled: boolean; externalIds: string[] } | null;
  transport?: CustomerTransportReference;
  knownClientId: string | null;
  knownProfileId: string | null;
  clientDeleted: boolean;
  profileMerged: boolean;
  optedOut: boolean;
  pausedUntil: Date | null;
  propertyChatAgentId: string | null;
  outputRecorded: boolean;
  focus: unknown;
  focusRevision: number;
  state: CustomerStateSnapshot;
}
export interface CustomerPrincipalStore {
  read(eventKey: string): Promise<CustomerPrincipalSnapshot | null>;
  assertReadFence(fence: CustomerFence): Promise<CustomerFenceResult>;
}

const defaultStore: CustomerPrincipalStore = {
  async read(eventKey) {
    const row = await prisma.customerPropertyIngressTicket.findUnique({ where: { eventKey }, select: {
      eventKey: true, order: true, scopeKey: true, conversationId: true, originalConversationId: true, tombstonedAt: true,
      endpointScopeId: true, managedOutputRecordedAt: true,
      conversation: { select: {
        channel: true, subscriberId: true, accountId: true, clientId: true, contactProfileId: true,
        optedOutAt: true, pausedUntil: true, propertyChatAgentId: true,
        customerPropertyFocus: true, customerPropertyFocusRevision: true,
        account: { select: { id: true, channel: true, enabled: true, externalId: true, messagingId: true, extraExternalIds: true } },
        client: { select: { deletedAt: true } }, contactProfile: { select: { mergedIntoId: true } },
      } },
    } });
    if (!row?.conversationId || !row.conversation || row.tombstonedAt ||
        (row.originalConversationId && row.originalConversationId !== row.conversationId)) return null;
    const conversation = row.conversation;
    const reference = customerToolAdmissionReferenceSchema.safeParse({
      eventKey: row.eventKey, order: row.order.toString(), scopeKey: row.scopeKey,
      conversationId: row.conversationId, channel: conversation.channel, accountId: conversation.accountId,
      ...(row.endpointScopeId ? { endpointScopeId: row.endpointScopeId } : {}),
    });
    if (!reference.success) return null;
    const state = await loadAcceptedCustomerState(reference.data);
    if (!state) return null;
    const transport = await loadCustomerTransportForConversation(row.conversationId);
    if (!transport) return null;
    const account = conversation.account;
    return { reference: reference.data, peer: conversation.subscriberId, transport,
      account: account ? { id: account.id, channel: account.channel, enabled: account.enabled,
        externalIds: [account.externalId, account.messagingId, ...account.extraExternalIds].filter((value): value is string => typeof value === "string" && value.length > 0) } : null,
      knownClientId: conversation.clientId, knownProfileId: conversation.contactProfileId,
      clientDeleted: !!conversation.client?.deletedAt, profileMerged: !!conversation.contactProfile?.mergedIntoId,
      optedOut: !!conversation.optedOutAt, pausedUntil: conversation.pausedUntil,
      propertyChatAgentId: conversation.propertyChatAgentId, outputRecorded: !!row.managedOutputRecordedAt,
      focus: conversation.customerPropertyFocus, focusRevision: conversation.customerPropertyFocusRevision, state };
  },
  assertReadFence: (fence) => assertCustomerFence(prisma, fence, "public_read"),
};

declare const principalBrand: unique symbol;
export type CustomerPrincipal = Readonly<{
  version: 1;
  scope: Readonly<{ channel: CustomerToolAdmissionReference["channel"]; accountId: string | null; peer: string; conversationId: string; scopeKey: string; endpointScopeId: string }>;
  admission: Readonly<CustomerToolAdmissionReference>;
  visibility: "private_dm" | "website_chat";
  knownContact: Readonly<{ clientId: string | null; contactProfileId: string | null }>;
  /** Ticket authenticity/order is not an endpoint-control or private-resource proof. */
  provenance: "meta_signature" | "website_application_key";
  /** public_envelope is enough only for this closed public-read registry. */
  assurance: "protected_namespace" | "public_envelope" | "website_public_input";
  privateAuthorization: "none";
  /** Purpose-specific public fence, never the opaque P06 write authority. */
  authority: Readonly<{ purpose: "public_read"; fence: Readonly<CustomerFence> }>;
  bindingFingerprint: string;
}> & { readonly [principalBrand]: true };

interface IssuedPrincipal { store: CustomerPrincipalStore; authenticatedInput: AuthenticatedCustomerInput }
const issued = new WeakMap<object, IssuedPrincipal>();
export type CustomerPrincipalLoadResult =
  | { status: "public_only"; principal: CustomerPrincipal }
  | { status: "denied"; reason: "invalid_context" | "scope_mismatch" | "scope_blocked" }
  | { status: "unavailable"; reason: "storage_unavailable" };

function bindingFingerprint(snapshot: CustomerPrincipalSnapshot): string {
  return createHash("sha256").update(JSON.stringify([
    snapshot.reference, snapshot.peer, snapshot.account, snapshot.transport, snapshot.knownClientId, snapshot.knownProfileId,
    snapshot.clientDeleted, snapshot.profileMerged, snapshot.optedOut, snapshot.pausedUntil?.toISOString(),
    snapshot.propertyChatAgentId, snapshot.outputRecorded,
    snapshot.state.fence, snapshot.state.ownerMode, snapshot.state.closedAt, snapshot.state.ownerLeaseUntil,
    snapshot.state.rolloutMode, snapshot.state.contractVersion, snapshot.state.capabilities,
  ])).digest("hex");
}
function validSnapshot(reference: CustomerToolAdmissionReference, snapshot: CustomerPrincipalSnapshot): boolean {
  const state = customerStateSchema.safeParse(snapshot.state);
  if (!state.success || state.data.fence.nativeId !== reference.conversationId ||
    state.data.fence.endpoint.channel !== reference.channel || state.data.fence.endpoint.accountId !== reference.accountId ||
    state.data.fence.endpoint.peerId !== snapshot.peer || state.data.fence.endpoint.threadId !== "" ||
    reference.endpointScopeId && reference.endpointScopeId !== state.data.fence.endpoint.endpointScopeId) return false;
  const endpoint = state.data.fence.endpoint;
  if (snapshot.transport && (snapshot.transport.endpointScopeId !== endpoint.endpointScopeId || snapshot.transport.channel !== endpoint.channel ||
    snapshot.transport.accountId !== endpoint.accountId || snapshot.transport.scopeRevision !== state.data.fence.scopeRevision)) return false;
  if (snapshot.reference.eventKey !== reference.eventKey || snapshot.reference.order !== reference.order ||
    snapshot.reference.conversationId !== reference.conversationId || snapshot.reference.scopeKey !== reference.scopeKey ||
    snapshot.reference.channel !== reference.channel || snapshot.reference.accountId !== reference.accountId ||
    snapshot.reference.endpointScopeId !== reference.endpointScopeId ||
    customerPropertyScopeKey(reference.channel, snapshot.peer, reference.accountId, endpoint.endpointScopeId) !== reference.scopeKey) return false;
  if (reference.channel === "WEBSITE") return reference.accountId === null && snapshot.account === null;
  if (reference.accountId !== null) return snapshot.account?.id === reference.accountId && snapshot.account.channel === reference.channel && snapshot.account.enabled;
  return snapshot.account === null && !!snapshot.transport?.accountExternalId && snapshot.transport.transportKey === `settings:${reference.channel}:${snapshot.transport.accountExternalId}`;
}
function inputMatches(reference: CustomerToolAdmissionReference, snapshot: CustomerPrincipalSnapshot, input: unknown): boolean {
  const evidence = inspectAuthenticatedCustomerInput(input);
  if (!evidence || evidence.channel !== reference.channel || evidence.peer !== snapshot.peer ||
    !authenticatedInputMatchesFence(input as AuthenticatedCustomerInput, snapshot.state.fence)) return false;
  if (evidence.channel === "WEBSITE") {
    if (evidence.assurance !== "website_public_input" || evidence.accountExternalId) return false;
  } else {
    if (!["protected_namespace", "public_envelope"].includes(evidence.assurance) || evidence.issuerAccountId !== reference.accountId ||
      evidence.issuerEndpointScopeId !== snapshot.state.fence.endpoint.endpointScopeId || !evidence.accountExternalId ||
      (reference.accountId !== null ? !snapshot.account?.externalIds.includes(evidence.accountExternalId) :
        snapshot.transport?.accountExternalId !== evidence.accountExternalId)) return false;
  }
  return customerPropertyEventKey(reference.scopeKey, evidence.eventKind, evidence.eventId) === reference.eventKey;
}
function immutablePublicFence(fence: CustomerFence): Readonly<CustomerFence> {
  return Object.freeze({ ...fence, endpoint: Object.freeze({ ...fence.endpoint }) });
}

/** Caller supplies a server-owned admission, never the model's JSON arguments.
 * DB binding is validated; signature/Client authority is deliberately not inferred. */
export async function loadPublicCustomerPrincipal(input: unknown, store: CustomerPrincipalStore = defaultStore): Promise<CustomerPrincipalLoadResult> {
  const parsed = inputSchema.safeParse(input);
  const evidence = parsed.success ? inspectAuthenticatedCustomerInput(parsed.data.authenticatedInput) : null;
  if (!parsed.success || !evidence || evidence.channel !== parsed.data.admission.channel ||
    (parsed.data.admission.channel === "WEBSITE") !== (parsed.data.visibility === "website_chat")) {
    return { status: "denied", reason: "invalid_context" };
  }
  const { evidence: _unusedEvidence, ...reference } = parsed.data.admission;
  try {
    const snapshot = await store.read(reference.eventKey);
    if (!snapshot || !validSnapshot(reference, snapshot) || !inputMatches(reference, snapshot, parsed.data.authenticatedInput)) return { status: "denied", reason: "scope_mismatch" };
    if (snapshot.clientDeleted || snapshot.profileMerged || snapshot.optedOut || snapshot.outputRecorded ||
      (snapshot.pausedUntil && snapshot.pausedUntil.getTime() > Date.now())) return { status: "denied", reason: "scope_blocked" };
    const fence = await store.assertReadFence(snapshot.state.fence);
    if (fence.status !== "current" || JSON.stringify(fence.snapshot.fence) !== JSON.stringify(snapshot.state.fence)) return { status: "denied", reason: "scope_blocked" };
    const principal = Object.freeze({ version: 1 as const,
      scope: Object.freeze({ channel: reference.channel, accountId: reference.accountId, peer: snapshot.peer, conversationId: reference.conversationId, scopeKey: reference.scopeKey,
        endpointScopeId: snapshot.state.fence.endpoint.endpointScopeId }),
      admission: Object.freeze(reference), visibility: parsed.data.visibility,
      knownContact: Object.freeze({ clientId: snapshot.knownClientId, contactProfileId: snapshot.knownProfileId }),
      provenance: evidence.provenance, assurance: evidence.assurance, privateAuthorization: "none" as const,
      authority: Object.freeze({ purpose: "public_read" as const, fence: immutablePublicFence(snapshot.state.fence) }),
      bindingFingerprint: bindingFingerprint(snapshot),
    }) as CustomerPrincipal;
    issued.set(principal, { store, authenticatedInput: parsed.data.authenticatedInput as AuthenticatedCustomerInput });
    return { status: "public_only", principal };
  } catch {
    return { status: "unavailable", reason: "storage_unavailable" };
  }
}

export function isCustomerPrincipal(value: unknown): value is CustomerPrincipal {
  return typeof value === "object" && value !== null && issued.has(value);
}
/** Server-only retained frame for P11/P12 proof checks. A serialized principal
 * cannot recover this frame or mint a new authority. */
export function customerPrincipalAuthenticatedInput(value: unknown): AuthenticatedCustomerInput | null {
  return value && typeof value === "object" ? issued.get(value)?.authenticatedInput ?? null : null;
}
/** Recheck canonical accepted input and real P07 revisions for public reads.
 * This does not mint private permissions, write authority, or atomic OUT. */
export async function revalidateCustomerPrincipal(principal: CustomerPrincipal): Promise<
  { status: "current"; snapshot: CustomerPrincipalSnapshot } | { status: "denied" } | { status: "unavailable" }
> {
  const registered = issued.get(principal);
  if (!registered) return { status: "denied" };
  try {
    const current = await registered.store.read(principal.admission.eventKey);
    if (!current || !validSnapshot(principal.admission, current) || !inputMatches(principal.admission, current, registered.authenticatedInput) ||
        bindingFingerprint(current) !== principal.bindingFingerprint ||
        current.clientDeleted || current.profileMerged || current.optedOut || current.outputRecorded ||
        (current.pausedUntil && current.pausedUntil.getTime() > Date.now())) return { status: "denied" };
    const fence = await registered.store.assertReadFence(principal.authority.fence);
    if (fence.status !== "current" || JSON.stringify(fence.snapshot.fence) !== JSON.stringify(principal.authority.fence)) return { status: "denied" };
    return { status: "current", snapshot: current };
  } catch {
    return { status: "unavailable" };
  }
}
