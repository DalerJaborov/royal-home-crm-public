import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { clientQuerySchema } from "@royal-home/shared";
import type { Client } from "../../types";
import { showingClientView, showingSearchState } from "./showingClientView";
const client = { id: "client-real-id", shortId: 42, fullName: "Амина", displayName: "Амина · заявка", kind: "BUYER", phone: "+992 ••• •• 42", budgetMin: "50000", budgetMax: "70000", currency: "USD", desiredType: "APARTMENT", desiredRooms: 3, desiredDistrict: { name: "Сино" }, assignedAgent: { fullName: "Фаррух" } } as Client;
describe("showing client presentation", () => {
  it("preserves server masking, display name, code and responsible agent", () => {
    const view = showingClientView(client);
    expect(view.phone).toBe(client.phone);
    expect(view.name).toBe(client.displayName);
    expect(view.identity).toContain("000042");
    expect(view.agent).toBe("Фаррух");
    for (const text of ["Ищет:", "3 комн.", "Сино", "50", "70"]) expect(view.request).toContain(text);
  });
  it("does not present old buyer requirements as current seller facts", () => {
    const view = showingClientView({ ...client, kind: "SELLER", requirementsFieldsKind: "BUYER" });
    expect(view.identity).toContain("Продавец");
    expect(view.request).toContain("после смены типа");
    expect(view.request).not.toContain("Сино");
    expect(view.request).not.toContain("50");
  });
  it("accepts current seller fields and legacy null requirements provenance", () => {
    expect(showingClientView({ ...client, kind: "SELLER", requirementsFieldsKind: "SELLER" }).request).toContain("Объект продавца:");
    expect(showingClientView({ ...client, requirementsFieldsKind: null }).request).toContain("Сино");
  });
  it("does not invent housing requirements or an assignee for OTHER", () => {
    const view = showingClientView({ ...client, kind: "OTHER", assignedAgent: null });
    expect(view.request).toBe("Прочее обращение");
    expect(view.agent).toBeNull();
  });
  it("distinguishes errors and loading from an empty response", () => {
    expect(showingSearchState(false, true, 0)).toBe("error");
    expect(showingSearchState(true, false, 0)).toBe("loading");
    expect(showingSearchState(false, false, 0)).toBe("empty");
    expect(showingSearchState(false, false, 1)).toBe("ready");
  });
  it("uses a page size accepted by the actual API contract", () => {
    expect(clientQuerySchema.safeParse({ page: 1, pageSize: 12 }).success).toBe(true);
  });
  it("preserves the real interaction IDs/type and opt-in legacy boundary", () => {
    const source = readFileSync(new URL("../ShowingQuickForm.tsx", import.meta.url), "utf8");
    for (const contract of ['clean = false', 'clientId={picked.id}', 'initialType="SHOWING"', 'initialPropertyId={initialPropertyId}', 'isSeller={picked.kind === "SELLER"}', 'useDebouncedValue(query.trim(), 250)', 'onClick={() => setPicked(client)}', 'found.refetch()']) expect(source).toContain(contract);
    expect(source.indexOf('if (picked)')).toBeLessThan(source.indexOf('if (clean)'));
    expect(source).toContain('className="row" style={RH2_ROW_BUTTON} onClick={() => setPicked(c)}');
  });
});
