import { z } from "zod";
import { GRAPH_VERSION, instagramApiUrl, instagramRequest } from "../messengers/metaGraph.js";
import { readCapped } from "./safeFetch.js";
import { inspectPublicCommentPrincipal, revalidatePublicCommentPrincipal, type PublicCommentPrincipal } from "./publicCommentSourceIssuer.js";
import { readPublicCommentMetaToken } from "./customerPublicCommentStore.js";
import { readCustomerPublicationCatalog, type CustomerPublicationSource } from "./customerPublicationCatalog.js";
import { customerPropertyUrl } from "./customerPropertyUrls.js";

const metadata = z.object({ id: z.string().regex(/^\d{1,80}$/), permalink: z.string().max(2048) }).passthrough();
// Lifetime is one genuine principal/turn, not a global cross-account cache.
const observed = new WeakMap<object, Readonly<CustomerPublicationSource>>();
/** Reuse legacy media→permalink→CRM matching, without captions/guessed prices,
 * self-healing writes, global/default tokens or an unbounded own-feed scan.
 * The captured permalink is persisted only by a genuine server read witness in
 * encrypted outbox evidence; it is not accepted from a model or public request. */
export async function readCustomerPublicPublicationSource(principal: PublicCommentPrincipal,
  wait: { deadlineAt: number; signal?: AbortSignal }): Promise<CustomerPublicationSource | null> {
  const original = inspectPublicCommentPrincipal(principal);
  if (!original || !["INSTAGRAM", "FACEBOOK"].includes(original.target.channel)) return null;
  const base: CustomerPublicationSource = { channel: original.target.channel as "INSTAGRAM" | "FACEBOOK",
    resourceId: original.target.accountExternalId, publicationId: original.target.publicationId };
  const current = async () => !wait.signal?.aborted && Date.now() < wait.deadlineAt &&
    (await revalidatePublicCommentPrincipal(principal)).status === "current";
  if (!await current()) return null;
  const cached = observed.get(principal); if (cached) return cached;
  if (base.channel !== "INSTAGRAM" || !/^\d{1,80}$/.test(base.publicationId) || await readCustomerPublicationCatalog(base)) return base;
  try {
    const token = await readPublicCommentMetaToken(principal.installation);
    if (!token || !await current()) return null;
    const remaining = Math.min(3000, wait.deadlineAt - Date.now());
    if (remaining <= 0) return null;
    const request = instagramRequest(instagramApiUrl(`/${GRAPH_VERSION}/${base.publicationId}?fields=id,permalink`), token);
    const res = await fetch(request.url, { method: "GET", headers: request.headers, redirect: "error",
      signal: AbortSignal.any([...(wait.signal ? [wait.signal] : []), AbortSignal.timeout(remaining)]) });
    let result: CustomerPublicationSource = base;
    if (!res.ok || Number(res.headers.get("content-length") ?? 0) > 16 * 1024) await res.body?.cancel();
    else {
      const bytes = await readCapped(res, 16 * 1024);
      const parsed = bytes.truncated ? null : metadata.safeParse(JSON.parse(bytes.body.toString("utf8")));
      if (parsed?.success && parsed.data.id === base.publicationId) {
        const rawUrl = new URL(parsed.data.permalink), url = customerPropertyUrl(parsed.data.permalink);
        if (rawUrl.protocol === "https:" && !rawUrl.username && !rawUrl.password && !rawUrl.port && url.kind === "instagram") {
          result = { ...base, permalink: `https://www.instagram.com/p/${url.shortcode}/` };
        }
      }
    }
    if (!await current() || await readPublicCommentMetaToken(principal.installation) !== token) return null;
    const frozen = Object.freeze(result); observed.set(principal, frozen); return frozen;
  } catch {
    if (!await current()) return null;
    observed.set(principal, Object.freeze(base)); return base;
  }
}
