import { expect, it } from "vitest";
import { customerPropertyUrl, safeCustomerPropertyLink } from "../src/lib/customerPropertyUrls.js";

it.each(["/listing/98", "/tg/khona/98", "/tg/listing/98", "/en/listing/98"])("recognizes public website listing route %s without changing its identifier namespace", path => {
  expect(customerPropertyUrl(`https://royalhome.tj${path}?utm_source=stand#photos`))
    .toEqual({ kind: "site", url: "https://royalhome.tj/listing/98" });
});
it.each(["/listing/preview/98", "/listing/preview/98/private", "/en/listing/preview/98", "/tg/listing/preview/98"])("does not treat private preview %s as a public card", path => {
  expect(customerPropertyUrl(`https://royalhome.tj${path}`)).toEqual({ kind: "denied" });
  expect(safeCustomerPropertyLink(`https://royalhome.tj${path}`)).toBeNull();
});
it.each(["/tg/khona/0", "/tg/khona/098", "/tg/khona/-98", "/tg/khona/2147483648", "/en/khona/98", "/ru/listing/98", "/tg/admin/98", "/en/api/listing/98", "/tg/khona/%39%38"])("does not broaden the public alias contract to %s", path => {
  expect(customerPropertyUrl(`https://royalhome.tj${path}`)).toEqual({ kind: "unsupported" });
});
it.each(["https://foreign.example/tg/khona/98", "https://royalhome.tj.foreign.example/en/listing/98", "https://royalhome.tj:8443/tg/khona/98", "file:///tg/khona/98"])("retains the origin/protocol gate for %s", url => {
  expect(customerPropertyUrl(url)).toEqual({ kind: "denied" });
});
it("preserves the existing by-crm and Instagram identities", () => {
  const crm = "https://royalhome.tj/listing/by-crm/aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";
  expect(customerPropertyUrl(crm)).toEqual({ kind: "site", url: crm });
  expect(customerPropertyUrl("https://www.instagram.com/reel/StandABC98/?igsh=stand"))
    .toEqual({ kind: "instagram", shortcode: "StandABC98", url: "https://www.instagram.com/p/StandABC98/" });
});
it.each(["/listing/private/98", "/listing/98/extra", "/listing/by-crm/aaaaaaaa", "/listing/0", "/kvartiry/admin/98"])("does not treat an unknown nested path %s as a public card", path => {
  expect(customerPropertyUrl(`https://royalhome.tj${path}`)).toEqual({ kind: "unsupported" });
});
it.each(["/listing/preview/../98", "/listing/%2e%2e/listing/98", "/listing%2fpreview/98", "/listing/..\\listing/98"])("rejects normalized traversal/separators in %s", path => {
  expect(customerPropertyUrl(`https://royalhome.tj${path}`)).toEqual({ kind: "denied" });
});
