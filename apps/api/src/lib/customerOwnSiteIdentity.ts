import { z } from "zod";
import { safeFetch, type SafeFetchOptions, type SafeResponse } from "./safeFetch.js";
import { customerPropertyUrl } from "./customerPropertyUrls.js";

const websiteId = z.number().int().positive().max(2_147_483_647);
const publicIdentity = z.object({ id: websiteId, crmShortId: websiteId.nullable(),
  published: z.literal(true), sold: z.boolean(),
  externalId: z.null(), mapAddress: z.null(), lat: z.null(), lng: z.null(),
});
const envelope = z.object({ result: z.object({ data: z.object({ json: publicIdentity }) }) });
export interface CustomerOwnSiteIdentity { siteId: number; crmShortId: number | null }
export interface CustomerOwnSiteReadWait {
  signal: AbortSignal; deadlineAt: number; assertCurrent(): Promise<boolean>;
}
type Read = (url: string, options: SafeFetchOptions) => Promise<SafeResponse | null>;

/** Only recognized public paths. A site numeric ID is NEVER a CRM shortId. */
export function customerOwnSiteListingId(raw: string): number | null {
  const parsed = customerPropertyUrl(raw);
  if (parsed.kind !== "site") return null;
  const match = /^\/(?:listing\/([1-9]\d*)|(?:kvartiry|doma|uchastki|commercial)\/(?:[A-Za-z0-9_-]+-)?([1-9]\d*))\/?$/.exec(new URL(parsed.url).pathname);
  const id = Number(match?.[1] ?? match?.[2]);
  return websiteId.safeParse(id).success ? id : null;
}

/** Original elected turn only; no credentials, caller URL, redirects, provider
 * calls or shared cache. Four reads share one two-second metadata deadline. */
export function createCustomerOwnSiteIdentityReader(wait: CustomerOwnSiteReadWait, read: Read = safeFetch) {
  const deadlineAt = Math.min(wait.deadlineAt, Date.now() + 2000);
  const memo = new Map<number, Promise<CustomerOwnSiteIdentity | null>>();
  let requests = 0;
  const alive = () => !wait.signal.aborted && Date.now() < deadlineAt;
  return (siteId: number): Promise<CustomerOwnSiteIdentity | null> => {
    if (!websiteId.safeParse(siteId).success || wait.signal.aborted || Date.now() >= wait.deadlineAt) return Promise.resolve(null);
    const existing = memo.get(siteId); if (existing) return existing;
    if (!alive() || requests >= 4) return Promise.resolve(null);
    requests++;
    const controller = new AbortController();
    const abort = () => controller.abort();
    wait.signal.addEventListener("abort", abort, { once: true });
    if (wait.signal.aborted) abort();
    const timer = setTimeout(abort, Math.max(1, deadlineAt - Date.now()));
    let abandoned!: () => void;
    const cancelled = new Promise<null>(resolve => {
      abandoned = () => resolve(null);
      controller.signal.addEventListener("abort", abandoned, { once: true });
      if (controller.signal.aborted) abandoned();
    });
    const fresh = () => alive() && !controller.signal.aborted;
    const pending = (async () => {
      try {
        if (!await wait.assertCurrent() || !fresh()) return null;
        const url = new URL("https://royalhome.tj/api/trpc/listing.getById");
        url.searchParams.set("input", JSON.stringify({ json: { id: siteId } }));
        const value = await read(url.toString(), { maxRedirects: 0, maxBytes: 65_536,
          timeoutMs: Math.max(1, deadlineAt - Date.now()), signal: controller.signal, credentials: "omit",
          headers: { Accept: "application/json" } });
        if (!value || !fresh() || !await wait.assertCurrent() || !fresh() || value.status !== 200 || value.truncated ||
            value.body.byteLength > 65_536 || !/^application\/json(?:\s*;|$)/i.test(value.contentType)) return null;
        const returned = new URL(value.url);
        if (returned.href !== url.href) return null;
        const parsed = envelope.safeParse(JSON.parse(value.body.toString("utf8")));
        if (!parsed.success || parsed.data.result.data.json.id !== siteId) return null;
        return { siteId, crmShortId: parsed.data.result.data.json.crmShortId };
      } catch { return null; }
    })();
    // DNS/controller awaits may not support cancellation themselves. Stop
    // waiting at the original bound; their late result cannot start a GET or
    // become an identity after the signal/deadline changed.
    const bounded = Promise.race([pending, cancelled]).finally(() => {
      clearTimeout(timer); wait.signal.removeEventListener("abort", abort);
      controller.signal.removeEventListener("abort", abandoned);
    });
    memo.set(siteId, bounded); return bounded;
  };
}

export interface CustomerOwnSiteCandidate {
  id: string; shortId: number; siteListingId: number | null; publicStatusReadable: boolean;
}
/** Keep conflicting bindings ambiguous, including a private side of a collision. */
export function reconcileCustomerOwnSiteIdentity(identity: CustomerOwnSiteIdentity, rows: readonly CustomerOwnSiteCandidate[]): string[] {
  const matches = rows.filter(row => row.siteListingId === identity.siteId ||
    identity.crmShortId !== null && row.shortId === identity.crmShortId);
  if (matches.length > 1) return [...new Set(matches.map(row => row.id))].slice(0, 9);
  const row = matches[0];
  if (!row || !row.publicStatusReadable || row.siteListingId !== null && row.siteListingId !== identity.siteId ||
      identity.crmShortId !== null && row.shortId !== identity.crmShortId) return [];
  return [row.id];
}
