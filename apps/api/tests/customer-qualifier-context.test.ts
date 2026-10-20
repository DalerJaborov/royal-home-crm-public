import { beforeEach, describe, expect, it, vi } from "vitest";
import type { CustomerPropertyAdmission, CustomerStateSnapshot } from "@royal-home/shared";
import type { AuthenticatedCustomerInput } from "../src/lib/customerIngressAuthority.js";

// Unit seams only: the dedicated entry gets a consistent accepted frame,
// matching endpoint/source election, plannable IN witness, and pinned revision.
// Actual HMAC/WeakMap/DB proofs are exercised by principal/namespace/PG suites;
// these mocks cannot prove transport authority.
const fixture = vi.hoisted(() => ({ policy: vi.fn(), subject: vi.fn(), source: vi.fn(), resolveEndpoint: vi.fn(), transport: vi.fn(),
  plannable: vi.fn(), ticketRevision: vi.fn(), load: vi.fn(), revalidate: vi.fn(), phone: vi.fn(), extract: vi.fn(),
  frames: new Map<object, { channel: string; peer: string; inputText: string; acceptedFence?: object }>() }));
vi.mock("../src/db.js", async importOriginal => {
  const original = await importOriginal<typeof import("../src/db.js")>();
  return { ...original, prisma: { customerRuntimePolicy: { findUnique: fixture.policy },
    $transaction: (callback: (tx: unknown) => unknown) => callback({ customerPropertyIngressTicket: { findUnique: fixture.ticketRevision } }),
    $disconnect: () => original.prisma.$disconnect() } };
});
vi.mock("../src/ai/leadQualifier.js", async (importOriginal) => ({ ...(await importOriginal<typeof import("../src/ai/leadQualifier.js")>()), extractVolunteeredPhone: fixture.extract }));
vi.mock("../src/lib/customerIngressAuthority.js", async (importOriginal) => ({ ...(await importOriginal<typeof import("../src/lib/customerIngressAuthority.js")>()), inspectAuthenticatedCustomerInput: (value: object) => fixture.frames.get(value) ?? null }));
vi.mock("../src/lib/customerPrincipal.js", async (importOriginal) => ({ ...(await importOriginal<typeof import("../src/lib/customerPrincipal.js")>()), loadPublicCustomerPrincipal: fixture.load, revalidateCustomerPrincipal: fixture.revalidate }));
vi.mock("../src/lib/customerActionJournal.js", async (importOriginal) => ({ ...(await importOriginal<typeof import("../src/lib/customerActionJournal.js")>()), observeProtectedInquiryPhone: fixture.phone }));
vi.mock("../src/lib/customerAgentEnrollment.js", async importOriginal => ({ ...(await importOriginal<typeof import("../src/lib/customerAgentEnrollment.js")>()),
  readCustomerDmSubjectExecution: fixture.subject, readCustomerDmSourceExecution: fixture.source }));
vi.mock("../src/lib/customerConversationScope.js", async importOriginal => ({ ...(await importOriginal<typeof import("../src/lib/customerConversationScope.js")>()),
  resolveCustomerEndpoint: fixture.resolveEndpoint, loadCustomerTransportForConversation: fixture.transport }));
vi.mock("../src/lib/customerIngressInbox.js", async importOriginal => ({ ...(await importOriginal<typeof import("../src/lib/customerIngressInbox.js")>()),
  assertCustomerInboxPlannableTx: fixture.plannable }));
import { loadCustomerDmCoreQualifierLane, loadCustomerQualifierLane, refreshCustomerQualifierProjection, type ScopedCustomerQualifierLane } from "../src/lib/customerQualifierContext.js";

const principal = Object.freeze({ fixture: "opaque principal seam" });
const ticket = { eventKey: "event-A", conversationId: "native-A", order: "10", endpointScopeId: "scope-A", accountId: "account-A", scopeKey: "scope-key-A" } as CustomerPropertyAdmission;
let frame: AuthenticatedCustomerInput;
const state = { contractVersion: "scoped", rolloutMode: "ACTIVE", publicState: { topic: "buyer" } } as unknown as CustomerStateSnapshot;
const transport = { endpointScopeId: "scope-A", channel: "INSTAGRAM", accountId: "account-A", accountExternalId: "page-A",
  transportKey: "messenger-account:account-A", scopeRevision: "1" };
const coreExecution = { lane: "CORE" as const, assignment: null, revisionId: "revision-A" };
function input() { return { channel: "INSTAGRAM", subscriberId: "peer-A", customerAuthenticatedInput: frame,
  customerPropertyAdmission: { status: "admitted" as const, ticket } }; }
async function lane(): Promise<ScopedCustomerQualifierLane> {
  const value = await loadCustomerDmCoreQualifierLane({ authenticatedInput: frame, ticket });
  expect(value.mode).toBe("scoped");
  if (value.mode !== "scoped") throw new Error("Expected unit scoped projection");
  return value;
}
beforeEach(() => {
  vi.clearAllMocks(); fixture.frames.clear(); frame = Object.freeze({}) as AuthenticatedCustomerInput;
  fixture.frames.set(frame, { channel: "INSTAGRAM", peer: "peer-A", inputText: "Сколько стоит квартира?", acceptedFence: {
    nativeId: "native-A", endpoint: { endpointScopeId: "scope-A", channel: "INSTAGRAM", peerId: "peer-A", accountId: "account-A" }, scopeRevision: "1",
  } });
  fixture.policy.mockResolvedValue({ contractVersion: "scoped", rolloutMode: "ACTIVE" });
  fixture.subject.mockResolvedValue(null); fixture.source.mockResolvedValue(coreExecution);
  fixture.resolveEndpoint.mockImplementation(async (value: { channel: string; subscriberId: string }) => ({ ...transport, channel: value.channel, subscriberId: value.subscriberId }));
  fixture.transport.mockResolvedValue(transport);
  fixture.plannable.mockResolvedValue({ eventKey: ticket.eventKey, order: ticket.order });
  fixture.ticketRevision.mockResolvedValue({ intakeAgentRevisionId: "revision-A" });
  fixture.load.mockResolvedValue({ status: "public_only", principal });
  fixture.revalidate.mockResolvedValue({ status: "current", snapshot: { state,
    knownClientId: "PRIVATE-LEGACY-CLIENT", knownProfileId: "PRIVATE-LEGACY-PROFILE", claimedContact: "PRIVATE-PHONE" } });
  fixture.phone.mockResolvedValue({ status: "current", knownPhoneSource: "none" }); fixture.extract.mockReturnValue(null);
});

describe("scoped qualifier projection orchestration", () => {
  it.each(["OFF", "SHADOW"])("preserves an original LEGACY assignment while common rollout is %s", async rolloutMode => {
    fixture.policy.mockResolvedValue({ contractVersion: "scoped", rolloutMode });
    fixture.subject.mockResolvedValue({ lane: "LEGACY", assignment: null });
    expect(await loadCustomerQualifierLane(input())).toEqual({ mode: "legacy" }); expect(fixture.load).not.toHaveBeenCalled();
    expect(fixture.subject).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ endpointScopeId: "scope-A" }), "peer-A");
  });
  it("preserves compat and staff dispatch without looking up private memory", async () => {
    fixture.policy.mockResolvedValue({ contractVersion: "compat", rolloutMode: "ACTIVE" });
    expect(await loadCustomerQualifierLane(input())).toEqual({ mode: "legacy" });
    fixture.policy.mockRejectedValue(new Error("unavailable"));
    expect(await loadCustomerQualifierLane({ ...input(), fromStaff: true })).toEqual({ mode: "legacy" });
    expect(fixture.load).not.toHaveBeenCalled();
  });
  it("holds unavailable policy instead of falling back to legacy memory", async () => {
    fixture.policy.mockRejectedValue(new Error("offline"));
    expect((await loadCustomerQualifierLane(input())).mode).toBe("held"); expect(fixture.load).not.toHaveBeenCalled();
  });
  it("holds a customer JSON lookalike and an early unaccepted ticket", async () => {
    expect((await loadCustomerDmCoreQualifierLane({ authenticatedInput: { channel: "INSTAGRAM", acceptedFence: {} } as never, ticket })).mode).toBe("held");
    fixture.frames.set(frame, { channel: "INSTAGRAM", peer: "peer-A", inputText: "текст" });
    expect((await loadCustomerDmCoreQualifierLane({ authenticatedInput: frame, ticket })).mode).toBe("held"); expect(fixture.load).not.toHaveBeenCalled();
  });
  it("holds a different peer/channel before principal loading", async () => {
    fixture.frames.set(frame, { channel: "INSTAGRAM", peer: "peer-B", inputText: "Сколько стоит квартира?", acceptedFence: {
      nativeId: "native-A", endpoint: { endpointScopeId: "scope-A", channel: "INSTAGRAM", peerId: "peer-A", accountId: "account-A" }, scopeRevision: "1",
    } });
    expect((await loadCustomerDmCoreQualifierLane({ authenticatedInput: frame, ticket })).mode).toBe("held");
    fixture.frames.set(frame, { channel: "FACEBOOK", peer: "peer-A", inputText: "Сколько стоит квартира?", acceptedFence: {
      nativeId: "native-A", endpoint: { endpointScopeId: "scope-A", channel: "INSTAGRAM", peerId: "peer-A", accountId: "account-A" }, scopeRevision: "1",
    } });
    expect((await loadCustomerDmCoreQualifierLane({ authenticatedInput: frame, ticket })).mode).toBe("held");
    expect(fixture.load).not.toHaveBeenCalled();
    expect(fixture.transport).not.toHaveBeenCalled(); expect(fixture.source).not.toHaveBeenCalled();
  });
  it("holds a non-CORE source, missing plannable IN, or a changed intake revision", async () => {
    fixture.source.mockResolvedValue({ lane: "LEGACY", assignment: null });
    expect(await loadCustomerDmCoreQualifierLane({ authenticatedInput: frame, ticket })).toMatchObject({ mode: "held", reason: "original_core_source_required" });
    expect(fixture.load).not.toHaveBeenCalled();

    fixture.source.mockResolvedValue(coreExecution); fixture.plannable.mockResolvedValue(null);
    expect(await loadCustomerDmCoreQualifierLane({ authenticatedInput: frame, ticket })).toMatchObject({ mode: "held", reason: "original_context_changed" });
    fixture.plannable.mockResolvedValue({ eventKey: ticket.eventKey, order: ticket.order });
    fixture.ticketRevision.mockResolvedValue({ intakeAgentRevisionId: "revision-B" });
    expect(await loadCustomerDmCoreQualifierLane({ authenticatedInput: frame, ticket })).toMatchObject({ mode: "held", reason: "original_context_changed" });
  });
  it("projects only current canonical IN, empty draft and public state", async () => {
    const value = await lane();
    expect(value.context).toEqual({ mode: "scoped_customer", history: [{ role: "user", content: "Сколько стоит квартира?" }],
      draft: { stage: "chatting" }, knownPhoneSource: "none" });
    expect(JSON.stringify(value.context)).not.toContain("PRIVATE");
    value.publicState.topic = "seller";
    expect(state.publicState.topic).toBe("buyer");
  });
  it("revalidates the SAME original principal after phone observation", async () => {
    const value = await lane(); vi.clearAllMocks();
    fixture.revalidate.mockResolvedValueOnce({ status: "current" }).mockResolvedValueOnce({ status: "denied" });
    expect((await refreshCustomerQualifierProjection(value)).status).toBe("held");
    expect(fixture.revalidate.mock.calls).toEqual([[principal], [principal]]);
  });
  it("holds observer failure rather than adopting a fresh Client/history phone", async () => {
    fixture.phone.mockResolvedValue({ status: "held", reason: "state_or_namespace_changed" });
    expect((await loadCustomerDmCoreQualifierLane({ authenticatedInput: frame, ticket })).mode).toBe("held");
    expect(fixture.phone).toHaveBeenCalledWith(frame, ticket);
  });
  it("keeps strong current-envelope availability as a flag without exposing the phone", async () => {
    fixture.phone.mockResolvedValue({ status: "current", knownPhoneSource: "current_input" });
    const value = await lane(); expect(value.context.knownPhoneSource).toBe("current_input");
    expect(fixture.phone).toHaveBeenCalledWith(frame, ticket); expect(JSON.stringify(value.context)).not.toContain("PRIVATE");
  });
  it("does not count the public company telephone as a literal client phone", async () => {
    fixture.extract.mockReturnValue("+992446501414");
    expect((await lane()).context.knownPhoneSource).toBe("none");
    fixture.extract.mockReturnValue("+992900000009");
    expect((await lane()).context.knownPhoneSource).toBe("current_input");
  });
});
