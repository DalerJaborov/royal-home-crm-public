import { describe, expect, it } from "vitest";
import { extractAds, extractNextPayload, toListing } from "../src/lib/somonLeads/listingParser.js";

describe("Somon listing parser", () => {
  it("parses a split Next payload without treating an absent business flag as false", () => {
    const ad = JSON.stringify({ id: 42, title: "2-комн. квартира, 3 этаж, 65 м², Сино", url: "/adv/42_example/", user: { id: 1, name: "A" } });
    const a = ad.slice(0, 27), b = ad.slice(27);
    const html = `self.__next_f.push([1,${JSON.stringify(a)}]);self.__next_f.push([1,${JSON.stringify(b)}]);`;
    const parsed = extractAds(extractNextPayload(html));
    expect(parsed).toHaveLength(1);
    expect(toListing(parsed[0])?.isAgency).toBeNull();
    expect(toListing(parsed[0])?.rooms).toBe(2);
  });
  it("deduplicates repeated IDs", () => {
    const ad = JSON.stringify({ id: 42, title: "Квартира", url: "/adv/42_example/" });
    expect(extractAds(`${ad}${ad}`)).toHaveLength(1);
  });
});
