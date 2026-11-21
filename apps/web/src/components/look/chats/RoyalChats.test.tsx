// @vitest-environment jsdom
import { act, createElement } from "react";
import * as ReactDomClient from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import type { ConversationListItem } from "../../../hooks/useConversations";
import { chatQuickReplies } from "../../../lib/chatQuickReplies";
import { chatWaiting, rowWaiting, RoyalDialogRow } from "./RoyalDialogRow";
import { RoyalInboxFilters, segmentByArrow } from "./RoyalInboxFilters";
import { useMinuteClock } from "./useMinuteClock";

// Кто смотрит список: «Вы:» — только его собственные сообщения (ревью #332).
const viewer = vi.hoisted(() => ({ id: null as string | null }));
vi.mock("../../../store/auth", () => ({ useAuthStore: (select: (state: { agent: { id: string } | null }) => unknown) => select({ agent: viewer.id ? { id: viewer.id } : null }) }));

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

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
const row = (over: Partial<ConversationListItem> = {}, extra: { showAccount?: boolean; now?: number; showBotState?: boolean } = {}) =>
  renderToStaticMarkup(createElement(RoyalDialogRow, { conversation: item(over), selected: false, showAccount: extra.showAccount ?? false, onSelect: () => {}, now: extra.now ?? Date.now(), showBotState: extra.showBotState }));

describe("chatWaiting — сколько ждёт человек и насколько срочно", () => {
  it("follows the mockup thresholds: >15 min attention, from an hour urgent", () => {
    expect(chatWaiting(null, NOW)).toBeNull();
    expect(chatWaiting(minutesAgo(0), NOW)).toMatchObject({ label: "сейчас", tone: "calm" });
    expect(chatWaiting(minutesAgo(15), NOW)).toMatchObject({ label: "15 мин", tone: "calm" });
    expect(chatWaiting(minutesAgo(16), NOW)).toMatchObject({ label: "16 мин", tone: "warn" });
    expect(chatWaiting(minutesAgo(60), NOW)).toMatchObject({ label: "1 ч", tone: "crit" });
    expect(chatWaiting(minutesAgo(26 * 60), NOW)).toMatchObject({ label: "1 дн", tone: "crit" });
    expect(chatWaiting("not a date", NOW)).toBeNull();
  });
  it("an abandoned chat older than a day is calm unless the bot is paused", () => {
    expect(rowWaiting({ awaitingHumanSince: minutesAgo(23 * 60), paused: false }, NOW)).toMatchObject({ tone: "crit" });
    expect(rowWaiting({ awaitingHumanSince: minutesAgo(24 * 60), paused: false }, NOW)).toBeNull();
    expect(rowWaiting({ awaitingHumanSince: minutesAgo(3 * 24 * 60), paused: true }, NOW)).toMatchObject({ label: "3 дн", tone: "crit" });
    const html = row({ awaitingHumanSince: minutesAgo(3 * 24 * 60), lastMessageAt: minutesAgo(3 * 24 * 60) }, { now: NOW });
    expect(html).not.toContain("ry-chat-wait");
    expect(html).toContain("ry-chat-time");
  });
});

describe("RoyalDialogRow — время не застывает в memo", () => {
  it("re-renders the waiting label from the `now` prop", () => {
    const c = { awaitingHumanSince: minutesAgo(0) };
    expect(row(c, { now: NOW })).toContain("Ждёт ответа сейчас");
    expect(row(c, { now: NOW + 61 * 60_000 })).toContain("Ждёт ответа 1 ч");
  });
  it("useMinuteClock ticks once a minute and stops while the tab is hidden", () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    const seen: number[] = [];
    function Probe() { const now = useMinuteClock(); seen.push(now); return null; }
    const root = document.createElement("div");
    const { createRoot } = ReactDomClient;
    const r = createRoot(root);
    act(() => { r.render(createElement(Probe)); });
    act(() => { vi.advanceTimersByTime(60_000); });
    expect(seen.at(-1)).toBe(NOW + 60_000);
    Object.defineProperty(document, "visibilityState", { configurable: true, get: () => "hidden" });
    act(() => { document.dispatchEvent(new Event("visibilitychange")); });
    const frozen = seen.length;
    act(() => { vi.advanceTimersByTime(5 * 60_000); });
    expect(seen.length).toBe(frozen);
    Object.defineProperty(document, "visibilityState", { configurable: true, get: () => "visible" });
    act(() => { document.dispatchEvent(new Event("visibilitychange")); });
    expect(seen.at(-1)).toBe(NOW + 6 * 60_000);
    act(() => { r.unmount(); });
    vi.useRealTimers();
  });
});

describe("RoyalDialogRow — строка нового вида не теряет пометок прежней", () => {
  it("name, one line of text, channel named in words", () => {
    const html = row({ lastMessage: { role: "assistant", content: "Отправляю адрес", by: { kind: "bot" } } });
    expect(html).toContain("Ситора Ахмедова");
    // Ответ бота — просто текст: ни «Бот:», ни «Вы:» (ревью #332).
    expect(html).toContain("Отправляю адрес");
    expect(html).not.toContain("Бот:");
    expect(html).not.toContain("Вы:");
    // «Вы:» — только своё сообщение того, кто смотрит; коллега — без подписи.
    viewer.id = "me";
    try {
      const mine = { role: "assistant" as const, content: "Здравствуйте", by: { kind: "agent" as const, agentId: "me", agentName: "Я" } };
      expect(row({ lastMessage: mine })).toContain("Вы: Здравствуйте");
      expect(row({ lastMessage: { ...mine, by: { kind: "agent", agentId: "a", agentName: "Азиз" } } })).not.toContain("Вы:");
    } finally {
      viewer.id = null;
    }
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
    }, { showAccount: true, showBotState: true });
    expect(html).toContain("Просит агента");
    expect(html).toContain("data-attention");
    expect(html).toContain("Непрочитанных сообщений: 4");
    expect(html).toContain("Бот на паузе · 30 ч");
    expect(html).toContain("Royal Home Info");
    // Агенту значок паузы бота не показываем — только руководству; по умолчанию скрыт.
    expect(row({ paused: true }, { showBotState: false })).not.toContain("Бот на паузе");
    expect(row({ paused: true })).not.toContain("Бот на паузе");
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
  it("arrow keys move between segments in a loop; only the checked one is in Tab order", () => {
    expect(segmentByArrow("needsHuman", "ArrowRight")).toBe("mine");
    expect(segmentByArrow("all", "ArrowRight")).toBe("needsHuman");
    expect(segmentByArrow("needsHuman", "ArrowLeft")).toBe("all");
    expect(segmentByArrow("paused", "ArrowRight")).toBe("needsHuman");
    expect(segmentByArrow("mine", "End")).toBe("all");
    expect(segmentByArrow("mine", "a")).toBeNull();
    const html = renderToStaticMarkup(createElement(RoyalInboxFilters, {
      segment: "mine", counts: null, onSegmentChange: () => {}, moreActive: false, children: null,
    }));
    expect(html.match(/tabindex="0"/g)?.length).toBe(1);
    // Порядок атрибутов не важен: важно, что выбранный срез один и он же в Tab-порядке.
    expect(html).toMatch(/<button[^>]*data-segment="mine"[^>]*aria-checked="true"[^>]*tabindex="0"/);
    expect(html).toContain('class="ry-seg ry-chats-seg"');
  });
  it("«Ещё» closes on a click outside and after a choice", () => {
    let segment = "all";
    const root = document.createElement("div");
    document.body.append(root);
    const r = ReactDomClient.createRoot(root);
    const render = () => r.render(createElement(RoyalInboxFilters, {
      segment: segment as "all", counts: null, onSegmentChange: (s) => { segment = s; }, moreActive: false,
      children: createElement("button", { type: "button" }, "Бот на паузе"),
    }));
    act(render);
    const details = root.querySelector("details")!;
    act(() => { details.open = true; details.dispatchEvent(new Event("toggle")); });
    expect(details.open).toBe(true);
    act(() => { document.body.click(); });
    expect(root.querySelector("details")!.open).toBe(false);
    act(() => { details.open = true; details.dispatchEvent(new Event("toggle")); });
    act(() => { root.querySelector<HTMLButtonElement>(".ry-chats-more-body button")!.click(); });
    expect(root.querySelector("details")!.open).toBe(false);
    act(() => { r.unmount(); });
    root.remove();
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
