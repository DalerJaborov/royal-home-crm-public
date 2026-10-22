import { createHmac, randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { captureAuthenticatedCustomerInput, inspectAuthenticatedCustomerInput, registerAuthenticatedMetaCustomerRequest,
  verifyAndRegisterMetaCustomerIssuer, verifyAndRegisterPublicMetaCustomerIssuer, type CustomerMetaIssuerStore } from "../src/lib/customerIngressAuthority.js";

/** F02 (23.10.2026): an account WITHOUT its own app secret and with BOTH global
 * Settings secrets configured (Meta app + Instagram app) used to fail the strict
 * namespace proof (`relevant.length !== 1`), so every input became a
 * `public_envelope` with no memory. The signature itself identifies the secret. */
const GLOBAL = "global-app-secret", INSTAGRAM = "instagram-app-secret";
const credential = (source: "settings_meta_app_secret" | "settings_meta_ig_app_secret") => ({ source, sourceId: "singleton", fingerprint: (source === "settings_meta_app_secret" ? "a" : "b").repeat(64) });
function store(over: { explicitSecret?: boolean; secret?: string | null; global?: string | null; instagram?: string | null } = {}): CustomerMetaIssuerStore {
  const scope = randomUUID();
  return {
    readTarget: async () => [{ id: "account-1", explicitSecret: over.explicitSecret ?? false, secret: over.secret ?? null, endpointScopeId: scope,
      scopeRevision: "1", policyRevision: "1", verifierCredential: null }],
    readGlobalSecrets: async () => ({ global: over.global === undefined ? GLOBAL : over.global, instagram: over.instagram === undefined ? INSTAGRAM : over.instagram,
      credentials: { global: credential("settings_meta_app_secret"), instagram: credential("settings_meta_ig_app_secret") } }),
  };
}
function signed(secret: string, channel: "INSTAGRAM" | "FACEBOOK" = "INSTAGRAM") {
  const rawBody = Buffer.from(JSON.stringify({ object: channel.toLowerCase(), entry: [{ id: "acc-ext" }], n: randomUUID() }));
  const header = `sha256=${createHmac("sha256", secret).update(rawBody).digest("hex")}`;
  const request = { rawBody, get: (name: string) => name === "x-hub-signature-256" ? header : undefined };
  registerAuthenticatedMetaCustomerRequest(request);
  return request;
}
const target = (channel: "INSTAGRAM" | "FACEBOOK" = "INSTAGRAM") => ({ channel, accountId: "account-1", accountExternalId: "acc-ext" });
function evidence(request: object, channel: "INSTAGRAM" | "FACEBOOK" = "INSTAGRAM") {
  const input = captureAuthenticatedCustomerInput(request, { channel, peer: "peer-1", accountExternalId: "acc-ext", eventId: "mid-1", eventKind: "message", inputText: "привет" });
  return input ? inspectAuthenticatedCustomerInput(input) : null;
}

describe("strict namespace proof with two global secrets", () => {
  it("accepts the Instagram app secret as protected_namespace when exactly it signed the request", async () => {
    const request = signed(INSTAGRAM);
    expect(await verifyAndRegisterMetaCustomerIssuer(request, target(), store())).toBe(true);
    const seen = evidence(request);
    expect(seen?.assurance).toBe("protected_namespace");
    expect(seen?.issuerSource).toBe("single_channel_global");
    expect(seen?.verifierCredential).toEqual(credential("settings_meta_ig_app_secret"));
    expect(seen?.protectedMetaAccountId).toBe("account-1");
  });
  it("accepts the Meta app secret too and binds the credential of THAT secret", async () => {
    const request = signed(GLOBAL);
    expect(await verifyAndRegisterMetaCustomerIssuer(request, target(), store())).toBe(true);
    expect(evidence(request)?.verifierCredential).toEqual(credential("settings_meta_app_secret"));
  });
  it("still rejects a signature made by neither configured secret", async () => {
    const request = signed("some-other-secret");
    expect(await verifyAndRegisterMetaCustomerIssuer(request, target(), store())).toBe(false);
    expect(evidence(request)).toBeNull();
  });
  it("keeps the single-secret and explicit-secret behaviour unchanged", async () => {
    expect(await verifyAndRegisterMetaCustomerIssuer(signed(GLOBAL), target(), store({ instagram: null }))).toBe(true);
    expect(await verifyAndRegisterMetaCustomerIssuer(signed(INSTAGRAM), target(), store({ instagram: null }))).toBe(false);
    // An explicit account secret never falls back to a global key.
    expect(await verifyAndRegisterMetaCustomerIssuer(signed(GLOBAL), target(), store({ explicitSecret: true, secret: "own-secret" }))).toBe(false);
    expect(await verifyAndRegisterMetaCustomerIssuer(signed("own-secret"), target(), store({ explicitSecret: true, secret: "own-secret" }))).toBe(true);
  });
  it("does not widen Facebook: only the Meta app secret is relevant there", async () => {
    expect(await verifyAndRegisterMetaCustomerIssuer(signed(INSTAGRAM, "FACEBOOK"), target("FACEBOOK"), store())).toBe(false);
    expect(await verifyAndRegisterMetaCustomerIssuer(signed(GLOBAL, "FACEBOOK"), target("FACEBOOK"), store())).toBe(true);
  });
  it("does not retro-promote: the public-envelope verifier stays a weaker, separate proof", async () => {
    const request = signed(INSTAGRAM);
    expect(await verifyAndRegisterPublicMetaCustomerIssuer(request, target(), store())).toBe(true);
    expect(evidence(request)?.assurance).toBe("public_envelope");
  });
});
