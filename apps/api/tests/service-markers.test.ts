import { describe, expect, it } from "vitest";
import { BARE_ATTACHMENT_MARKER, BARE_MESSAGE_MARKER, describeServiceMarker, serviceMarkerKind, whereToLook } from "@royal-home/shared";

/**
 * Служебные пометки бота человеку (20.11.2026): одна функция на чат, список чатов, карточку клиента и push
 * сотрудникам. Честно: файл в CRM не сохранился — смотреть в мессенджере; «без текста» — реакция или место.
 */
describe("describeServiceMarker", () => {
  it("вложение без текста — файл не сохранился, где смотреть — по каналу", () => {
    expect(describeServiceMarker(BARE_ATTACHMENT_MARKER, { channel: "WHATSAPP" })).toBe("Клиент прислал файл — в CRM он не сохранился, посмотрите в WhatsApp");
    expect(describeServiceMarker(BARE_ATTACHMENT_MARKER, { channel: "INSTAGRAM" })).toContain("в Instagram");
    expect(describeServiceMarker(BARE_ATTACHMENT_MARKER)).toContain("в самом мессенджере");
  });
  it("файл показан рядом — пометка лишняя (пустая строка)", () => {
    expect(describeServiceMarker(BARE_ATTACHMENT_MARKER, { hasAttachments: true })).toBe("");
  });
  it("сообщение без текста — отдельная подпись, не про файл", () => {
    expect(describeServiceMarker(BARE_MESSAGE_MARKER, { channel: "WHATSAPP" })).toBe("Сообщение без текста (реакция или место)");
    expect(describeServiceMarker(BARE_MESSAGE_MARKER, { hasAttachments: true })).toBe("Сообщение без текста (реакция или место)");
  });
  it("живой текст клиента не трогается, фраза внутри текста — тоже", () => {
    expect(describeServiceMarker("Салом")).toBeNull();
    expect(describeServiceMarker(`вот ${BARE_ATTACHMENT_MARKER} тут`)).toBeNull();
    expect(serviceMarkerKind(`  ${BARE_MESSAGE_MARKER} `)).toBe("message");
    expect(whereToLook("TELEGRAM_DIRECT")).toBe("в Telegram");
  });
});
