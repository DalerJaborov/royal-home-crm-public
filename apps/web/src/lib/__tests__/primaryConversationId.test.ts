import { describe, expect, it } from "vitest";
import type { Client } from "../../types";
import { primaryConversationId } from "../primaryConversationId";

/**
 * «Написать» в карточке на телефоне ведёт в /messages?open=<id>. Раздел
 * «Сообщения» и сервер узнают Telegram-диалог по префиксу `tg_`; без него
 * клиент, писавший только в Telegram, открывался пустым экраном (23.09.2026).
 */

const msg = (at: string) => ({ role: "user", content: "Салом", at }) as Client["botConversation"][number]["messages"][number];

function client(parts: Partial<Pick<Client, "botConversation" | "telegramConversation">>): Client {
  return { botConversation: [], telegramConversation: null, ...parts } as unknown as Client;
}

describe("primaryConversationId", () => {
  it("Telegram-диалог отдаётся с префиксом tg_", () => {
    const c = client({ telegramConversation: { id: "abc", pausedUntil: null, messages: [msg("2026-09-23T08:00:00Z")] } });
    expect(primaryConversationId(c)).toBe("tg_abc");
  });

  it("диалог Instagram/WhatsApp — без префикса, выбирается самый свежий", () => {
    const c = client({
      botConversation: [{ id: "ig1", pausedUntil: null, channel: "INSTAGRAM", messages: [msg("2026-09-23T09:00:00Z")] }],
      telegramConversation: { id: "abc", pausedUntil: null, messages: [msg("2026-09-23T08:00:00Z")] },
    });
    expect(primaryConversationId(c)).toBe("ig1");
  });

  it("без диалогов — null", () => {
    expect(primaryConversationId(client({}))).toBeNull();
  });
});
