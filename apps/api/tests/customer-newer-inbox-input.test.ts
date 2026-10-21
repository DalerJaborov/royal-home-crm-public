import { randomUUID } from "node:crypto";
import { expect, it } from "vitest";
import { encryptCustomerIngressPayload, customerIngressPayloadHash, type CustomerNormalizedIngressInput } from "../src/lib/customerIngressPayload.js";
import { hasNewerCustomerInboxInput } from "../src/lib/customerNewerInboxInput.js";
import { customerPropertyScopeKey } from "../src/lib/customerPropertyScope.js";

function newer(change: { echo?: boolean; referral?: boolean; templateEcho?: boolean; publicOnly?: boolean;
  signedPublic?: boolean; noCredential?: boolean; wrongCredential?: boolean; noClassifier?: boolean } = {}) {
  const scope = randomUUID(), hash = "a".repeat(64), accountId = randomUUID(), source = { path: "entry.0.messaging.0", frameHash: hash };
  const payload: CustomerNormalizedIngressInput = { version: 1, channel: "INSTAGRAM", peer: "synthetic-peer", accountExternalId: "synthetic-account",
    eventKind: "message", eventId: "synthetic-event", inputText: "Можно подробнее о работе?", source,
    observations: { providerEcho: !!change.echo, referralOnly: !!change.referral,
      ...(!change.noClassifier ? { classifier: { version: 1 as const, bareTemplateEcho: !!change.templateEcho } } : {}) }, media: [], propertyEvidence: [] };
  const row = { eventKey: "b".repeat(64), order: 2n, scopeKey: customerPropertyScopeKey(payload.channel, payload.peer, accountId, scope),
    endpointScopeId: scope, payloadHash: customerIngressPayloadHash(payload), payloadCiphertext: "" };
  row.payloadCiphertext = encryptCustomerIngressPayload({ version: 1, eventKey: row.eventKey, order: "2", scopeKey: row.scopeKey,
    endpointScopeId: scope, payloadHash: row.payloadHash }, payload, { version: 1, classification: "PENDING_ENVELOPE",
    provenance: "meta_signature", assurance: change.publicOnly || change.signedPublic ? "public_envelope" : "protected_namespace",
    issuerSource: change.signedPublic ? "verified_public_envelope" : "account_secret",
    accountId, endpointScopeId: scope, scopeRevision: "1", policyRevision: "1", issuedAt: Date.now(), source,
    verifierCredential: change.signedPublic && !change.noCredential ? { source: "settings_meta_ig_app_secret",
      sourceId: change.wrongCredential ? "not-singleton" : "singleton", fingerprint: "c".repeat(64) } : null });
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
it("allows a real signed Settings public envelope only as an abort observation", async () => {
  expect(await hasNewerCustomerInboxInput("a".repeat(64), db([newer({ signedPublic: true })]))).toBe(true);
});
it.each([{ echo: true }, { referral: true }, { templateEcho: true }, { noCredential: true }, { wrongCredential: true }, { noClassifier: true }])(
  "retains public-envelope echo/credential/classification guards: %j", async change => {
    expect(await hasNewerCustomerInboxInput("a".repeat(64), db([newer({ signedPublic: true, ...change })]))).toBe(false);
  });
it("rejects a valid ciphertext transplanted to another scope/transport or the same event", async () => {
  const row = newer({ signedPublic: true });
  expect(await hasNewerCustomerInboxInput("a".repeat(64), db([{ ...row, scopeKey: "f".repeat(64) }]))).toBe(false);
  expect(await hasNewerCustomerInboxInput(row.eventKey, db([row]))).toBe(false);
});
