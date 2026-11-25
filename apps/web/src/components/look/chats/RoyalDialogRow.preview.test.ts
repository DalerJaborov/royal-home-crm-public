import { describe, expect, it } from "vitest";
import { MESSAGE_PHONE_MASK } from "@royal-home/shared";
import { previewText } from "./RoyalDialogRow";

/** Превью последней реплики в списке чатов: «****» на месте номера — словами (ревью #328). */
describe("previewText", () => {
  it("служебная пометка бота в списке чатов — словами, а не скобками", () => {
    // В списке вложений реплики не видно: файл мог сохраниться позже (25.11.2026) — без «не сохранился».
    expect(previewText("[вложение без текста]", "WHATSAPP")).toBe("Клиент прислал файл");
    expect(previewText("[сообщение без текста]")).toBe("Сообщение без текста (реакция или место)");
  });
  it("скрытый номер — «номер скрыт», остальной текст как есть", () => {
    expect(previewText(`звоните ${MESSAGE_PHONE_MASK}, после обеда`)).toBe("звоните номер скрыт, после обеда");
    expect(previewText("без номера")).toBe("без номера");
  });
});
