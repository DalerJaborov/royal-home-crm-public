import { describe, expect, it } from "vitest";
import { buildReactionRequest, GRAPH_VERSION } from "../src/messengers/meta.js";

/**
 * Настоящая реакция (тап эмодзи) в WhatsApp — 18.08.2026, владелец попросил
 * замену тексту-смайлику под сообщениями клиента. Только WhatsApp Cloud API
 * документирует такой тип сообщения; Instagram/Messenger — нет.
 */

describe("buildReactionRequest — WhatsApp Cloud API", () => {
  const credentials = { waToken: "wa-token", waPhoneId: "phone-1" };

  it("тело запроса — type reaction с message_id и emoji", () => {
    const req = buildReactionRequest(credentials, "992900000001", "wamid.ABC123", "❤️");
    expect(req.url).toBe(`https://graph.facebook.com/${GRAPH_VERSION}/phone-1/messages`);
    expect(req.token).toBe("wa-token");
    expect(req.body).toEqual({
      messaging_product: "whatsapp",
      recipient_type: "individual",
      to: "992900000001",
      type: "reaction",
      reaction: { message_id: "wamid.ABC123", emoji: "❤️" },
    });
  });

  it("пустой emoji — снятие ранее поставленной реакции", () => {
    const req = buildReactionRequest(credentials, "992900000001", "wamid.ABC123", "");
    expect((req.body as { reaction: { emoji: string } }).reaction.emoji).toBe("");
  });

  it("без waPhoneId в настройках — явная ошибка, не тихий провал", () => {
    expect(() => buildReactionRequest({}, "992900000001", "wamid.ABC123", "❤️")).toThrow(
      /номера WhatsApp не задан/
    );
  });
});
