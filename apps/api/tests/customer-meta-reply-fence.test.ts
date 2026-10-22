import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CustomerPrincipal } from "../src/lib/customerPrincipal.js";
import type { CustomerTransportReference } from "../src/lib/customerConversationScope.js";
// This suite isolates the existing principal fence, not the legacy ledger.
vi.mock("../src/lib/customerLegacyMetaPhysical.js", () => ({
  legacyMetaPhysicalTarget: () => undefined,
  legacyMetaPhysicalFetch: (_target: unknown, physical: () => Promise<Response>) => physical(),
}));
// Actual sendMessage/callGraph/fetchWithRetry order, with explicit fake DB,
// principal-store and HTTP seams. PG9 separately proves real owner invalidation;
// this suite does not claim a live Meta or database race.
const f = vi.hoisted(() => ({ settings: vi.fn(), bind: vi.fn(), admit: vi.fn(), beforeProperty: vi.fn(),
  revalidate: vi.fn(), fetch: vi.fn(), remember: vi.fn(), log: vi.fn(), sleep: vi.fn(),
  ownerMode: "BOT", stateRevision: "10" }));
vi.mock("../src/db.js", async importOriginal => {
  const original = await importOriginal<typeof import("../src/db.js")>();
  return { ...original, prisma: { settings: { findUnique: f.settings }, messengerAccount: { findFirst: async () => null },
    $disconnect: () => original.prisma.$disconnect() } };
});
vi.mock("../src/crypto.js", async (importOriginal) => ({ ...(await importOriginal<typeof import("../src/crypto.js")>()), decryptSecretSafe: (value: unknown) => typeof value === "string" ? value : null }));
vi.mock("../src/lib/systemError.js", async (importOriginal) => ({ ...(await importOriginal<typeof import("../src/lib/systemError.js")>()), logSystemError: f.log }));
vi.mock("../src/lib/outboundShield.js", async (importOriginal) => ({ ...(await importOriginal<typeof import("../src/lib/outboundShield.js")>()), admitOutbound: f.admit, OutboundBlockedError: class extends Error {} }));
vi.mock("../src/lib/customerMetaTransport.js", async (importOriginal) => ({ ...(await importOriginal<typeof import("../src/lib/customerMetaTransport.js")>()), bindCustomerMetaSendCredentials: f.bind, resolveLegacyMetaSendTransport: vi.fn() }));
vi.mock("../src/lib/customerPrincipal.js", async (importOriginal) => ({ ...(await importOriginal<typeof import("../src/lib/customerPrincipal.js")>()), revalidateCustomerPrincipal: f.revalidate }));
vi.mock("../src/lib/customerPropertyTransport.js", async (importOriginal) => ({ ...(await importOriginal<typeof import("../src/lib/customerPropertyTransport.js")>()), beforeCustomerPropertyPost: f.beforeProperty, customerPropertyProviderAccepted: vi.fn() }));
vi.mock("../src/lib/botTurnTrace.js", async (importOriginal) => ({ ...(await importOriginal<typeof import("../src/lib/botTurnTrace.js")>()), traceObserveSend: (_kind: unknown, _text: unknown, _origin: unknown, send: () => Promise<unknown>) => send(),
  traceProviderAccepted: vi.fn(), traceKnownSecrets: vi.fn() }));
vi.mock("../src/ai/geminiTransport.js", async (importOriginal) => ({ ...(await importOriginal<typeof import("../src/ai/geminiTransport.js")>()), GEMINI_RETRY_DELAYS_MS: [0], sleep: f.sleep }));
vi.mock("../src/messengers/outgoingMids.js", async (importOriginal) => ({ ...(await importOriginal<typeof import("../src/messengers/outgoingMids.js")>()), rememberOutgoingMid: f.remember }));
import { sendMessage } from "../src/messengers/meta.js";
import { CustomerReplyHeldError } from "../src/lib/customerReplyFence.js";

const transport: CustomerTransportReference = { channel: "WHATSAPP", accountId: null, accountExternalId: "fixture-phone",
  endpointScopeId: "fixture-scope", transportKey: "settings:WHATSAPP:fixture-phone", scopeRevision: "4" };
const principal = Object.freeze({ scope: { channel: "WHATSAPP", peer: "fixture-peer", accountId: null,
  endpointScopeId: "fixture-scope" }, authority: { fence: { scopeRevision: "4", stateRevision: "10" } } }) as unknown as CustomerPrincipal;
const credentials = { waPhoneId: "fixture-phone", waToken: "fixture-token" };
function revoke() { f.ownerMode = "HUMAN"; f.stateRevision = "11"; }
function send(value = principal, reference = transport) {
  return sendMessage("WHATSAPP", "fixture-peer", "Здравствуйте", undefined, { transport: reference, customerReplyPrincipal: value });
}
beforeEach(() => {
  vi.clearAllMocks(); f.ownerMode = "BOT"; f.stateRevision = "10";
  f.settings.mockResolvedValue({ metaWaPhoneId: credentials.waPhoneId, metaWaToken: credentials.waToken });
  f.bind.mockResolvedValue({ credentials, token: credentials.waToken }); f.admit.mockResolvedValue({ allowed: true });
  f.beforeProperty.mockResolvedValue(undefined); f.remember.mockResolvedValue(undefined); f.sleep.mockResolvedValue(undefined);
  f.revalidate.mockImplementation(async value => value === principal && f.ownerMode === "BOT" && f.stateRevision === "10"
    ? { status: "current", snapshot: {} } : { status: "denied" });
  f.fetch.mockResolvedValue(new Response(JSON.stringify({ messages: [{ id: "fixture-accepted-mid" }] }), { status: 200 }));
  vi.stubGlobal("fetch", f.fetch);
});
afterEach(() => vi.unstubAllGlobals());

describe("original scoped principal at the final Meta POST boundary", () => {
  it("positive control sends exactly one fake POST with the same valid principal/scope", async () => {
    expect(await send()).toBe("fixture-accepted-mid"); expect(f.fetch).toHaveBeenCalledTimes(1);
    const [url, request] = f.fetch.mock.calls[0]; expect(url).toContain("/fixture-phone/messages"); expect(request.method).toBe("POST");
    expect(JSON.parse(request.body).text.body).toBe("Здравствуйте");
    expect(f.revalidate).toHaveBeenCalledWith(principal); expect(f.remember).toHaveBeenCalledWith("fixture-accepted-mid");
  });
  it.each(["credentials", "bind", "shield", "property_hook"])("owner/state change during %s await produces zero POST and a typed hold", async stage => {
    const afterAwait = async () => { await Promise.resolve(); revoke(); };
    if (stage === "credentials") f.settings.mockImplementationOnce(async () => { await afterAwait(); return { metaWaPhoneId: "fixture-phone", metaWaToken: "fixture-token" }; });
    if (stage === "bind") f.bind.mockImplementationOnce(async () => { await afterAwait(); return { credentials, token: credentials.waToken }; });
    if (stage === "shield") f.admit.mockImplementationOnce(async () => { await afterAwait(); return { allowed: true }; });
    if (stage === "property_hook") f.beforeProperty.mockImplementationOnce(afterAwait);
    await expect(send()).rejects.toBeInstanceOf(CustomerReplyHeldError);
    expect(f.fetch).not.toHaveBeenCalled(); expect(f.remember).not.toHaveBeenCalled(); expect(f.log).not.toHaveBeenCalled();
    expect(f.revalidate).toHaveBeenCalledWith(principal);
  });
  it("rechecks the original principal after a safe not-sent DNS retry wait", async () => {
    f.fetch.mockRejectedValueOnce(Object.assign(new Error("synthetic not-sent DNS failure"), { code: "ENOTFOUND" }));
    f.sleep.mockImplementationOnce(async () => { await Promise.resolve(); revoke(); });
    await expect(send()).rejects.toBeInstanceOf(CustomerReplyHeldError);
    expect(f.fetch).toHaveBeenCalledTimes(1); expect(f.revalidate).toHaveBeenCalledTimes(2); expect(f.remember).not.toHaveBeenCalled();
  });
  it("a current principal cannot authorize another captured scope", async () => {
    await expect(send(principal, { ...transport, endpointScopeId: "foreign-scope" })).rejects.toBeInstanceOf(CustomerReplyHeldError);
    expect(f.fetch).not.toHaveBeenCalled();
  });
  it("does not turn a JSON lookalike into a current original principal", async () => {
    await expect(send(JSON.parse(JSON.stringify(principal)))).rejects.toBeInstanceOf(CustomerReplyHeldError);
    expect(f.fetch).not.toHaveBeenCalled();
  });
});
