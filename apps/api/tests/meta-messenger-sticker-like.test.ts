import { describe, expect, it } from "vitest";
import { isMessengerStickerAttachment, parseIncoming } from "../src/messengers/meta.js";

/**
 * Лайк 👍 и стикеры Messenger — не фото (28.11.2026).
 *
 * Живой случай: клиент из рекламы продавца нажал кнопку-лайк после отказа «мы работаем только
 * в Душанбе». Facebook прислал её вложением `type: "image"` с `payload.sticker_id`, оператор приёма
 * заявок принял это за фото и ответил «акс ва видеоро агент худаш мегирад». Настоящее фото
 * `sticker_id` не имеет — по этому признаку и отделяем.
 */
const messenger = (attachments: unknown[]) => ({
  object: "page",
  entry: [
    {
      id: "page-1",
      messaging: [
        {
          sender: { id: "client-1" },
          recipient: { id: "page-1" },
          timestamp: 1,
          message: { mid: "m_1", attachments },
        },
      ],
    },
  ],
});

describe("Messenger: лайк и стикер отделены от фото", () => {
  it("кнопка-лайк (image + sticker_id) приходит как sticker, без ссылки на скачивание", () => {
    const [msg] = parseIncoming(
      messenger([{ type: "image", payload: { url: "https://scontent.example/like.png", sticker_id: 369239263222822 } }]),
    );
    expect(msg.attachmentType).toBe("sticker");
    expect(msg.attachmentUrl).toBeUndefined();
  });

  it("настоящее фото остаётся фото и качается как раньше", () => {
    const [msg] = parseIncoming(messenger([{ type: "image", payload: { url: "https://scontent.example/photo.jpg" } }]));
    expect(msg.attachmentType).toBe("image");
    expect(msg.attachmentUrl).toBe("https://scontent.example/photo.jpg");
  });

  it("стикер в хвосте пачки не попадает в дополнительные файлы", () => {
    const [msg] = parseIncoming(
      messenger([
        { type: "image", payload: { url: "https://scontent.example/a.jpg" } },
        { type: "image", payload: { url: "https://scontent.example/s.png", sticker_id: 1 } },
      ]),
    );
    expect(msg.attachmentType).toBe("image");
    expect(msg.extraAttachments ?? []).toHaveLength(0);
  });

  it("признак стикера: нужен и тип image, и sticker_id", () => {
    expect(isMessengerStickerAttachment({ type: "image", payload: { sticker_id: 5 } })).toBe(true);
    expect(isMessengerStickerAttachment({ type: "image", payload: {} })).toBe(false);
    expect(isMessengerStickerAttachment({ type: "video", payload: { sticker_id: 5 } })).toBe(false);
    expect(isMessengerStickerAttachment(undefined)).toBe(false);
  });
});
