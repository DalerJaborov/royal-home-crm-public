import { assertPublicUrl } from "./safeFetch.js";

/** The only destinations a share link may point to; the result is parsed by the
 * ordinary customerPropertyUrl() afterwards, so nothing else is ever looked up. */
const DESTINATION_HOSTS = new Set(["facebook.com", "www.facebook.com", "m.facebook.com", "instagram.com", "www.instagram.com"]);
const TIMEOUT_MS = 5000;

export interface ShareExpansionDeps {
  assertPublic?: (raw: string) => Promise<URL>;
  fetch?: typeof fetch;
  timeoutMs?: number;
}

/**
 * ONE anonymous request to an opaque share link ("facebook.com/share/p/<code>", "fb.watch/<code>"),
 * redirect "manual", no cookies, no tokens; only the Location header is read, the body is never read
 * (it is cancelled). Why this is safe although the core forbids following redirects: that rule exists
 * so a customer-supplied URL cannot make the server walk to an arbitrary host. Here the start is a
 * fixed, parser-validated Meta host, the redirect is NOT followed (the destination is only compared
 * with an allow-list and parsed as text), and the address still passes the shared SSRF guard.
 *
 * Returns the destination URL, or null when the answer is deterministic and unusable (no redirect,
 * login wall, foreign host). Throws on timeout, network error, 429 and 5xx - the caller reports
 * those as lookup_unavailable.
 */
export async function expandCustomerShareLink(share: string, deps: ShareExpansionDeps = {}): Promise<string | null> {
  const url = await (deps.assertPublic ?? assertPublicUrl)(share);
  if (url.protocol !== "https:") return null;
  const timeoutMs = deps.timeoutMs ?? TIMEOUT_MS;
  const res = await (deps.fetch ?? fetch)(url, {
    method: "GET", redirect: "manual", credentials: "omit",
    headers: { "User-Agent": "RoyalHomeCRM/1.0 (+https://royalhome.tj)", Accept: "text/html" },
    signal: AbortSignal.timeout(timeoutMs),
  });
  const location = res.headers.get("location");
  await res.body?.cancel().catch(() => undefined);
  if (res.status === 429 || res.status === 408 || res.status >= 500) throw new Error(`share link expansion: HTTP ${res.status}`);
  if (res.status < 300 || res.status >= 400 || !location) return null;
  let destination: URL;
  try { destination = new URL(location, url); } catch { return null; }
  if (destination.protocol !== "https:" || destination.username || destination.password || destination.port) return null;
  return DESTINATION_HOSTS.has(destination.hostname.toLowerCase()) ? destination.toString() : null;
}
