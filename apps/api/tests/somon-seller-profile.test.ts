import { describe, expect, it } from "vitest";
import { parseSellerProfile, parseSiblingCategory } from "../src/lib/somonLeads/sellerProfile.js";

const cards = (ids: number[]) => ids.map(id => `<div class="advert-grid" data-advert-id="${id}"><a href="/adv/${id}_example/">item</a></div>`).join("");
const html = (ids: number[], count = ids.length) => `<a href="/items/author/7/">seller</a><span>Найдено ${count} объявлений</span>${cards(ids)}`;
describe("Somon seller profile completeness", () => {
  it("includes the current advert and both unrelated ads", () => expect(parseSellerProfile(html([1, 2, 3]), 7, "1", 3)).toEqual(["2_example", "3_example"]));
  it("never treats an incomplete, repeated or changed page as complete", () => {
    expect(parseSellerProfile(html([1, 2], 3), 7, "1", 3)).toBeNull();
    expect(parseSellerProfile(html([1, 2, 2]), 7, "1", 3)).toBeNull();
    expect(parseSellerProfile(html([1, 2, 3]) + '<a href="/items/author/7/?page=2">2</a>', 7, "1", 3)).toBeNull();
    expect(parseSellerProfile(html([1, 2, 3]), 7, "9", 3)).toBeNull();
  });
  it("counts actual category, checks seller identity and refuses ambiguity", () => {
    const card = { id: 2, is_closed: false, user: { id: 7 }, categories: [{ slug: "vakansii" }] };
    expect(parseSiblingCategory(card, 7, "2_example")).toBe(false);
    expect(parseSiblingCategory({ ...card, categories: [{ slug: "nedvizhimost" }] }, 7, "2_example")).toBe(true);
    expect(parseSiblingCategory({ ...card, user: { id: 8 } }, 7, "2_example")).toBeNull();
    expect(parseSiblingCategory({ ...card, categories: [] }, 7, "2_example")).toBeNull();
    expect(parseSiblingCategory({ ...card, categories: [{ slug: "prodazha-kvartir" }] }, 7, "2_example")).toBeNull();
    expect(parseSiblingCategory({ ...card, categories: [{ slug: "vakansii" }, { slug: "nedvizhimost" }] }, 7, "2_example")).toBeNull();
  });
});
