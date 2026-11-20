import { describe, expect, it } from "vitest";
import type { ConversationMessage } from "../../../types";
import { autoReplySourceId, chatTitle, isGroupTail, messageInfoRows } from "./chatThread";

const at = (h: number, day = 20) => `2026-11-${day}T${String(h).padStart(2, "0")}:00:00Z`;
const sameDay = (a: string, b: string) => a.slice(0, 10) === b.slice(0, 10);

describe("chatTitle — имя в шапке переписки", () => {
  it("drops the card code from a stub and names the channel instead", () => {
    expect(chatTitle("Продавец ПР-000894", "FACEBOOK")).toEqual({ title: "Продавец из Facebook", code: "ПР-000894" });
    expect(chatTitle("Покупатель ПК-000058", "WHATSAPP")).toEqual({ title: "Покупатель из WhatsApp", code: "ПК-000058" });
    expect(chatTitle("Продавец ПР-000894", null)).toEqual({ title: "Продавец", code: "ПР-000894" });
  });
  it("keeps a real name as is", () => {
    expect(chatTitle("Нигина Юсуфи", "INSTAGRAM")).toEqual({ title: "Нигина Юсуфи", code: null });
    expect(chatTitle("  ", "INSTAGRAM").title).toBe("Без имени");
  });
});

describe("autoReplySourceId — канал ответа в общем чате", () => {
  const sources = [
    { id: "wa", channel: "WHATSAPP", canReply: true },
    { id: "ig", channel: "INSTAGRAM", canReply: true },
    { id: "td", channel: "TELEGRAM_DIRECT", canReply: false },
  ];
  const m = (role: "user" | "assistant", source: string): ConversationMessage => ({ role, content: "x", sourceConversationId: source });
  it("answers where the client wrote last, even if we answered elsewhere after", () => {
    expect(autoReplySourceId([m("user", "wa"), m("user", "ig"), m("assistant", "wa")], sources)).toBe("ig");
  });
  it("skips channels without safe sending", () => {
    expect(autoReplySourceId([m("user", "wa"), m("user", "td")], sources)).toBe("wa");
  });
  it("no inbound in a replyable channel — the last replyable one used; nothing replyable — empty", () => {
    expect(autoReplySourceId([m("assistant", "ig")], sources)).toBe("ig");
    expect(autoReplySourceId([], sources)).toBe("ig");
    expect(autoReplySourceId([m("user", "wa")], [{ id: "td", channel: "TELEGRAM_DIRECT", canReply: false }])).toBe("");
  });
});

describe("isGroupTail — хвостик у последней реплики группы", () => {
  const u = (h: number, day?: number): ConversationMessage => ({ role: "user", content: "x", at: at(h, day) });
  const a = (h: number, kind: "bot" | "agent" = "bot"): ConversationMessage => ({ role: "assistant", content: "x", at: at(h), by: kind === "bot" ? { kind } : { kind, agentId: "1", agentName: "Азиз" } });
  it("bot and agent are one side: no tail between them", () => {
    expect(isGroupTail(a(10, "bot"), a(11, "agent"), sameDay)).toBe(false);
    expect(isGroupTail(a(11, "agent"), u(12), sameDay)).toBe(true);
  });
  it("a new day or the end of the list closes the group", () => {
    expect(isGroupTail(u(10, 19), u(10, 20), sameDay)).toBe(true);
    expect(isGroupTail(u(10), undefined, sameDay)).toBe(true);
    expect(isGroupTail(u(10), u(11), sameDay)).toBe(false);
  });
});

describe("messageInfoRows — сведения о сообщении", () => {
  it("names who answered and the delivery in words; a client message has no status", () => {
    expect(messageInfoRows({ role: "assistant", content: "x", by: { kind: "bot" }, deliveryStatus: "read" })).toEqual([
      { label: "Отправил", value: "Бот" }, { label: "Статус", value: "Прочитано" },
    ]);
    expect(messageInfoRows({ role: "assistant", content: "x", by: { kind: "agent", agentId: "1", agentName: "Азиз" } })).toEqual([{ label: "Отправил", value: "Азиз" }]);
    expect(messageInfoRows({ role: "assistant", content: "x", by: { kind: "manual" } })[0].value).toBe("Вручную из мессенджера");
    expect(messageInfoRows({ role: "user", content: "x", deliveryStatus: "read" })).toEqual([{ label: "Отправил", value: "Клиент" }]);
  });
  it("shows the time only when it is known — never «время неизвестно»", () => {
    expect(messageInfoRows({ role: "user", content: "x", at: at(10) })[0].label).toBe("Время");
    expect(JSON.stringify(messageInfoRows({ role: "user", content: "x" }))).not.toContain("неизвест");
  });
});
