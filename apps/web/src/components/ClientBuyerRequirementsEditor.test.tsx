import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { clientBuyerRequirementsSchema } from "@royal-home/shared";
import { buyerRequirementsDraft, buyerRequirementsPayload, ClientBuyerRequirementsEditor } from "./ClientBuyerRequirementsEditor";
import type { Client } from "../types";
const client = { id: "buyer-fixture", kind: "BUYER", currency: "USD", requirementsFieldsKind: null,
  budgetMin: "50000", budgetMax: "70000", desiredType: "APARTMENT", desiredRooms: 2,
  desiredDistrictId: null, desiredDistrict: null, desiredAreaMin: 55, desiredFloorMin: 0, desiredFloorMax: 8,
  desiredTotalFloors: 12, requirementsNotes: "Нужен лифт" } as Client;

describe("buyer-specific requirements editor", () => {
  it("preserves trusted legacy buyer fields including the valid zero floor and explicit currency", () => {
    const form = buyerRequirementsDraft(client);
    expect(form.desiredFloorMin).toBe("0"); expect(form.currency).toBe("USD");
    const body = buyerRequirementsPayload(form);
    expect(body).toMatchObject({ budgetMin: 50000, desiredFloorMin: 0, desiredAreaMin: 55, currency: "USD" });
    expect(clientBuyerRequirementsSchema.safeParse(body).success).toBe(true);
    expect(body).not.toHaveProperty("kind"); expect(body).not.toHaveProperty("desiredPlaces");
  });
  it("starts buyer requirements empty when preserved fields explicitly belong to another role", () => {
    const form = buyerRequirementsDraft({ ...client, kind: "SELLER", dualIntent: true, requirementsFieldsKind: "SELLER" });
    expect(form).toMatchObject({ budgetMin: "", budgetMax: "", desiredType: "", desiredRooms: "", desiredAreaMin: "", desiredFloorMin: "", desiredFloorMax: "", requirementsNotes: "", currency: "TJS" });
  });
  it("sends explicit nullable clears and trims notes rather than leaving old conditions behind", () => {
    const form = buyerRequirementsDraft(client);
    const body = buyerRequirementsPayload({ ...form, budgetMin: "", desiredFloorMin: "", desiredRooms: "", requirementsNotes: "   " });
    expect(body).toMatchObject({ budgetMin: null, desiredFloorMin: null, desiredRooms: null, requirementsNotes: null });
    expect(buyerRequirementsPayload({ ...form, requirementsNotes: "  Лифт обязателен  " }).requirementsNotes).toBe("Лифт обязателен");
  });
  it("rejects reversed budgets, reversed floors and invalid bounds through the shared boundary schema", () => {
    const form = buyerRequirementsDraft(client);
    for (const change of [{ budgetMin: "80000", budgetMax: "70000" }, { desiredFloorMin: "9", desiredFloorMax: "3" }, { desiredFloorMax: "201" }, { desiredAreaMin: "0" }, { desiredRooms: "-1" }]) {
      expect(clientBuyerRequirementsSchema.safeParse(buyerRequirementsPayload({ ...form, ...change })).success).toBe(false);
    }
  });
  it("provides a buying-specific entry for a confirmed dual seller and no action for pure sellers, pending or readonly", () => {
    const dual = { ...client, kind: "SELLER", dualIntent: true } as Client;
    expect(renderToStaticMarkup(<ClientBuyerRequirementsEditor client={dual} locked={false} />)).toContain("Уточнить пожелания");
    expect(renderToStaticMarkup(<ClientBuyerRequirementsEditor client={{ ...dual, dualIntent: false }} locked={false} />)).toBe("");
    expect(renderToStaticMarkup(<ClientBuyerRequirementsEditor client={client} locked />)).not.toContain("<button");
    expect(renderToStaticMarkup(<ClientBuyerRequirementsEditor client={{ ...client, pendingAcceptance: true }} locked={false} />)).not.toContain("<button");
  });
});
