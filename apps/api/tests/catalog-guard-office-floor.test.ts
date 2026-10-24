import { describe, expect, it } from "vitest";
import { findOffCatalogClaims } from "../src/ai/catalogClaimsGuard.js";

// Живой звонок 24.10.2026: робот назвал адрес офиса для собеседования, сторож принял
// «втором этаже» за выдуманный этаж квартиры и оборвал приглашение.
describe("office floor is a legitimate fact", () => {
  it("does not flag the office floor named in words", () => {
    const claims = findOffCatalogClaims({ text: "Ждём вас на улице Бухоро, дом сорок девять, в здании Бухоро Тауэр, на втором этаже.", allowedText: "", catalogText: "" });
    expect(claims.floors).toEqual([]);
  });
  it("still flags a floor that is neither in the catalog nor the office", () => {
    const claims = findOffCatalogClaims({ text: "Квартира на седьмом этаже.", allowedText: "", catalogText: "" });
    expect(claims.floors).toEqual([7]);
  });
});
