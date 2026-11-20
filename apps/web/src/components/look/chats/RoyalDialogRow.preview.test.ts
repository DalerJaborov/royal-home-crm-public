import { describe, expect, it } from "vitest";
import { MESSAGE_PHONE_MASK } from "@royal-home/shared";
import { previewText } from "./RoyalDialogRow";

/** Превью последней реплики в списке чатов: «****» на месте номера — словами (ревью #328). */
describe("previewText", () => {
  it("скрытый номер — «номер скрыт», остальной текст как есть", () => {
    expect(previewText(`звоните ${MESSAGE_PHONE_MASK}, после обеда`)).toBe("звоните номер скрыт, после обеда");
    expect(previewText("без номера")).toBe("без номера");
  });
});
