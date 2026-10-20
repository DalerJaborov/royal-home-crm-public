import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { TxClient } from "../src/db.js";
import { classifyCustomerPendingFrame, readRecoveryOwnIdentities } from "../src/lib/customerIngressClassification.js";
import { encryptCustomerSenderObservation, decryptCustomerSenderObservation, type CustomerSenderObservationContext } from "../src/lib/customerSenderObservation.js";
import { readRecoveryInstagramUsername } from "../src/lib/customerInstagramSenderRead.js";
import type { CustomerNormalizedIngressInput, CustomerPendingVerification } from "../src/lib/customerIngressPayload.js";

afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); vi.useRealTimers(); });
function fixture() {
  const payload: CustomerNormalizedIngressInput = { version: 1, channel: "INSTAGRAM", peer: "synthetic-peer", accountExternalId: "synthetic-account",
    eventKind: "message", eventId: "synthetic-mid", inputText: "Нарх?", source: { path: "$.entry[0].messaging[0]", frameHash: "a".repeat(64) },
    observations: { providerEcho: false, referralOnly: false, classifier: { version: 1, bareTemplateEcho: false } }, media: [], propertyEvidence: [] };
  const verification: CustomerPendingVerification = { version: 1, classification: "PENDING_ENVELOPE", provenance: "meta_signature", assurance: "public_envelope",
    issuerSource: "verified_public_envelope", accountId: randomUUID(), endpointScopeId: randomUUID(), scopeRevision: "1", policyRevision: "2",
    issuedAt: Date.now(), source: payload.source, verifierCredential: { source: "account_app_secret", sourceId: randomUUID(), fingerprint: "b".repeat(64) } };
  let history: unknown[] = [], ambiguous = false;
  // SQL-only classifier double, not an accepted input/principal or a permission mock.
  const query = vi.fn(async (sql: unknown, ..._values: unknown[]) => {
    const text = Array.isArray(sql) ? sql.join("?") : String(sql);
    if (text.includes('FROM "MessengerAccount"')) return [{ id: verification.accountId, channel: "INSTAGRAM", username: "synthetic_own", externalId: "synthetic-account", messagingId: null, extraExternalIds: [] }];
    if (text.includes('FROM "Settings"')) return [{ pageId: null, waId: null }];
    if (text.includes('FROM "Agent"')) return [];
    if (text.includes("SELECT EXISTS") && text.includes('FROM "CustomerOutboxPart"')) return [{ exists: ambiguous }];
    if (text.includes('FROM "CustomerDeliveryAttempt"')) return [];
    if (text.includes('FROM "BotConversation"')) return history.length ? [{ messages: history }] : [];
    if (text.includes('FROM "ProcessedMessage"')) return [];
    throw new Error("Unexpected classifier SQL");
  });
  const db = { $queryRaw: query } as unknown as Pick<TxClient, "$queryRaw">;
  return { payload, verification, query, db, history: (value: unknown[]) => { history = value; }, ambiguous: () => { ambiguous = true; } };
}
describe("actual-observation pending classifier", () => {
  it("missing historical bare-template observation is unknown, not a fabricated false", async () => {
    const f = fixture(); delete f.payload.observations.classifier;
    expect(await classifyCustomerPendingFrame(f.db, f.payload, f.verification)).toMatchObject({ status: "held", reason: "old_classification_unavailable" });
    expect(f.query).not.toHaveBeenCalled();
  });
  it.each(["providerEcho", "referralOnly"] as const)("captured %s never creates customer eligibility", async key => {
    const f = fixture(); f.payload.observations[key] = true;
    expect((await classifyCustomerPendingFrame(f.db, f.payload, f.verification)).status).toBe("ignored"); expect(f.query).not.toHaveBeenCalled();
  });
  it("captured template echo is ignored without a profile lookup", async () => {
    const f = fixture(); f.payload.observations.classifier!.bareTemplateEcho = true;
    expect(await classifyCustomerPendingFrame(f.db, f.payload, f.verification)).toEqual({ status: "ignored", reason: "bare_template" });
  });
  it("missing IGSID username observation holds; attested non-own permits classification only", async () => {
    const f = fixture(), identities = await readRecoveryOwnIdentities(f.db);
    expect(await classifyCustomerPendingFrame(f.db, f.payload, f.verification)).toMatchObject({ status: "held", reason: "own_identity_required" });
    expect(await classifyCustomerPendingFrame(f.db, f.payload, f.verification, { username: "synthetic_customer", ownIdentitiesHash: identities.hash })).toEqual({ status: "eligible" });
    expect(await classifyCustomerPendingFrame(f.db, f.payload, f.verification, { username: "synthetic_own", ownIdentitiesHash: identities.hash })).toEqual({ status: "ignored", reason: "own_account" });
  });
  it("an actual unknown send never becomes a customer IN from absence of RAM", async () => {
    const f = fixture(); f.ambiguous();
    expect(await classifyCustomerPendingFrame(f.db, f.payload, f.verification)).toMatchObject({ status: "held", reason: "delivery_ambiguous" });
  });
  it("echo matching uses original arrival, not later worker-start or future history", async () => {
    const f = fixture(); f.payload.channel = "FACEBOOK";
    f.history([{ role: "assistant", by: { kind: "bot" }, content: f.payload.inputText, at: new Date(f.verification.issuedAt - 1000).toISOString() }]);
    expect(await classifyCustomerPendingFrame(f.db, f.payload, f.verification)).toMatchObject({ status: "held", reason: "history_ambiguous" });
    f.history([{ role: "assistant", by: { kind: "bot" }, content: f.payload.inputText, at: new Date(f.verification.issuedAt + 1000).toISOString() }]);
    expect(await classifyCustomerPendingFrame(f.db, f.payload, f.verification)).toEqual({ status: "eligible" });
  });
  it("database failure is not an empty identity/outgoing registry", async () => {
    const f = fixture(); f.query.mockRejectedValueOnce(new Error("Synthetic DB failure"));
    await expect(classifyCustomerPendingFrame(f.db, f.payload, f.verification)).rejects.toThrow("Synthetic DB failure");
  });
});

describe("bounded real-profile transport shape and encrypted sidecar", () => {
  it("uses only exact existing username GET with captured token, no second request", async () => {
    vi.stubEnv("IG_PROXY_URL", ""); vi.stubEnv("GEMINI_PROXY_URL", "");
    const fetch = vi.fn(async () => new Response(JSON.stringify({ id: "synthetic-peer", username: "synthetic_customer" })));
    vi.stubGlobal("fetch", fetch);
    expect(await readRecoveryInstagramUsername("synthetic-peer", "synthetic-token", Date.now())).toBe("synthetic_customer");
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(fetch).toHaveBeenCalledWith("https://graph.instagram.com/v23.0/synthetic-peer?fields=username", expect.objectContaining({ method: "GET", headers: { Authorization: "Bearer synthetic-token" }, redirect: "error" }));
  });
  it("a hung GET is bounded even if the fetch double ignores AbortSignal", async () => {
    vi.useFakeTimers(); const fetch = vi.fn(() => new Promise<Response>(() => {})); vi.stubGlobal("fetch", fetch);
    const pending = readRecoveryInstagramUsername("synthetic-peer", "synthetic-token", Date.now());
    await vi.advanceTimersByTimeAsync(2501); expect(await pending).toBeNull(); expect(fetch).toHaveBeenCalledTimes(1);
  });
  it("wrong identity and unbounded body do not establish not-own", async () => {
    const fetch = vi.fn(async () => new Response(JSON.stringify({ id: "another-peer", username: "synthetic_customer" })));
    vi.stubGlobal("fetch", fetch);
    expect(await readRecoveryInstagramUsername("synthetic-peer", "synthetic-token", Date.now())).toBeNull();
    fetch.mockResolvedValueOnce(new Response("x".repeat(17_000)));
    expect(await readRecoveryInstagramUsername("synthetic-peer", "synthetic-token", Date.now())).toBeNull();
  });
  it("AEAD sidecar is exact event/epoch/token/registry/age bound, never plaintext proof", () => {
    vi.stubEnv("SETTINGS_ENCRYPTION_KEY", "1".repeat(64));
    const f = fixture();
    const context: CustomerSenderObservationContext = { version: 1, source: "instagram_username_get", eventKey: "a".repeat(64), order: "1", payloadHash: "b".repeat(64),
      channel: "INSTAGRAM", peer: f.payload.peer, accountId: f.verification.accountId!, endpointScopeId: f.verification.endpointScopeId,
      scopeRevision: "1", policyRevision: "2", receivedAt: f.verification.issuedAt, signingCredential: f.verification.verifierCredential!,
      accountTokenFingerprint: "c".repeat(64), ownIdentitiesHash: "d".repeat(64) };
    const ciphertext = encryptCustomerSenderObservation(context, "synthetic_customer", Date.now());
    expect(ciphertext).not.toContain("synthetic_customer");
    expect(decryptCustomerSenderObservation(context, ciphertext).username).toBe("synthetic_customer");
    for (const delta of [{ order: "2" }, { policyRevision: "3" }, { accountTokenFingerprint: "e".repeat(64) }, { ownIdentitiesHash: "f".repeat(64) }]) {
      expect(() => decryptCustomerSenderObservation({ ...context, ...delta }, ciphertext)).toThrow();
    }
    const future = encryptCustomerSenderObservation(context, "synthetic_customer", Date.now() + 1000);
    expect(() => decryptCustomerSenderObservation(context, future)).toThrow();
  });
});
