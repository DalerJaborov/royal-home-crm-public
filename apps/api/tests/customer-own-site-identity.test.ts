import { afterEach, expect, it, vi } from "vitest";
import { createCustomerOwnSiteIdentityReader, customerOwnSiteListingId, reconcileCustomerOwnSiteIdentity } from "../src/lib/customerOwnSiteIdentity.js";

afterEach(() => vi.useRealTimers());
const publicCard = (id = 98, crmShortId: number | null = 712) => ({ result: { data: { json: {
  id, crmShortId, published: true, sold: false, externalId: null, mapAddress: null, lat: null, lng: null,
} } } });
const response = (value: unknown) => ({ url: "https://royalhome.tj/api/trpc/listing.getById?input=" + encodeURIComponent(JSON.stringify({ json: { id: 98 } })), status: 200,
  contentType: "application/json", truncated: false, body: Buffer.from(JSON.stringify(value)) });
function fixture() {
  const abort = new AbortController();
  const get = vi.fn(async (_url: string, _options: unknown) => response(publicCard()));
  const assertCurrent = vi.fn(async () => true);
  const reader = createCustomerOwnSiteIdentityReader({ signal: abort.signal, deadlineAt: Date.now() + 60_000, assertCurrent }, get);
  return { abort, get, assertCurrent, reader };
}
it("reads the exact public listing identity without treating site ID as CRM number", async () => {
  const f = fixture();
  expect(await f.reader(98)).toEqual({ siteId: 98, crmShortId: 712 });
  const [raw, options] = f.get.mock.calls[0] as unknown as [string, Record<string, unknown>];
  const url = new URL(raw);
  expect(url.origin + url.pathname).toBe("https://royalhome.tj/api/trpc/listing.getById");
  expect(JSON.parse(url.searchParams.get("input")!)).toEqual({ json: { id: 98 } });
  expect(options).toMatchObject({ maxRedirects: 0, maxBytes: 65_536, credentials: "omit", headers: { Accept: "application/json" } });
  expect(Object.keys(options.headers as object)).toEqual(["Accept"]);
});
it.each([0, -1, 1.5, 2147483648, NaN])("rejects invalid identity %s before I/O", async id => {
  const f = fixture(); expect(await f.reader(id)).toBeNull(); expect(f.get).not.toHaveBeenCalled();
});
it.each([
  publicCard(99), { result: { data: { json: { ...publicCard().result.data.json, published: false } } } },
  { result: { data: { json: { ...publicCard().result.data.json, crmShortId: "712" } } } },
  { result: { data: { json: { ...publicCard().result.data.json, externalId: "private-id" } } } },
  { result: { data: { json: { ...publicCard().result.data.json, mapAddress: "private" } } } },
  [{ result: { data: { json: publicCard().result.data.json } } }], { error: { message: "not found" } },
])("rejects unavailable, conflicting or non-public metadata %#", async raw => {
  const f = fixture(); f.get.mockResolvedValue(response(raw)); expect(await f.reader(98)).toBeNull();
});
it("uses website sold metadata only for identity, leaving status to actual CRM facts", async () => {
  const f = fixture(); f.get.mockResolvedValue(response({ result: { data: { json: { ...publicCard().result.data.json, sold: true } } } }));
  expect(await f.reader(98)).toEqual({ siteId: 98, crmShortId: 712 });
});
it.each(["truncated", "wrongOrigin", "html", "redirect", "oversized"])("rejects unsafe transport %s", async problem => {
  const f = fixture(), value = response(publicCard());
  if (problem === "truncated") value.truncated = true;
  if (problem === "wrongOrigin") value.url = "https://foreign.example/api/trpc/listing.getById";
  if (problem === "html") value.contentType = "text/html";
  if (problem === "redirect") value.status = 302;
  if (problem === "oversized") value.body = Buffer.alloc(65_537);
  f.get.mockResolvedValue(value); expect(await f.reader(98)).toBeNull();
});
it("does not start an expired, cancelled or changed original read", async () => {
  const f = fixture(); f.abort.abort(); expect(await f.reader(98)).toBeNull(); expect(f.get).not.toHaveBeenCalled();
  const g = fixture(); g.assertCurrent.mockResolvedValue(false); expect(await g.reader(98)).toBeNull(); expect(g.get).not.toHaveBeenCalled();
});
it("discards metadata when the controller changes while the GET is in flight", async () => {
  const f = fixture(); f.get.mockImplementation(async () => { f.assertCurrent.mockResolvedValue(false); return response(publicCard()); });
  expect(await f.reader(98)).toBeNull();
});
it("shares a four-request budget and caches only within the original reader", async () => {
  const f = fixture(); await Promise.all([f.reader(98), f.reader(98)]); expect(f.get).toHaveBeenCalledTimes(1);
  for (const id of [99, 100, 101, 102]) await f.reader(id);
  expect(f.get).toHaveBeenCalledTimes(4); expect(await f.reader(103)).toBeNull();
  const g = fixture(); await g.reader(98); expect(g.get).toHaveBeenCalledTimes(1);
});
it("does not renew the two-second metadata deadline for another link", async () => {
  vi.useFakeTimers(); const f = fixture(); await f.reader(98); vi.advanceTimersByTime(2001);
  expect(await f.reader(99)).toBeNull(); expect(f.get).toHaveBeenCalledTimes(1);
  expect(await f.reader(98)).toEqual({ siteId: 98, crmShortId: 712 });
  vi.advanceTimersByTime(60_000); expect(await f.reader(98)).toBeNull();
});
it.each(["lookup", "controller-check"])("bounds a stalled %s without starting late I/O", async stage => {
  vi.useFakeTimers(); const f = fixture(); let resume: (() => void) | undefined;
  if (stage === "lookup") f.get.mockImplementation(() => new Promise(resolve => { resume = () => resolve(response(publicCard())); }));
  else f.assertCurrent.mockImplementation(() => new Promise(resolve => { resume = () => resolve(true); }));
  const completed = vi.fn(), pending = f.reader(98).then(completed);
  await vi.advanceTimersByTimeAsync(2001);
  expect(completed).toHaveBeenCalledWith(null);
  resume?.(); await pending;
  if (stage === "controller-check") expect(f.get).not.toHaveBeenCalled();
});
it.each(["https://royalhome.tj/listing/98", "https://royalhome.tj/tg/khona/98", "https://royalhome.tj/en/listing/98", "https://royalhome.tj/kvartiry/test-98"])("extracts only the website namespace from %s", url => {
  expect(customerOwnSiteListingId(url)).toBe(98);
});
it.each(["https://foreign.example/listing/98", "https://royalhome.tj/listing/preview/98", "https://royalhome.tj/listing/by-crm/aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee", "https://royalhome.tj/listing/98/extra"])("does not read metadata for %s", url => {
  expect(customerOwnSiteListingId(url)).toBeNull();
});
const row = (id: string, shortId: number, siteListingId: number | null, publicStatusReadable = true) => ({ id, shortId, siteListingId, publicStatusReadable });
it("uses the published CRM reference rather than a same-number CRM collision", () => {
  expect(reconcileCustomerOwnSiteIdentity({ siteId: 98, crmShortId: 712 }, [row("right", 712, null), row("wrong", 98, null)])).toEqual(["right"]);
});
it("preserves disagreement between local site binding and public CRM reference", () => {
  expect(reconcileCustomerOwnSiteIdentity({ siteId: 98, crmShortId: 712 }, [row("local", 111, 98), row("public", 712, null)])).toEqual(["local", "public"]);
});
it("does not expose non-offerable or mismatched cards", () => {
  expect(reconcileCustomerOwnSiteIdentity({ siteId: 98, crmShortId: 712 }, [row("private", 712, null, false)])).toEqual([]);
  expect(reconcileCustomerOwnSiteIdentity({ siteId: 98, crmShortId: 712 }, [row("wrong-site", 712, 99)])).toEqual([]);
});
it("supports a site-origin card without guessing a missing CRM reference", () => {
  expect(reconcileCustomerOwnSiteIdentity({ siteId: 98, crmShortId: null }, [row("site", 712, 98)])).toEqual(["site"]);
  expect(reconcileCustomerOwnSiteIdentity({ siteId: 98, crmShortId: null }, [row("guess", 98, null)])).toEqual([]);
});
