import { describe, expect, it } from "vitest";
import { assessSeller } from "../src/lib/somonLeads/sellerAssessment.js";

describe("Somon seller evidence", () => {
  it("does not treat a missing business flag as proof of ownership", () => {
    expect(assessSeller({ businessAccount: null, distinctApartments: null, name: "", description: "" }).status).toBe("review");
  });
  it("uses the owner's claim only as a likelihood", () => {
    expect(assessSeller({ businessAccount: false, distinctApartments: 2, name: "", description: "Собственник" }).status).toBe("likely_owner");
  });
  it("accepts a private profile with one or two property ads without an owner claim", () => {
    expect(assessSeller({ businessAccount: false, distinctApartments: 1, name: "", description: "Продам квартиру" }).status).toBe("likely_owner");
    expect(assessSeller({ businessAccount: false, distinctApartments: 2, name: "", description: "" }).status).toBe("likely_owner");
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
  it("does not automatically classify a mention of an agency as a private owner", () => {
    expect(assessSeller({ businessAccount: false, distinctApartments: 1, name: "", description: "Наше агентство оказывает услуги" }).status).not.toBe("likely_owner");
    expect(assessSeller({ businessAccount: false, distinctApartments: 1, name: "", description: "Продаю без риелтора" }).status).toBe("likely_owner");
    expect(assessSeller({ businessAccount: false, distinctApartments: 1, name: "", description: "Агентство недвижимости, без риелторов" }).status).not.toBe("likely_owner");
  });
});
