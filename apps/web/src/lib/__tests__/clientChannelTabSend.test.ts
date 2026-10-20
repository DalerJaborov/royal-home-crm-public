import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { inboxConversationId } from "../inboxLink";

/** Аудит 04.10.2026, WEB-PAGES01: вкладка канала не управляла адресатом текста и голосового. */
const read = (rel: string) => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), "utf8");

describe("id диалога для отправки из карточки", () => {
  it("Telegram получает префикс tg_, остальные каналы нет", () => {
    expect(inboxConversationId("TELEGRAM", "abc")).toBe("tg_abc");
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

  it("панель отдаёт обоим хукам диалог выбранной вкладки", () => {
    const panel = read("../../components/ClientChatPanel.tsx");
    expect(panel).toMatch(/useSendClientMessage\(clientId,\s*sendConversationId\)/);
    expect(panel).toMatch(/useSendClientVoiceMessage\(clientId,\s*sendConversationId\)/);
    expect(panel).toContain("inboxConversationId(conversation.channel, conversation.id)");
  });
});
