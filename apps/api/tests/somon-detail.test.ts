import { describe, expect, it } from "vitest";
import { parseSomonDetail } from "../src/lib/somonLeads/detail.js";
const detail = { id: 42, name: "2-комн. квартира", description: "Собственник", price: { price: "800 000 c." }, location: { name: "Душанбе" }, gallery: { preview: ["https://cdntj.somon.tj/test.jpg"] }, user: { name: "Продавец", active_adverts: "2 активных объявления", is_business_account: false, is_company: false }, categories: [{ slug: "nedvizhimost" }, { slug: "prodazha-kvartir" }], is_closed: false };
describe("Somon card boundary", () => {
  it("uses the total ad count conservatively and keeps an allowed image", () => {
    const parsed = parseSomonDetail(detail, "42");
    expect(parsed.assessment.status).toBe("likely_owner");
    expect(parsed.image).toBe("https://cdntj.somon.tj/test.jpg");
  });
  it("does not infer owner when the count is unknown", () => {
    expect(parseSomonDetail({ ...detail, user: { ...detail.user, active_adverts: null } }, "42").assessment.status).toBe("review");
  });
  it("does not pass an untrusted image host or a mismatching ID", () => {
    expect(parseSomonDetail({ ...detail, gallery: { preview: ["https://example.org/a"] } }, "42").image).toBeNull();
    expect(() => parseSomonDetail(detail, "43")).toThrow();
  });
  it("rejects closed-state ambiguity and marks other cities or categories out of scope", () => {
    expect(() => parseSomonDetail({ ...detail, is_closed: undefined }, "42")).toThrow();
    expect(parseSomonDetail({ ...detail, location: { name: "Худжанд" } }, "42").inScope).toBe(false);
    expect(parseSomonDetail({ ...detail, categories: [{ slug: "arenda-kvartir" }] }, "42").inScope).toBe(false);
  });
});
