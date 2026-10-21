import { randomUUID } from "node:crypto";
import { expect, it } from "vitest";
import { encryptCustomerIngressPayload, customerIngressPayloadHash, type CustomerNormalizedIngressInput } from "../src/lib/customerIngressPayload.js";
import { hasNewerCustomerInboxInput } from "../src/lib/customerNewerInboxInput.js";

function newer(change: { echo?: boolean; referral?: boolean; templateEcho?: boolean; publicOnly?: boolean } = {}) {
  const scope = randomUUID(), hash = "a".repeat(64), source = { path: "entry.0.messaging.0", frameHash: hash };
  const payload: CustomerNormalizedIngressInput = { version: 1, channel: "INSTAGRAM", peer: "synthetic-peer", accountExternalId: "synthetic-account",
    eventKind: "message", eventId: "synthetic-event", inputText: "Можно подробнее о работе?", source,
    observations: { providerEcho: !!change.echo, referralOnly: !!change.referral,
      classifier: { version: 1, bareTemplateEcho: !!change.templateEcho } }, media: [], propertyEvidence: [] };
  const row = { eventKey: "b".repeat(64), order: 2n, scopeKey: hash, endpointScopeId: scope, payloadHash: customerIngressPayloadHash(payload), payloadCiphertext: "" };
  row.payloadCiphertext = encryptCustomerIngressPayload({ version: 1, eventKey: row.eventKey, order: "2", scopeKey: row.scopeKey,
    endpointScopeId: scope, payloadHash: row.payloadHash }, payload, { version: 1, classification: "PENDING_ENVELOPE",
    provenance: "meta_signature", assurance: change.publicOnly ? "public_envelope" : "protected_namespace", issuerSource: "account_secret",
    accountId: randomUUID(), endpointScopeId: scope, scopeRevision: "1", policyRevision: "1", issuedAt: Date.now(), source, verifierCredential: null });
  return row;
}
const db = (rows: unknown[]) => ({ $queryRaw: async () => rows }) as never;
it("observes a genuine newer signed input before FINAL without simulating or accepting it", async () => {
  expect(await hasNewerCustomerInboxInput("a".repeat(64), db([newer()]))).toBe(true);
  expect(await hasNewerCustomerInboxInput("a".repeat(64), db([]))).toBe(false);
});
it.each([{ echo: true }, { referral: true }, { templateEcho: true }, { publicOnly: true }])("does not cancel from an echo/referral/unprotected source: %j", async change => {
  expect(await hasNewerCustomerInboxInput("a".repeat(64), db([newer(change)]))).toBe(false);
});
it("rejects corrupt ciphertext and a transplanted endpoint instead of conferring supersession", async () => {
  const row = newer();
  expect(await hasNewerCustomerInboxInput("a".repeat(64), db([{ ...row, payloadCiphertext: "plaintext" }]))).toBe(false);
  expect(await hasNewerCustomerInboxInput("a".repeat(64), db([{ ...row, endpointScopeId: randomUUID() }]))).toBe(false);
});
