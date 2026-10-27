import { describe, expect, it } from "vitest";
import { assessSeller } from "../src/lib/somonLeads/sellerAssessment.js";

describe("Somon seller evidence", () => {
  it("does not treat a missing business flag as proof of ownership", () => {
    expect(assessSeller({ businessAccount: null, distinctApartments: null, name: "", description: "" }).status).toBe("review");
  });
  it("uses the owner's claim only as a likelihood", () => {
    expect(assessSeller({ businessAccount: false, distinctApartments: 2, name: "", description: "Собственник" }).status).toBe("likely_owner");
  });
  it("keeps a self-described owner with more than two apartments for review", () => {
    expect(assessSeller({ businessAccount: false, distinctApartments: 3, name: "", description: "Собственник" }).status).toBe("review");
  });
  it("recognizes an explicit business profile", () => {
    expect(assessSeller({ businessAccount: true, distinctApartments: 1, name: "Собственник", description: "" }).status).toBe("agency");
  });
  it("does not interpret a negated owner claim as a positive signal", () => {
    expect(assessSeller({ businessAccount: false, distinctApartments: 1, name: "", description: "Я не собственник" }).status).toBe("review");
  });
});
