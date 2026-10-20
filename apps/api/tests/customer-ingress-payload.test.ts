import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { customerIngressPayloadHash, decryptCustomerIngressEnvelope, encryptCustomerIngressPayload,
  type CustomerNormalizedIngressInput, type CustomerPendingVerification } from "../src/lib/customerIngressPayload.js";
import { decryptCustomerFinalOrigin } from "../src/lib/customerOriginPayload.js";

afterEach(() => vi.unstubAllEnvs());
function fixture() {
  vi.stubEnv("SETTINGS_ENCRYPTION_KEY", "1".repeat(64));
  const payload: CustomerNormalizedIngressInput = { version: 1, channel: "INSTAGRAM", peer: "synthetic-peer", accountExternalId: "synthetic-account",
    eventKind: "message", eventId: "synthetic-mid", inputText: "Нархшчансумай", source: { path: "$.entry[0].messaging[0]", frameHash: "a".repeat(64) },
    observations: { providerEcho: false, referralOnly: false }, media: [{ kind: "audio", url: "https://synthetic.invalid/audio" }], propertyEvidence: [] };
  const context = { version: 1 as const, eventKey: "b".repeat(64), order: "1", scopeKey: "c".repeat(64), endpointScopeId: randomUUID(), payloadHash: customerIngressPayloadHash(payload) };
  const verification: CustomerPendingVerification = { version: 1, classification: "PENDING_ENVELOPE", provenance: "meta_signature", assurance: "public_envelope",
    issuerSource: "verified_public_envelope", accountId: randomUUID(), endpointScopeId: context.endpointScopeId, scopeRevision: "1", policyRevision: "2",
    issuedAt: Date.now(), source: payload.source, verifierCredential: { source: "account_app_secret", sourceId: randomUUID(), fingerprint: "d".repeat(64) } };
  return { payload, context, verification };
}
describe("strict encrypted normalized ingress", () => {
  it("round-trips bounded payload and separate pending evidence without exposing text/URL", () => {
    const f = fixture(), ciphertext = encryptCustomerIngressPayload(f.context, f.payload, f.verification);
    expect(ciphertext).not.toContain(f.payload.inputText); expect(ciphertext).not.toContain("synthetic.invalid");
    expect(decryptCustomerIngressEnvelope(f.context, ciphertext)).toEqual({ context: f.context, payload: f.payload, verification: f.verification });
    expect(() => decryptCustomerFinalOrigin(ciphertext)).toThrow();
  });
  it("rejects transplanted event/order/scope/hash bindings", () => {
    const f = fixture(), ciphertext = encryptCustomerIngressPayload(f.context, f.payload, f.verification);
    for (const changed of [{ eventKey: "e".repeat(64) }, { order: "2" }, { endpointScopeId: randomUUID() }, { payloadHash: "f".repeat(64) }]) {
      expect(() => decryptCustomerIngressEnvelope({ ...f.context, ...changed }, ciphertext)).toThrow();
    }
  });
  it("rejects plaintext, corrupt AES-GCM and wrong encryption key", () => {
    const f = fixture(), ciphertext = encryptCustomerIngressPayload(f.context, f.payload, f.verification);
    expect(() => decryptCustomerIngressEnvelope(f.context, JSON.stringify(f))).toThrow();
    const corrupt = ciphertext.slice(0, -2) + (ciphertext.endsWith("00") ? "01" : "00");
    expect(() => decryptCustomerIngressEnvelope(f.context, corrupt)).toThrow();
    vi.stubEnv("SETTINGS_ENCRYPTION_KEY", "2".repeat(64));
    expect(() => decryptCustomerIngressEnvelope(f.context, ciphertext)).toThrow();
  });
  it("rejects mismatched raw-frame attestation and unbounded/private extra fields", () => {
    const f = fixture();
    expect(() => encryptCustomerIngressPayload(f.context, f.payload, { ...f.verification, source: { ...f.payload.source, frameHash: "0".repeat(64) } })).toThrow();
    expect(() => customerIngressPayloadHash({ ...f.payload, rawBody: "forbidden" } as unknown as CustomerNormalizedIngressInput)).toThrow();
    expect(() => customerIngressPayloadHash({ ...f.payload, inputText: "x".repeat(8001) })).toThrow();
  });
  it("optional new classifier observations preserve old raw identity without upgrading the old ciphertext", () => {
    const f = fixture();
    const captured = { ...f.payload, observations: { ...f.payload.observations, classifier: { version: 1 as const, bareTemplateEcho: false } } };
    expect(customerIngressPayloadHash(captured)).toBe(customerIngressPayloadHash(f.payload));
    const oldCiphertext = encryptCustomerIngressPayload(f.context, f.payload, f.verification);
    expect(decryptCustomerIngressEnvelope(f.context, oldCiphertext).payload.observations.classifier).toBeUndefined();
    const newCiphertext = encryptCustomerIngressPayload(f.context, captured, f.verification);
    expect(decryptCustomerIngressEnvelope(f.context, newCiphertext).payload.observations.classifier).toEqual({ version: 1, bareTemplateEcho: false });
    expect(decryptCustomerIngressEnvelope(f.context, oldCiphertext).payload).toEqual(f.payload);
  });
});
