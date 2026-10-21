import { describe, expect, it, vi } from "vitest";
import { proveInstagramAppBinding } from "../src/lib/instagramAppBindingProof.js";
import { instagramAppBindingInputSchema } from "@royal-home/shared";

const input = { account: { externalId: "100", messagingId: "101", extraExternalIds: ["100"] },
  token: "stand-instagram-token", appId: "300", secret: "stand-application-secret" };
const identity = { id: "101", user_id: "100" };
const subscriptions = { data: [{ id: "300", subscribed_fields: ["messages", "messaging_postbacks", "messaging_referral", "comments"] }] };
const json = (data: unknown, status = 200) => new Response(JSON.stringify(data), { status });
function transport(values: Response[]) {
  const fake = vi.fn(async () => values.shift() ?? new Response("unexpected call", { status: 500 }));
  return { fake, options: { fetch: fake as typeof fetch, now: () => 1_000 } };
}

describe("owner-configured Instagram receiver and subscription checks", () => {
  it("checks identity and subscriptions without claiming app-secret ownership", async () => {
    const { fake, options } = transport([json(identity), json(subscriptions)]);
    await expect(proveInstagramAppBinding(input, options)).resolves.toEqual({ appId: "300", verifiedAtMs: 1_000 });
    expect(fake).toHaveBeenCalledTimes(2);
    const calls = fake.mock.calls as unknown as Array<[string, RequestInit]>;
    expect(calls.every(([, init]) => init.method === "GET" && init.redirect === "error" && init.signal)).toBe(true);
    expect(calls.every(([url]) => !url.includes("graph.facebook.com") && !url.includes(input.secret))).toBe(true);
  });
  it.each([
    { externalId: "999", messagingId: "101", extraExternalIds: [] },
    { externalId: "100", messagingId: "999", extraExternalIds: [] },
    { externalId: "100", messagingId: "101", extraExternalIds: ["999"] },
  ])("does not bind an unverified primary/messaging/extra alias", async account => {
    const { fake, options } = transport([json(identity)]);
    await expect(proveInstagramAppBinding({ ...input, account }, options)).rejects.toMatchObject({ code: "identity_mismatch" });
    expect(fake).toHaveBeenCalledTimes(1);
  });
  it.each([
    { data: [{ ...subscriptions.data[0], id: "999" }] },
    { data: [{ id: "300", subscribed_fields: ["messages"] }] },
  ])("does not choose another app or silently restore missing subscriptions", async body => {
    const { fake, options } = transport([json(identity), json(body)]);
    await expect(proveInstagramAppBinding(input, options)).rejects.toMatchObject({ code: "app_not_subscribed" });
    expect(fake).toHaveBeenCalledTimes(2);
  });
  it("accepts named subscription fields without combining permissions from different apps", async () => {
    const named = { data: subscriptions.data.map(app => ({ ...app, subscribed_fields: app.subscribed_fields.map(name => ({ name })) })) };
    const { options } = transport([json(identity), json(named), json({ id: "300" })]);
    await expect(proveInstagramAppBinding(input, options)).resolves.toMatchObject({ appId: "300" });
  });
  it.each([400, 401, 500])("does not replace failed receiver checks with a different proof", async status => {
    const { fake, options } = transport([json({ error: { message: input.secret } }, status)]);
    const failure = await proveInstagramAppBinding(input, options).catch(error => error);
    expect(failure).toBeInstanceOf(Error); expect(String(failure)).not.toContain(input.secret);
    expect(failure.code).toBe("provider_unavailable");
    expect(fake).toHaveBeenCalledTimes(1);
  });
  it("bounds proof age using the start of verification", async () => {
    const { options } = transport([json(identity), json(subscriptions), json({ id: "300" })]);
    const now = vi.fn().mockReturnValueOnce(1_000).mockReturnValue(31_001);
    await expect(proveInstagramAppBinding(input, { ...options, now })).rejects.toMatchObject({ code: "proof_expired" });
  });
  it("rejects an oversized provider body without returning it", async () => {
    const { options } = transport([new Response("x".repeat(65_537))]);
    await expect(proveInstagramAppBinding(input, options)).rejects.toMatchObject({ code: "provider_unavailable" });
  });
  it("does not expose a transport exception containing a URL/key", async () => {
    const fake = vi.fn(async () => { throw new Error(`https://stand.invalid/?key=${input.secret}`); });
    await expect(proveInstagramAppBinding(input, { fetch: fake as typeof fetch })).rejects.toMatchObject({ message: "provider_unavailable" });
  });
  it.each([
    { appId: "300", secretSource: "manual", appSecret: "short" },
    { appId: "../app", secretSource: "manual", appSecret: input.secret },
    { appId: "300", secretSource: "settings_meta", appSecret: input.secret },
    { appId: "300", secretSource: "manual", appSecret: input.secret, enabled: true },
  ])("rejects invalid and mixed secret-source requests", body => {
    expect(instagramAppBindingInputSchema.safeParse(body).success).toBe(false);
  });
  it("requires explicit mode, observed candidate, configuration version and confirmation", () => {
    const value = { mode: "owner_selected_observed_signer", appId: "300", secretSource: "settings_instagram",
      observationId: "a".repeat(64), observationVersion: "b".repeat(64), configurationVersion: "c".repeat(64), confirmFutureInputs: true };
    expect(instagramAppBindingInputSchema.safeParse(value).success).toBe(true);
    for (const key of Object.keys(value)) {
      const incomplete = { ...value }; delete incomplete[key as keyof typeof value];
      expect(instagramAppBindingInputSchema.safeParse(incomplete).success).toBe(false);
    }
    expect(instagramAppBindingInputSchema.safeParse({ ...value, secretSource: "manual", appSecret: input.secret }).success).toBe(false);
    expect(instagramAppBindingInputSchema.safeParse({ ...value, confirmFutureInputs: false }).success).toBe(false);
  });
});
