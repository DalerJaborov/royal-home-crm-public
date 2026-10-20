import { describe, expect, it } from "vitest";
import { parseIncoming } from "../src/messengers/meta.js";

/**
 * Вложения в прямом вебхуке Meta.
 *
 * Конвейер чтения фото и расшифровки голосовых существовал давно, но был подключён
 * только к прежней сторонней платформе. После перехода на прямую Meta до модели доходило одно
 * слово «image»: разбор терял и идентификатор файла, и подпись к нему. Эти тесты
 * стерегут вход в конвейер — то место, где всё и оборвалось.
 */

const whatsapp = (message: unknown) => ({
  object: "whatsapp_business_account",
  entry: [
    {
      changes: [
        {
          value: {
            metadata: { phone_number_id: "phone-1" },
            contacts: [{ wa_id: "992900000001", profile: { name: "Алишер" } }],
            messages: [{ from: "992900000001", ...(message as object) }],
          },
        },
      ],
    },
  ],
});

describe("WhatsApp: идентификатор файла доходит до загрузчика", () => {
  it("у фото берётся идентификатор медиа", () => {
    const [msg] = parseIncoming(whatsapp({ id: "wamid.1", type: "image", image: { id: "media-777" } }));
    expect(msg.attachmentType).toBe("image");
    expect(msg.mediaId).toBe("media-777");
  });

  it("подпись к фото — это слова клиента, а не служебное поле", () => {
    // Без этого до модели доходила картинка без вопроса к ней, и бот отвечал невпопад.
    const [msg] = parseIncoming(
      whatsapp({ id: "wamid.2", type: "image", image: { id: "media-1", caption: "такую ищу, есть?" } })
    );
    expect(msg.text).toBe("такую ищу, есть?");
    expect(msg.mediaId).toBe("media-1");
  });

  it("голосовое приходит с идентификатором — его расшифровывает Gemini", () => {
    const [msg] = parseIncoming(whatsapp({ id: "wamid.3", type: "audio", audio: { id: "media-voice" } }));
    expect(msg.attachmentType).toBe("audio");
    expect(msg.mediaId).toBe("media-voice");
  });

  it("у обычного текста идентификатора медиа нет", () => {
    const [msg] = parseIncoming(whatsapp({ id: "wamid.4", type: "text", text: { body: "салом" } }));
    expect(msg.text).toBe("салом");
    expect(msg.attachmentType).toBeUndefined();
    expect(msg.mediaId).toBeUndefined();
  });

  it("имя из профиля по-прежнему подхватывается", () => {
    const [msg] = parseIncoming(whatsapp({ id: "wamid.5", type: "image", image: { id: "m" } }));
    expect(msg.name).toBe("Алишер");
  });

  it("видео и документ тоже дают идентификатор — качать их мы не станем, но тип виден", () => {
    const [video] = parseIncoming(whatsapp({ id: "w6", type: "video", video: { id: "media-v" } }));
    expect(video.attachmentType).toBe("video");
    const [doc] = parseIncoming(whatsapp({ id: "w7", type: "document", document: { id: "media-d" } }));
    expect(doc.attachmentType).toBe("document");
  });
});

describe("Instagram: адрес файла приходит прямо в вебхуке", () => {
  const instagram = (message: unknown) => ({
    object: "instagram",
    entry: [{ messaging: [{ sender: { id: "ig-user" }, message }] }],
  });

  it("у фото сохраняется адрес — качать его можно без маркера", () => {
    const [msg] = parseIncoming(
      instagram({ mid: "m1", attachments: [{ type: "image", payload: { url: "https://cdn/photo.jpg" } }] })
    );
    expect(msg.attachmentType).toBe("image");
    expect(msg.attachmentUrl).toBe("https://cdn/photo.jpg");
    // У Instagram идентификатора медиа нет — только адрес.
    expect(msg.mediaId).toBeUndefined();
  });

  it("голосовое в Instagram — тоже адресом", () => {
    const [msg] = parseIncoming(
      instagram({ mid: "m2", attachments: [{ type: "audio", payload: { url: "https://cdn/voice.mp4" } }] })
    );
    expect(msg.attachmentType).toBe("audio");
    expect(msg.attachmentUrl).toBe("https://cdn/voice.mp4");
  });
});

describe("WhatsApp: карточка контакта", () => {
  /**
   * Живая жалоба владельца (20.09.2026): человек делится своим номером
   * карточкой контакта, а бот спрашивает телефон снова и снова. Причина была
   * здесь: из `contacts[]` бралось только имя, `phones[]` терялись целиком.
   */
  it("номер из визитки попадает в текст хода, а не теряется", () => {
    const [msg] = parseIncoming(
      whatsapp({
        id: "wamid.contact-1",
        type: "contacts",
        contacts: [{ name: { formatted_name: "Алишер" }, phones: [{ phone: "+992 900 00 00 01" }] }],
      })
    );
    expect(msg.attachmentType).toBe("contact");
    expect(msg.text).toContain("Алишер");
    expect(msg.text).toContain("+992 900 00 00 01");
  });

  it("визитка без номера по-прежнему даёт одно имя", () => {
    const [msg] = parseIncoming(
      whatsapp({ id: "wamid.contact-2", type: "contacts", contacts: [{ name: { formatted_name: "Алишер" } }] })
    );
    expect(msg.text).toContain("Алишер");
    expect(msg.text.trim().endsWith("Алишер")).toBe(true);
  });

  it("несколько номеров из одной визитки доходят все", () => {
    const [msg] = parseIncoming(
      whatsapp({
        id: "wamid.contact-3",
        type: "contacts",
        contacts: [
          {
            name: { formatted_name: "Саид" },
            phones: [{ phone: "+992 900 00 00 02" }, { phone: "+992 555 11 22 33" }],
          },
        ],
      })
    );
    expect(msg.text).toContain("+992 900 00 00 02");
    expect(msg.text).toContain("+992 555 11 22 33");
  });
});
