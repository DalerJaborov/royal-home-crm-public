// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import type { ConversationMessage } from "../../../types";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { autoReplySourceId, chatTitle, isGroupTail, messageInfoRows, sameSide } from "./chatThread";
import { isLongPressTarget, swallowNextClick } from "./RoyalMessageInfo";

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
  it("prefers a channel whose 24-hour window is still open (ревью #332)", () => {
    const now = new Date("2026-11-20T12:00:00Z");
    const withTg = [...sources, { id: "tg", channel: "TELEGRAM", canReply: true }];
    const msgs: ConversationMessage[] = [
      { role: "user", content: "x", sourceConversationId: "tg", at: "2026-11-18T10:00:00Z" },
      { role: "user", content: "x", sourceConversationId: "ig", at: "2026-11-19T08:00:00Z" },
    ];
    // Instagram — последний, но окно закрыто (28 ч); у Telegram окна нет вовсе.
    expect(autoReplySourceId(msgs, withTg, now)).toBe("tg");
    // Все окна закрыты — где клиент писал последним (строка о закрытом окне подскажет).
    expect(autoReplySourceId(msgs, sources, now)).toBe("ig");
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

describe("sameSide — одна сторона разговора", () => {
  it("bot and agent are one side, a new day splits", () => {
    const day = (d: string) => (a: string, b: string) => a.slice(0, 10) === b.slice(0, 10) && !!d;
    expect(sameSide({ role: "assistant", content: "", at: at(10), by: { kind: "bot" } }, { role: "assistant", content: "", at: at(11), by: { kind: "agent", agentId: "1", agentName: "А" } }, day("x"))).toBe(true);
    expect(sameSide({ role: "user", content: "", at: at(10, 19) }, { role: "user", content: "", at: at(10, 20) }, day("x"))).toBe(false);
    expect(sameSide(undefined, { role: "user", content: "" }, day("x"))).toBe(false);
  });
});

describe("долгое нажатие и шторка «Сведения» (ревью #332)", () => {
  it("long press is for the empty part of a bubble — text keeps native selection", () => {
    document.body.innerHTML = '<div data-chat-message="m1"><span class="ry-msg-text"><b>Текст</b></span><span class="tm">10:00</span><button>x</button></div>';
    expect(isLongPressTarget(document.querySelector(".ry-msg-text b"))).toBeNull();
    expect(isLongPressTarget(document.querySelector("button"))).toBeNull();
    expect(isLongPressTarget(document.querySelector(".tm"))?.dataset.chatMessage).toBe("m1");
  });
  it("swallows exactly one click after the sheet opened (iOS lift-off click)", () => {
    const seen: string[] = [];
    document.body.innerHTML = "<button id=b>x</button>";
    const button = document.getElementById("b")!;
    button.addEventListener("click", () => seen.push("click"));
    swallowNextClick();
    button.click();
    expect(seen).toEqual([]);
    button.click();
    expect(seen).toEqual(["click"]);
  });
  it("the chats layer never switches text selection off and keeps service buttons at 44px", () => {
    const css = readFileSync(resolve(process.cwd(), "src/theme-look-royal-chats.css"), "utf8");
    expect(css).not.toMatch(/user-select:\s*none/);
    const service = css.slice(css.indexOf(".ry-service-acts button {"));
    expect(service.slice(0, service.indexOf("}"))).toMatch(/min-height:\s*44px/);
  });
});
