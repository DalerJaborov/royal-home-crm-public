import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { inboxConversationId } from "../inboxLink";

/** Аудит 04.10.2026, WEB-PAGES01: вкладка канала не управляла адресатом текста и голосового. */
const read = (rel: string) => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), "utf8");

describe("id диалога для отправки из карточки", () => {
  it("Telegram and Telegram Direct retain distinct source IDs", () => {
    expect(inboxConversationId("TELEGRAM", "abc")).toBe("tg_abc");
    expect(inboxConversationId("TELEGRAM_DIRECT", "abc")).toBe("td_abc");
    expect(inboxConversationId("INSTAGRAM", "abc")).toBe("abc");
    expect(inboxConversationId("WHATSAPP", "abc")).toBe("abc");
  });
});

describe("хуки и панель передают выбранный диалог", () => {
  const hooks = read("../../hooks/useClients.ts");

  it("текст: conversationId уходит в тело запроса", () => {
    const hook = hooks.slice(hooks.indexOf("export function useSendClientMessage"), hooks.indexOf("export function useSendClientVoiceMessage"));
    expect(hook).toContain("conversationId");
    expect(hook).toMatch(/body:\s*\{\s*text,\s*conversationId\s*\}/);
  });

  it("голосовое: conversationId уходит полем формы", () => {
    const hook = hooks.slice(hooks.indexOf("export function useSendClientVoiceMessage"), hooks.indexOf("Звонок из карточки клиента"));
    expect(hook).toContain('form.append("conversationId"');
  });

  it("client chat renders one chronological timeline and requires an explicit send target", () => {
    const panel = read("../../components/ClientChatPanel.tsx");
    expect(panel).toMatch(/useSendClientMessage\(clientId,\s*sendConversationId\)/);
    expect(panel).toMatch(/useSendClientVoiceMessage\(clientId,\s*sendConversationId\)/);
    expect(panel).toContain("inboxConversationId(source.channel, source.id)");
    expect(panel).toContain("sourceConversationId: sourceId");
    expect(panel).toContain("sourceChannel: source.channel");
    expect(panel).toContain("Date.parse(a.message.at)");
    expect(panel).toContain("setSelectedSendTarget");
    expect(panel).toContain("canReply !== false");
    expect(panel).not.toContain('role="tablist" aria-label="Каналы переписки"');
  });

  it("mobile inbox opens grouped details and routes sends only to the selected source", () => {
    const mobile = read("../../components/mobile/MobileChatView.tsx");
    expect(mobile).toContain("useGroupedConversation(isGrouped ? id : null)");
    expect(mobile).toContain("const replyTargetId = isGrouped ? selectedReplySource?.id ?? null : id");
    expect(mobile).toContain("useReplyToConversation(replyTargetId)");
    expect(mobile).toContain("disabled={loadFailed || !replyTargetId}");
    expect(mobile).toContain('m.sourceChannel === "TELEGRAM_DIRECT" ? content');
  });

  it("desktop inbox opts into exact-client groups while retaining separate source IDs", () => {
    const messages = read("../../pages/Messages.tsx");
    expect(messages).toContain("grouped: true");
    expect(messages).toContain("useGroupedConversation(isGroupedEntry ? id : null)");
    expect(messages).toContain("const replyTargetId = isGroupedEntry ? (replySource?.id ?? null) : id");
    expect(messages).toContain("m.sourceConversationId)} />");
  });
});
