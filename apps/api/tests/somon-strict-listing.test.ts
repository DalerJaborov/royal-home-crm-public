import { describe, expect, it } from "vitest";
import { parseSomonListingPage, somonListingSellerId } from "../src/lib/somonLeads/strictListing.js";
const ad = { id: 42, title: "Квартира", url: "/adv/42_example/", ad_type: { type: "regular" } };
function html(adverts: unknown[], size = adverts.length, slug = "prodazha-kvartir") {
  const payload = JSON.stringify({ next_page: `?page=2&page_size=${size}`, rubric: { slug }, location_ids: [1], adverts });
  return `<a href="?page=2">2</a><script>self.__next_f.push([1,${JSON.stringify(payload)}]);</script>`;
}
describe("Somon baseline completeness", () => {
  it("reads the entire validated array", () => { expect(parseSomonListingPage(html([ad]), 1).ads).toHaveLength(1); });
  it("fails closed for partial or malformed array contents", () => {
    expect(() => parseSomonListingPage(html([ad], 2), 1)).toThrow("Incomplete");
    expect(() => parseSomonListingPage(html([ad, { title: "Квартира" }]), 1)).toThrow("item");
  });
  it("rejects another category", () => { expect(() => parseSomonListingPage(html([ad], 1, "arenda-kvartir"), 1)).toThrow("scope"); });
  it("returns the author ID from the listing and treats a missing or malformed one as unknown", () => {
    expect(parseSomonListingPage(html([{ ...ad, user: { id: 7001, name: "A" } }]), 1).ads[0].sellerId).toBe("7001");
    expect(parseSomonListingPage(html([ad]), 1).ads[0].sellerId).toBeNull();
    expect(somonListingSellerId({ user: { id: "7001" } })).toBe("7001");
    expect(somonListingSellerId({ user: { id: "7001x" } })).toBeNull();
    expect(somonListingSellerId({ user: { id: -1 } })).toBeNull();
    expect(somonListingSellerId({ user: { id: "1".repeat(21) } })).toBeNull();
    expect(somonListingSellerId({ user: null })).toBeNull();
  });
});
