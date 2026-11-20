import { describe, expect, it } from "vitest";
import { humanizeAttachmentTags } from "../botMessages";

/**
 * «[вложение без текста]» — служебная пометка, которую пишет бот (lib/customerQualifierLedger.ts),
 * когда клиент прислал только файл. На кадре владельца с iPhone (20.11.2026) она стояла в пузыре
 * дословно, скобками. Если файл показан рядом из `attachments` — пометка лишняя; если нет — одна
 * спокойная фраза, а не скобки.
 */
describe("humanizeAttachmentTags: пометка «вложение без текста»", () => {
  it("без файла рядом — спокойная фраза, без скобок", () => {
    expect(humanizeAttachmentTags("[вложение без текста]", { channel: "WHATSAPP" })).toBe("Клиент прислал файл — в CRM он не сохранился, посмотрите в WhatsApp");
    expect(humanizeAttachmentTags("[сообщение без текста]", { outgoing: false })).toBe("Сообщение без текста (реакция или место)");
  });

  it("файл показан рядом — пометка пропадает целиком", () => {
    expect(humanizeAttachmentTags("[вложение без текста]", { hasAttachments: true })).toBe("");
  });

  it("слова клиента рядом с похожей фразой не трогаются", () => {
    expect(humanizeAttachmentTags("Салом, вот фото [вложение без текста] тут")).toBe("Салом, вот фото [вложение без текста] тут");
    expect(humanizeAttachmentTags("Салом")).toBe("Салом");
  });

  it("прежние «[вложение: image]» работают как раньше", () => {
    expect(humanizeAttachmentTags("[вложение: image]")).toBe("🖼 фото");
  });
});
