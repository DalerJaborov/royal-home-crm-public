import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { ConversationListItem } from "../../../hooks/useConversations";
import { chatQuickReplies } from "../../../lib/chatQuickReplies";
import { chatWaiting, RoyalDialogRow } from "./RoyalDialogRow";
import { RoyalInboxFilters } from "./RoyalInboxFilters";

const NOW = Date.parse("2026-11-18T10:00:00Z");
const minutesAgo = (m: number) => new Date(NOW - m * 60_000).toISOString();

function item(over: Partial<ConversationListItem> = {}): ConversationListItem {
  return {
    id: "c1", channel: "WHATSAPP", name: "Ситора Ахмедова", clientShortId: null,
    lastMessage: { role: "user", content: "Можно завтра?", by: undefined }, lastMessageAt: minutesAgo(5),
    paused: false, awaitingHumanSince: null, pausedSince: null, unread: false, unreadCount: 0, messagesCount: 3,
    accountId: null, accountTitle: null, agentAttentionRequestedAt: null, ...over,
  };
}
const row = (over: Partial<ConversationListItem> = {}, extra: { showAccount?: boolean } = {}) =>
  renderToStaticMarkup(createElement(RoyalDialogRow, { conversation: item(over), selected: false, showAccount: extra.showAccount ?? false, onSelect: () => {} }));

describe("chatWaiting — сколько ждёт человек и насколько срочно", () => {
  it("follows the mockup thresholds: >15 min attention, from an hour urgent", () => {
    expect(chatWaiting(null, NOW)).toBeNull();
    expect(chatWaiting(minutesAgo(0), NOW)).toEqual({ label: "сейчас", tone: "calm" });
    expect(chatWaiting(minutesAgo(15), NOW)).toEqual({ label: "15 мин", tone: "calm" });
    expect(chatWaiting(minutesAgo(16), NOW)).toEqual({ label: "16 мин", tone: "warn" });
    expect(chatWaiting(minutesAgo(60), NOW)).toEqual({ label: "1 ч", tone: "crit" });
    expect(chatWaiting(minutesAgo(26 * 60), NOW)).toEqual({ label: "1 дн", tone: "crit" });
    expect(chatWaiting("not a date", NOW)).toBeNull();
  });
});

describe("RoyalDialogRow — строка нового вида не теряет пометок прежней", () => {
  it("name, one line of text, channel named in words", () => {
    const html = row({ lastMessage: { role: "assistant", content: "Отправляю адрес", by: { kind: "bot" } } });
    expect(html).toContain("Ситора Ахмедова");
    expect(html).toContain("Бот: Отправляю адрес");
    expect(html).toContain("Канал: WhatsApp");
    expect(html).toContain('data-channel="WHATSAPP"');
  });
  it("waiting time instead of clock time when a person waits", () => {
    const html = row({ awaitingHumanSince: new Date(Date.now() - 90 * 60_000).toISOString() });
    expect(html).toContain('data-tone="crit"');
    expect(html).toContain("Ждёт ответа 1 ч");
  });
  it("keeps «Просит агента», unread count, paused bot with hours and our account", () => {
    const html = row({
      agentAttentionRequestedAt: minutesAgo(3), unread: true, unreadCount: 4, paused: true,
      awaitingHumanSince: new Date(Date.now() - 30 * 3_600_000).toISOString(), accountTitle: "Royal Home Info",
    }, { showAccount: true });
    expect(html).toContain("Просит агента");
    expect(html).toContain("data-attention");
    expect(html).toContain("Непрочитанных сообщений: 4");
    expect(html).toContain("Бот на паузе · 30 ч");
    expect(html).toContain("Royal Home Info");
  });
  it("unread without a count falls back to a dot, like the previous row", () => {
    expect(row({ unread: true, unreadCount: undefined })).toContain("Есть непрочитанное сообщение");
  });
});

describe("RoyalInboxFilters — один фильтр «Ждут / Мои / Все», редкое под «Ещё»", () => {
  it("renders the three segments in the owner's order with server counts", () => {
    const html = renderToStaticMarkup(createElement(RoyalInboxFilters, {
      segment: "needsHuman", counts: { all: 8, needsHuman: 4, paused: 1, mine: 2 }, onSegmentChange: () => {}, moreActive: false,
      children: createElement("span", null, "Бот на паузе"),
    }));
    const order = ["Ждут", "Мои", "Все"].map((label) => html.indexOf(label));
    expect(order).toEqual([...order].sort((a, b) => a - b));
    expect(html).toMatch(/aria-checked="true"[^>]*>Ждут<b class="ry-num">4<\/b>/);
    expect(html).toContain("Бот на паузе");
  });
  it("marks «Ещё» while a hidden filter is active", () => {
    const html = renderToStaticMarkup(createElement(RoyalInboxFilters, {
      segment: "paused", counts: null, onSegmentChange: () => {}, moreActive: true, children: null,
    }));
    expect(html).toContain("data-active");
    expect(html).not.toContain('aria-checked="true"');
  });
});

describe("chatQuickReplies — одна дверь для телефона и нового вида", () => {
  it("takes the last three short human replies without repeats and never the bot's", () => {
    const at = minutesAgo(1);
    const msgs = [
      { role: "assistant" as const, content: "Старый ответ", at, by: { kind: "agent" as const, agentId: "a", agentName: "А" } },
      { role: "assistant" as const, content: "Ответ бота", at, by: { kind: "bot" as const } },
      { role: "assistant" as const, content: "Отправляю адрес", at, by: { kind: "manual" as const } },
      { role: "assistant" as const, content: "x".repeat(81), at, by: { kind: "agent" as const, agentId: "a", agentName: "А" } },
      { role: "user" as const, content: "Вопрос клиента", at },
      { role: "assistant" as const, content: "отправляю адрес", at, by: { kind: "agent" as const, agentId: "a", agentName: "А" } },
      { role: "assistant" as const, content: "Добрый день", at, by: { kind: "agent" as const, agentId: "a", agentName: "А" } },
    ];
    expect(chatQuickReplies(msgs)).toEqual(["Добрый день", "отправляю адрес", "Старый ответ"]);
    expect(chatQuickReplies([])).toEqual([]);
  });
});
