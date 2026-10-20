import { describe, expect, it } from "vitest";
import { clientDraftKind, isClientDraftUnchanged, type ClientFormDraft } from "../clientFormDraft";

describe("client form draft kind", () => {
  const form = { fullName: "", phone: "" };
  it.each([ ["BUYER", "SELLER"], ["SELLER", "BUYER"] ] as const)("retains %s -> %s through a serialized snapshot", (initialKind, selectedKind) => {
    const snapshot: ClientFormDraft<typeof form> = { version: 1, form, step: 3, newKind: selectedKind };
    const restored = JSON.parse(JSON.stringify(snapshot)) as typeof snapshot;
    expect(clientDraftKind(restored, initialKind)).toBe(selectedKind);
    expect(isClientDraftUnchanged(restored, form, initialKind, false)).toBe(false);
    expect(restored.step).toBe(3);
  });
  it("treats a type-only change as dirty and switching back as unchanged", () => {
    expect(isClientDraftUnchanged({ form, newKind: "SELLER" }, form, "BUYER", false)).toBe(false);
    expect(isClientDraftUnchanged({ form, newKind: "BUYER" }, form, "BUYER", false)).toBe(true);
  });
  it("keeps the historical entry kind and ignores kind when editing an existing contact", () => {
    expect(clientDraftKind({}, "SELLER")).toBe("SELLER");
    expect(clientDraftKind({ newKind: "OTHER" }, "BUYER")).toBe("BUYER");
    expect(isClientDraftUnchanged({ form, newKind: "BUYER" }, form, "SELLER", true)).toBe(true);
    expect(isClientDraftUnchanged({ form: { ...form, phone: "123" }, newKind: "BUYER" }, form, "SELLER", true)).toBe(false);
  });
});
