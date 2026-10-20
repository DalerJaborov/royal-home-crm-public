import { describe, expect, it } from "vitest";
import { parseResultPatch } from "../addInteractionParse";

/** FORMS03: поздний ответ ИИ не стирает заметку, дописанную пока он считал (04.10.2026). */
const TYPES = ["CALL", "VISIT"] as const;
const interaction = {
  type: "CALL",
  outcome: "INTERESTED",
  notes: "A (разобрано)",
  nextAction: "Перезвонить",
  nextActionDate: "2026-10-10",
};

describe("parseResultPatch", () => {
  it("заметка не менялась: поля из ответа применяются", () => {
    expect(parseResultPatch("A", "A", interaction, TYPES)).toEqual({
      type: "CALL",
      outcome: "INTERESTED",
      notes: "A (разобрано)",
      nextAction: "Перезвонить",
      nextActionDate: "2026-10-10",
    });
  });

  it("пока ИИ считал, агент дописал B: ответ на A не применяется", () => {
    expect(parseResultPatch("A", "A и уточнение B", interaction, TYPES)).toBeNull();
  });

  it("чужой тип из ответа игнорируется, пустые поля пропускаются", () => {
    expect(
      parseResultPatch("A", "A", { type: "MEETING", outcome: null, notes: "", nextAction: null }, TYPES)
    ).toEqual({});
  });
});
