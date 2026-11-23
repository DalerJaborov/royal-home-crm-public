import { describe, expect, it } from "vitest";
import { MESSAGE_PHONE_MASK } from "@royal-home/shared";
import { previewText } from "./RoyalDialogRow";

/** Превью последней реплики в списке чатов: «****» на месте номера — словами (ревью #328). */
describe("previewText", () => {
  it("служебная пометка бота в списке чатов — словами, а не скобками", () => {
    expect(previewText("[вложение без текста]", "WHATSAPP")).toBe("Клиент прислал файл — в CRM он не сохранился, посмотрите в WhatsApp");
    expect(previewText("[сообщение без текста]")).toBe("Сообщение без текста (реакция или место)");
  });
  it("скрытый номер — «номер скрыт», остальной текст как есть", () => {
    expect(previewText(`звоните ${MESSAGE_PHONE_MASK}, после обеда`)).toBe("звоните номер скрыт, после обеда");
    expect(previewText("без номера")).toBe("без номера");
  });
});
