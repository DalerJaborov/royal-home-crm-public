import { z } from "zod";
import { GRAPH_VERSION, instagramApiUrl, instagramRequest } from "../messengers/metaGraph.js";

export class InstagramAppBindingError extends Error {
  constructor(readonly code: "account_unavailable" | "invalid_credentials" | "identity_mismatch" | "app_not_subscribed" |
    "observation_unavailable" | "provider_unavailable" | "proof_expired" | "account_changed" | "account_busy", readonly status = 409) {
    super(code);
  }
}
export interface InstagramBindingAccount { externalId: string; messagingId: string | null; extraExternalIds: string[] }
export const INSTAGRAM_BINDING_PROOF_TTL_MS = 30_000;
const id = z.string().regex(/^\d{1,64}$/);
const identitySchema = z.object({ id: id.optional(), user_id: id.optional() });
const subscriptionsSchema = z.object({ data: z.array(z.object({ id,
  subscribed_fields: z.array(z.union([z.string(), z.object({ name: z.string() })])).optional(),
})).max(100) });

async function readJson(response: Response): Promise<unknown> {
  if (!response.ok) {
    await response.body?.cancel().catch(() => undefined);
    throw new InstagramAppBindingError("provider_unavailable", 502);
  }
  if (!response.body) throw new InstagramAppBindingError("provider_unavailable", 502);
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = []; let size = 0;
  try {
    while (true) {
      const item = await reader.read(); if (item.done) break;
      size += item.value.length;
      if (size > 65_536) throw new InstagramAppBindingError("provider_unavailable", 502);
      chunks.push(item.value);
    }
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } finally { await reader.cancel().catch(() => undefined); }
}

/** Two bounded reads prove receiver/subscriptions, NOT ownership of a signing key. */
export async function proveInstagramAppBinding(input: { account: InstagramBindingAccount; token: string; appId: string },
  options: { fetch?: typeof fetch; now?: () => number } = {}): Promise<{ appId: string; verifiedAtMs: number }> {
  const call = options.fetch ?? fetch, now = options.now ?? Date.now, startedAt = now();
  const get = async (url: string, headers: Record<string, string>) => readJson(await call(url,
    { method: "GET", headers, redirect: "error", signal: AbortSignal.timeout(8_000) }));
  try {
    const identityRequest = instagramRequest(instagramApiUrl(`/${GRAPH_VERSION}/me?fields=id,user_id`), input.token);
    const identity = identitySchema.safeParse(await get(identityRequest.url, identityRequest.headers));
    if (!identity.success) throw new InstagramAppBindingError("provider_unavailable", 502);
    const aliases = new Set([identity.data.id, identity.data.user_id].filter(Boolean));
    const configured = [input.account.externalId, input.account.messagingId, ...input.account.extraExternalIds].filter(Boolean);
    if (!configured.length || configured.some(value => !aliases.has(value!))) throw new InstagramAppBindingError("identity_mismatch");
    const request = instagramRequest(instagramApiUrl(`/${GRAPH_VERSION}/me/subscribed_apps?fields=id,subscribed_fields`), input.token);
    const subscriptions = subscriptionsSchema.safeParse(await get(request.url, request.headers));
    if (!subscriptions.success) throw new InstagramAppBindingError("provider_unavailable", 502);
    const installed = subscriptions.data.data.find(app => app.id === input.appId);
    const fields = new Set(installed?.subscribed_fields?.map(value => typeof value === "string" ? value : value.name));
    if (!installed || !["messages", "messaging_postbacks", "messaging_referral", "comments"].every(field => fields.has(field))) {
      throw new InstagramAppBindingError("app_not_subscribed");
    }
    if (now() - startedAt > INSTAGRAM_BINDING_PROOF_TTL_MS || now() < startedAt) throw new InstagramAppBindingError("proof_expired");
    return { appId: input.appId, verifiedAtMs: startedAt };
  } catch (error) {
    if (error instanceof InstagramAppBindingError) throw error;
    // Never expose/log fetch exceptions, URLs, raw Meta JSON or bearer credentials.
    throw new InstagramAppBindingError("provider_unavailable", 502);
  }
}
