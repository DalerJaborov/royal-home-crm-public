import React from "react";
import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import type { ConversationMessage } from "@royal-home/shared";
import { TranslatableMessageText } from "./MessageTranslateToggle";
import { replySourceLabels as desktopLabels, messageTimeText as desktopTime, messageRenderKey as desktopKey } from "../pages/Messages";
import { replySourceLabels as mobileLabels, messageTimeText as mobileTime, messageRenderKey as mobileKey } from "./mobile/MobileChatView";
import { replyTargetLabels as clientLabels, messageTimeText as clientTime, messageRenderKey as clientKey } from "./ClientChatPanel";

describe("chat source labels and legacy timestamps", () => {
  it("uses opaque distinct labels when channel identity is hidden and indexed labels for duplicate channels", () => {
    expect(desktopLabels([null, null])).toEqual(["Чат 1", "Чат 2"]);
    expect(mobileLabels([null, null])).toEqual(["Чат 1", "Чат 2"]);
    expect(clientLabels(["INSTAGRAM", "INSTAGRAM"])).toEqual(["Instagram 1", "Instagram 2"]);
    expect(desktopLabels(["TELEGRAM", "WHATSAPP", "TELEGRAM"])).toEqual(["Telegram 1", "WhatsApp", "Telegram 3"]);
  });

  it("labels missing legacy timestamps as unknown without manufacturing a time", () => {
    for (const label of [desktopTime, mobileTime, clientTime]) {
      expect(label(undefined)).toBe("Время сообщения неизвестно");
      expect(label(null)).toBe("Время сообщения неизвестно");
      expect(label("2026-10-26T09:00:00.000Z")).not.toBe("Время сообщения неизвестно");
    }
  });

  it("scopes duplicate message mids to their source conversation in all renderers", () => {
    const first = { role: "user", content: "first", mid: "duplicate-mid", sourceConversationId: "source-a", sourceMessageIndex: 0 } as ConversationMessage;
    const second = { ...first, content: "second", sourceConversationId: "source-b", sourceMessageIndex: 0 } as ConversationMessage;
    for (const key of [desktopKey, mobileKey, clientKey]) {
      expect(key(first, 0)).not.toBe(key(second, 1));
      expect(key(first, 0)).toContain("source-a");
      expect(key(second, 1)).toContain("source-b");
    }
  });
});

describe("Telegram translation controls", () => {
  const message: ConversationMessage = {
    role: "user", content: "Салом, чӣ хел?", at: "2026-10-26T09:00:00.000Z", translatedRu: "TRANSLATION-SENTINEL",
  };

  it.each(["tg_dialog-id", "td_topic-id"])("shows ordinary original text without a translation toggle for %s", (conversationId) => {
    const html = renderToStaticMarkup(<TranslatableMessageText content={message.content} message={message} conversationId={conversationId} />);
    expect(html).toContain(message.content);
    expect(html).not.toContain("TRANSLATION-SENTINEL");
    expect(html).not.toContain("Как сказал клиент");
    expect(html).not.toContain("Показать перевод на русский");
  });

  it("keeps the translation toggle for supported conversations", () => {
    const html = renderToStaticMarkup(<TranslatableMessageText content={message.content} message={message} conversationId="bot-conversation-id" />);
    expect(html).toContain("TRANSLATION-SENTINEL");
    expect(html).toContain("Как сказал клиент");
  });
});
