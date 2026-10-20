import { describe, expect, it } from "vitest";
import type { PropertyDraftView } from "@royal-home/shared";
import { recoverDraftValues } from "../recoverDraftValues";
import { EMPTY_WIZARD_VALUES } from "../types";

const draft = { id: "draft-1", revision: 3, updatedAt: "2026-10-20T10:00:00Z", values: { price: "10" }, media: [] } as unknown as PropertyDraftView;
describe("local draft recovery before autosave", () => {
  it("preserves newer offline edits while keeping the current server identity and media", () => {
    const recovered = recoverDraftValues(draft, { at: Date.parse(draft.updatedAt) + 1000, value: { ...EMPTY_WIZARD_VALUES, price: "20" } });
    expect(recovered.values.price).toBe("20");
    expect(recovered.id).toBe(draft.id);
    expect(recovered.media).toBe(draft.media);
  });
  it("does not replace newer server data or recover an empty backup", () => {
    expect(recoverDraftValues(draft, { at: 0, value: { ...EMPTY_WIZARD_VALUES, price: "20" } })).toBe(draft);
    expect(recoverDraftValues(draft, { at: Date.now(), value: { ...EMPTY_WIZARD_VALUES } })).toBe(draft);
  });
  it("recovers dirty fields even when a later media upload touched server updatedAt", () => {
    const recovered = recoverDraftValues(draft, { at: Date.parse(draft.updatedAt) - 1000,
      value: { ...EMPTY_WIZARD_VALUES, price: "20" }, context: { draftId: draft.id, baseRevision: draft.revision, dirty: true } });
    expect(recovered.values.price).toBe("20");
  });
  it("does not mix another draft generation or an acknowledged backup into current server values", () => {
    const value = { ...EMPTY_WIZARD_VALUES, price: "20" };
    expect(recoverDraftValues(draft, { at: Date.now(), value, context: { draftId: "old-draft", baseRevision: 0, dirty: true } })).toBe(draft);
    expect(recoverDraftValues(draft, { at: Date.now(), value, context: { draftId: draft.id, baseRevision: 2, dirty: false } })).toBe(draft);
  });
});
