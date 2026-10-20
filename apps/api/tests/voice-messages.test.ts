import { describe, expect, it, vi } from "vitest";
import { buildAudioRequest, GRAPH_VERSION } from "../src/messengers/meta.js";
import { transcodeToOggOpus } from "../src/lib/audioTranscode.js";

/**
 * Голосовые сообщения агента клиенту (16.08.2026) — владелец: «отправлять и
 * слушать голосовые в переписке, а если агент называет номер или пытается обойти
 * систему — блок и тревога руководству».
 */

describe("Тело запроса голосового у Meta различается по каналу", () => {
  const credentials = {
    waToken: "wa-token",
    waPhoneId: "phone-1",
    igToken: "ig-token",
    pageToken: "page-token",
    pageId: "page-1",
  };

  it("WhatsApp: type audio, ссылка в audio.link", () => {
    const req = buildAudioRequest(credentials, "WHATSAPP", "992900000001", "https://crm/uploads/msg-voice/a.ogg");
    expect(req.url).toBe(`https://graph.facebook.com/${GRAPH_VERSION}/phone-1/messages`);
    expect(req.body).toEqual({
      messaging_product: "whatsapp",
      to: "992900000001",
      type: "audio",
      audio: { link: "https://crm/uploads/msg-voice/a.ogg" },
    });
  });

  it("Instagram: вложение type audio без is_reusable", () => {
    const req = buildAudioRequest(credentials, "INSTAGRAM", "igsid-1", "https://crm/uploads/msg-voice/a.ogg");
    expect(req.url).toContain(`/${GRAPH_VERSION}/me/messages`);
    expect(req.body).toEqual({
      recipient: { id: "igsid-1" },
      message: { attachment: { type: "audio", payload: { url: "https://crm/uploads/msg-voice/a.ogg" } } },
    });
  });

  it("Messenger: is_reusable и messaging_type RESPONSE", () => {
    const req = buildAudioRequest(credentials, "FACEBOOK", "psid-1", "https://crm/uploads/msg-voice/a.ogg");
    expect(req.body).toMatchObject({
      recipient: { id: "psid-1" },
      messaging_type: "RESPONSE",
      message: { attachment: { type: "audio", payload: { url: "https://crm/uploads/msg-voice/a.ogg", is_reusable: true } } },
    });
  });

  it("WhatsApp без идентификатора номера — понятная ошибка, а не падение внутри Graph", () => {
    expect(() => buildAudioRequest({}, "WHATSAPP", "992900000001", "https://x/a.ogg")).toThrow();
  });
});

describe("Перекодировка деградирует изящно, если ffmpeg недоступен/файл битый", () => {
  it("не бросает исключение, а отдаёт null или Buffer", async () => {
    const result = await transcodeToOggOpus(Buffer.from("это не аудио, а произвольные байты"));
    expect(result === null || Buffer.isBuffer(result)).toBe(true);
  });

  it("пустой и заведомо огромный буфер отбрасываются без обращения к ffmpeg", async () => {
    expect(await transcodeToOggOpus(Buffer.alloc(0))).toBeNull();
    expect(await transcodeToOggOpus(Buffer.alloc(21 * 1024 * 1024))).toBeNull();
  });
});
