import { admitLegacyPhysicalPost, legacyPhysicalChannelSchema, legacyPhysicalDigest, settleLegacyPhysicalPost,
  type LegacyPhysicalTarget } from "./customerLegacyPhysical.js";
import type { CustomerTransportReference } from "./customerConversationScope.js";
import { nextLegacyPhysicalEffect } from "./customerLegacyPhysicalSource.js";
import { metaMessageReceiptSchema, metaPhysicalReceiptId, contradictoryMetaSendResponse } from "../messengers/metaSendReceipt.js";

/** Server transport metadata, never a model-provided origin/permission. A missing
 * captured endpoint stays unattributed and prevents a claimed complete cutover.
 * No raw body, recipient, URL, access token or network error is stored. */
export function legacyMetaPhysicalTarget(url: string, body: unknown,
  transport?: CustomerTransportReference): LegacyPhysicalTarget | undefined {
  if (!body || typeof body !== "object") return;
  const value = body as Record<string, unknown>;
  if (value.sender_action || value.status === "read") return; // typing/read receipts, not customer replies
  const path = new URL(url).pathname;
  const dm = /\/messages$/.test(path) && (value.recipient || value.to);
  const comment = /\/(comments|replies)$/.test(path) && typeof value.message === "string";
  if (!dm && !comment) return;
  const destination = dm ? value.recipient ?? value.to : path;
  const targetDigest = legacyPhysicalDigest(JSON.stringify(destination));
  return {
    endpointScopeId: transport?.endpointScopeId ?? null,
    scopeRevision: transport?.scopeRevision ?? null,
    channel: transport ? legacyPhysicalChannelSchema.parse(transport.channel) : null,
    surface: comment ? "public_comment" : "dm",
    targetDigest,
    payloadDigest: legacyPhysicalDigest(JSON.stringify(body)),
    operation: value.messaging_product === "whatsapp" && value.type === "reaction" ? "reaction" : "message",
    ...nextLegacyPhysicalEffect(transport?.endpointScopeId ?? null, targetDigest),
  };
}
const definitelyNotSent = new Set(["ECONNREFUSED", "ENOTFOUND", "EAI_AGAIN", "ENETUNREACH", "EHOSTUNREACH"]);

/** The callback is the actual physical fetch, after all original admission
 * checks. Even with cutover OFF admission is durable before it can run. */
export async function legacyMetaPhysicalFetch(target: LegacyPhysicalTarget,
  physical: () => Promise<Response>): Promise<Response> {
  const id = await admitLegacyPhysicalPost(target);
  let response: Response;
  try { response = await physical(); }
  catch (error) {
    const code = (error as { cause?: { code?: string }; code?: string })?.cause?.code
      ?? (error as { code?: string })?.code;
    await settleLegacyPhysicalPost(id, code && definitelyNotSent.has(code) ? "NOT_SENT" : "UNKNOWN");
    throw error;
  }
  // Never classify a partial response-body read as a confirmed rejection.
  let value: unknown;
  try { value = await response.clone().json(); }
  catch { await settleLegacyPhysicalPost(id, "UNKNOWN"); return response; }
  const result = value && typeof value === "object" ? value as Record<string, unknown> : {};
  const parsed = metaMessageReceiptSchema.safeParse(result);
  const receipt = metaPhysicalReceiptId(target.surface, result);
  if (response.ok && receipt)
    await settleLegacyPhysicalPost(id, "ACCEPTED", receipt);
  else if (target.operation === "reaction" && target.surface === "dm" && response.ok && !contradictoryMetaSendResponse(result) && parsed.success && result.success === true)
    await settleLegacyPhysicalPost(id, "ACKNOWLEDGED"); // e.g. reaction; not a message receipt
  else if (response.status >= 400 && response.status < 500 && result.error)
    await settleLegacyPhysicalPost(id, "REJECTED");
  else await settleLegacyPhysicalPost(id, "UNKNOWN");
  return response;
}
