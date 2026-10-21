import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { ClientCardFacts, clientPropertyCountVisible } from "./ClientCardContext";
import type { Client } from "../types";

const buyer = { kind: "BUYER", dualIntent: false, desiredType: "APARTMENT", desiredRooms: 2,
  desiredDistrict: { name: "Центр" }, budgetMin: "500000", budgetMax: "600000", currency: "TJS",
  sellerDeclaredPropertyCount: 3, buyerDesiredPropertyCount: 1 } as Client;

describe("client overview role facts", () => {
  it("does not present retained buyer requirements or a buyer counter to a pure seller", () => {
    const seller = { ...buyer, kind: "SELLER" } as Client;
    expect(renderToStaticMarkup(<ClientCardFacts client={seller} />)).toBe("");
    expect(clientPropertyCountVisible(seller, "BUYER")).toBe(false);
    expect(clientPropertyCountVisible(seller, "SELLER")).toBe(true);
  });
  it("shows the real buyer range instead of silently dropping its lower boundary", () => {
    const html = renderToStaticMarkup(<ClientCardFacts client={buyer} />);
    expect(html).toContain("Ищет:"); expect(html).toContain("2 комн."); expect(html).toContain("Центр");
    expect(html).toContain("500"); expect(html).toContain("600");
    expect(clientPropertyCountVisible(buyer, "SELLER")).toBe(false);
  });
  it("asks to clarify retained requirements of a previous role without exposing them as a current buying request", () => {
    const html = renderToStaticMarkup(<ClientCardFacts client={{ ...buyer, requirementsFieldsKind: "SELLER" }} />);
    expect(html).toContain("Параметры покупки нужно уточнить");
    expect(html).not.toContain("Центр"); expect(html).not.toContain("500");
  });
  it("keeps buyer facts for an effective dual-role seller and both counters only when present", () => {
    const dual = { ...buyer, kind: "SELLER", dualIntent: true, requirementsFieldsKind: "BUYER" } as Client;
    expect(renderToStaticMarkup(<ClientCardFacts client={dual} />)).toContain("Ищет:");
    expect(clientPropertyCountVisible(dual, "BUYER")).toBe(true);
    expect(clientPropertyCountVisible(dual, "SELLER")).toBe(true);
    expect(clientPropertyCountVisible({ ...dual, buyerDesiredPropertyCount: null }, "BUYER")).toBe(false);
  });
});
