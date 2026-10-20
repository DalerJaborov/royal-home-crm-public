import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import { describeError, foreignWhatsAppPhoneIds, parseIncoming, parseStatusUpdates, signatureMatches } from "../src/messengers/meta.js";

/**
 * Разбор тела вебхука Meta — чистая функция, база не нужна.
 *
 * Главное здесь — отсев песочницы. Приложение Meta всегда держит тестовый номер
 * рядом с боевым, его вебхуки подписаны тем же app secret и приходят с тем же
 * `object`, поэтому ни подпись, ни канал их не отличают: единственный признак —
 * `value.metadata.phone_number_id`.
 */

const OUR_PHONE_ID = "1295473220308902";
const SANDBOX_PHONE_ID = "1129773893562843";

function whatsappBody(phoneNumberId: string | undefined, from = "992900000001") {
  return {
    object: "whatsapp_business_account",
    entry: [
      {
        changes: [
          {
            value: {
              ...(phoneNumberId ? { metadata: { phone_number_id: phoneNumberId } } : {}),
              contacts: [{ wa_id: from, profile: { name: "Клиент" } }],
              messages: [{ from, type: "text", text: { body: "Здравствуйте" } }],
            },
          },
        ],
      },
    ],
  };
}

describe("parseIncoming — WhatsApp", () => {
  it("принимает сообщение на наш номер", () => {
    const out = parseIncoming(whatsappBody(OUR_PHONE_ID), OUR_PHONE_ID);
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ channel: "WHATSAPP", senderId: "992900000001", text: "Здравствуйте" });
    expect(out[0].name).toBe("Клиент");
  });

  it("отбрасывает сообщение с тестового номера песочницы", () => {
    expect(parseIncoming(whatsappBody(SANDBOX_PHONE_ID), OUR_PHONE_ID)).toEqual([]);
  });

  it("пропускает всё, пока свой номер не настроен: фильтровать не по чему", () => {
    expect(parseIncoming(whatsappBody(SANDBOX_PHONE_ID), undefined)).toHaveLength(1);
  });

  it("не теряет сообщение, если Meta не прислала metadata", () => {
    expect(parseIncoming(whatsappBody(undefined), OUR_PHONE_ID)).toHaveLength(1);
  });

  it("игнорирует статусы доставки наших же сообщений", () => {
    const body = {
      object: "whatsapp_business_account",
      entry: [
        {
          changes: [
            {
              value: {
                metadata: { phone_number_id: OUR_PHONE_ID },
                statuses: [{ id: "wamid.X", status: "delivered" }],
              },
            },
          ],
        },
      ],
    };
    expect(parseIncoming(body, OUR_PHONE_ID)).toEqual([]);
  });
});

describe("parseIncoming — WhatsApp: геометка и визитка клиента (18.08.2026)", () => {
  const locationBody = () => ({
    object: "whatsapp_business_account",
    entry: [
      {
        changes: [
          {
            value: {
              metadata: { phone_number_id: OUR_PHONE_ID },
              messages: [
                {
                  from: "992900000001",
                  id: "wamid-loc-1",
                  type: "location",
                  location: { latitude: 38.5598, longitude: 68.787, name: "Дом", address: "Сино, 12" },
                },
              ],
            },
          },
        ],
      },
    ],
  });

  const contactsBody = () => ({
    object: "whatsapp_business_account",
    entry: [
      {
        changes: [
          {
            value: {
              metadata: { phone_number_id: OUR_PHONE_ID },
              messages: [
                {
                  from: "992900000001",
                  id: "wamid-contact-1",
                  type: "contacts",
                  contacts: [{ name: { formatted_name: "Азиз" }, phones: [{ phone: "+992900000002" }] }],
                },
              ],
            },
          },
        ],
      },
    ],
  });

  it("геометка: attachmentType='location', текст с адресом", () => {
    const [msg] = parseIncoming(locationBody(), OUR_PHONE_ID);
    expect(msg.attachmentType).toBe("location");
    expect(msg.text).toContain("Дом");
    expect(msg.text).toContain("Сино, 12");
  });

  it("геометка без имени/адреса — координатами", () => {
    const body = locationBody();
    body.entry[0].changes[0].value.messages[0].location = { latitude: 38.5, longitude: 68.7 };
    const [msg] = parseIncoming(body, OUR_PHONE_ID);
    expect(msg.text).toContain("38.5");
    expect(msg.text).toContain("68.7");
  });

  it("визитка: attachmentType='contact' (в единственном числе — под общую подсказку ATTACHMENT_HINTS)", () => {
    const [msg] = parseIncoming(contactsBody(), OUR_PHONE_ID);
    expect(msg.attachmentType).toBe("contact");
    expect(msg.text).toContain("Азиз");
  });
});

describe("parseStatusUpdates — доставка/прочтение WhatsApp (18.08.2026)", () => {
  const statusBody = (statuses: unknown[]) => ({
    object: "whatsapp_business_account",
    entry: [{ changes: [{ value: { metadata: { phone_number_id: OUR_PHONE_ID }, statuses } }] }],
  });

  it("читает mid, статус и получателя", () => {
    const out = parseStatusUpdates(
      statusBody([{ id: "wamid.ABC", status: "delivered", recipient_id: "992900000001" }])
    );
    expect(out).toEqual([{ mid: "wamid.ABC", status: "delivered", recipientId: "992900000001", accountExternalId: OUR_PHONE_ID }]);
  });

  it("несколько статусов в одном вебхуке — все попадают в список", () => {
    const out = parseStatusUpdates(
      statusBody([
        { id: "wamid.A", status: "sent", recipient_id: "992900000001" },
        { id: "wamid.B", status: "read", recipient_id: "992900000002" },
      ])
    );
    expect(out).toHaveLength(2);
  });

  it("неполная запись (нет id/status/recipient_id) отбрасывается, не роняет разбор", () => {
    expect(parseStatusUpdates(statusBody([{ status: "read" }]))).toEqual([]);
  });

  it("не WhatsApp — пустой список", () => {
    expect(parseStatusUpdates({ object: "instagram", entry: [] })).toEqual([]);
  });

  it("обычное входящее сообщение (без statuses) не путается со статусом", () => {
    expect(parseStatusUpdates(whatsappBody(OUR_PHONE_ID))).toEqual([]);
  });
});

describe("parseIncoming — Instagram и Messenger", () => {
  const messagingBody = (object: string) => ({
    object,
    entry: [{ messaging: [{ sender: { id: "17841400000000000" }, message: { text: "Привет" } }] }],
  });

  it("фильтр номера WhatsApp не задевает Instagram", () => {
    const out = parseIncoming(messagingBody("instagram"), OUR_PHONE_ID);
    expect(out).toHaveLength(1);
    expect(out[0].channel).toBe("INSTAGRAM");
  });

  it("фильтр номера WhatsApp не задевает Messenger", () => {
    const out = parseIncoming(messagingBody("page"), OUR_PHONE_ID);
    expect(out).toHaveLength(1);
    expect(out[0].channel).toBe("FACEBOOK");
  });

  it("эхо без получателя отбрасывается — отвечать и глушить некому", () => {
    const body = {
      object: "instagram",
      entry: [{ messaging: [{ sender: { id: "17841400000000000" }, message: { text: "Ответ", is_echo: true } }] }],
    };
    expect(parseIncoming(body, OUR_PHONE_ID)).toEqual([]);
  });

  /**
   * Эхо больше не выбрасывается (17.08.2026, вопрос владельца «если отвечают
   * вручную из инстаграма, бот остановится?»): оно отдаётся наверх с признаком
   * isEcho, а там уже решается — наша это реплика или сотрудник писал руками.
   */
  it("эхо отдаётся с признаком isEcho, а собеседник берётся из recipient", () => {
    const body = {
      object: "instagram",
      entry: [
        {
          id: "17841400000000000",
          messaging: [
            {
              // У эха отправитель — НАШ аккаунт, получатель — клиент.
              sender: { id: "17841400000000000" },
              recipient: { id: "client-999" },
              message: { mid: "mid-manual-1", text: "Отвечаю руками", is_echo: true },
            },
          ],
        },
      ],
    };
    const out = parseIncoming(body, OUR_PHONE_ID);
    expect(out).toHaveLength(1);
    expect(out[0].isEcho).toBe(true);
    // Диалог ищется по клиенту, а не по нашему аккаунту — иначе пауза ушла бы не туда.
    expect(out[0].senderId).toBe("client-999");
    expect(out[0].accountExternalId).toBe("17841400000000000");
    expect(out[0].messageId).toBe("mid-manual-1");
  });

  it("обычное входящее по-прежнему без признака эха", () => {
    const out = parseIncoming(messagingBody("page"), OUR_PHONE_ID);
    expect(out[0].isEcho).toBeUndefined();
  });

  it("пачка фото одним сообщением: хвост не теряется, а едет в extraAttachments", () => {
    // До 26.08.2026 бралось только attachments[0] — клиент присылал три фото
    // квартиры, бот видел одно, остальные терялись молча.
    const body = {
      object: "instagram",
      entry: [
        {
          messaging: [
            {
              sender: { id: "client-1" },
              message: {
                mid: "mid-pack",
                attachments: [
                  { type: "image", payload: { url: "https://cdn.example/1.jpg" } },
                  { type: "image", payload: { url: "https://cdn.example/2.jpg" } },
                  { type: "image", payload: { url: "https://cdn.example/3.jpg" } },
                ],
              },
            },
          ],
        },
      ],
    };
    const out = parseIncoming(body, OUR_PHONE_ID);
    expect(out).toHaveLength(1);
    expect(out[0].attachmentUrl).toBe("https://cdn.example/1.jpg");
    expect(out[0].extraAttachments).toEqual([
      { type: "image", url: "https://cdn.example/2.jpg" },
      { type: "image", url: "https://cdn.example/3.jpg" },
    ]);
  });

  it("одиночное вложение extraAttachments не заводит", () => {
    const body = {
      object: "instagram",
      entry: [
        {
          messaging: [
            {
              sender: { id: "client-1" },
              message: { mid: "mid-one", attachments: [{ type: "image", payload: { url: "https://cdn.example/1.jpg" } }] },
            },
          ],
        },
      ],
    };
    expect(parseIncoming(body, OUR_PHONE_ID)[0].extraAttachments).toBeUndefined();
  });

  it("разбирает Instagram и в форме changes — так шлёт кнопка «Тестировать» в панели Meta", () => {
    const body = {
      object: "instagram",
      entry: [
        {
          changes: [
            {
              field: "messages",
              value: {
                sender: { id: "12334" },
                recipient: { id: "23245" },
                message: { mid: "random_mid", text: "random_text" },
              },
            },
          ],
        },
      ],
    };
    const out = parseIncoming(body, OUR_PHONE_ID);
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ channel: "INSTAGRAM", senderId: "12334", text: "random_text" });
  });

  it("эхо в форме changes тоже не считается входящим", () => {
    const body = {
      object: "instagram",
      entry: [
        {
          changes: [
            { field: "messages", value: { sender: { id: "12334" }, message: { text: "Ответ", is_echo: true } } },
          ],
        },
      ],
    };
    expect(parseIncoming(body, OUR_PHONE_ID)).toEqual([]);
  });

  it("комментарии в форме changes сообщением не становятся", () => {
    const body = {
      object: "instagram",
      entry: [{ changes: [{ field: "comments", value: { from: { id: "12334" }, text: "Красиво" } }] }],
    };
    expect(parseIncoming(body, OUR_PHONE_ID)).toEqual([]);
  });

  it("незнакомый продукт Meta не разбирается вовсе", () => {
    expect(parseIncoming({ object: "threads", entry: [] }, OUR_PHONE_ID)).toEqual([]);
  });
});

describe("foreignWhatsAppPhoneIds — почему сообщение отброшено", () => {
  it("сообщает чужой номер, на который пришло сообщение", () => {
    expect(foreignWhatsAppPhoneIds(whatsappBody(SANDBOX_PHONE_ID), OUR_PHONE_ID)).toEqual([SANDBOX_PHONE_ID]);
  });

  it("на своём номере молчит", () => {
    expect(foreignWhatsAppPhoneIds(whatsappBody(OUR_PHONE_ID), OUR_PHONE_ID)).toEqual([]);
  });

  it("статусы доставки в журнал не тащит", () => {
    const body = {
      object: "whatsapp_business_account",
      entry: [
        {
          changes: [
            {
              value: {
                metadata: { phone_number_id: SANDBOX_PHONE_ID },
                statuses: [{ id: "wamid.X", status: "delivered" }],
              },
            },
          ],
        },
      ],
    };
    expect(foreignWhatsAppPhoneIds(body, OUR_PHONE_ID)).toEqual([]);
  });

  it("Instagram и Messenger не разбирает", () => {
    const body = { object: "instagram", entry: [{ messaging: [{ sender: { id: "1" }, message: { text: "x" } }] }] };
    expect(foreignWhatsAppPhoneIds(body, OUR_PHONE_ID)).toEqual([]);
  });
});

describe("signatureMatches — два секрета приложения", () => {
  const body = Buffer.from(JSON.stringify({ object: "instagram", entry: [] }));
  const FB_SECRET = "facebook-app-secret";
  const IG_SECRET = "instagram-app-secret";
  const sign = (secret: string) => `sha256=${createHmac("sha256", secret).update(body).digest("hex")}`;

  it("принимает подпись секретом приложения Facebook", () => {
    expect(signatureMatches(body, sign(FB_SECRET), [FB_SECRET, IG_SECRET])).toBe(true);
  });

  it("принимает подпись секретом приложения Instagram — им подписаны вебхуки Instagram", () => {
    expect(signatureMatches(body, sign(IG_SECRET), [FB_SECRET, IG_SECRET])).toBe(true);
  });

  it("отвергает подпись чужим секретом", () => {
    expect(signatureMatches(body, sign("secret-of-a-stranger"), [FB_SECRET, IG_SECRET])).toBe(false);
  });

  it("без настроенных секретов не принимает ничего", () => {
    expect(signatureMatches(body, sign(FB_SECRET), [undefined, undefined])).toBe(false);
  });

  it("отвергает запрос без заголовка и с чужим форматом", () => {
    expect(signatureMatches(body, undefined, [FB_SECRET])).toBe(false);
    expect(signatureMatches(body, "sha1=deadbeef", [FB_SECRET])).toBe(false);
    expect(signatureMatches(body, "sha256=", [FB_SECRET])).toBe(false);
  });

  it("подпись от другого тела не подходит", () => {
    const other = Buffer.from(JSON.stringify({ object: "instagram", entry: [{ id: "1" }] }));
    expect(signatureMatches(other, sign(IG_SECRET), [FB_SECRET, IG_SECRET])).toBe(false);
  });
});

describe("parseIncoming — идентификатор сообщения для «прочитано»", () => {
  it("WhatsApp: берётся из messages[].id", () => {
    const body = {
      object: "whatsapp_business_account",
      entry: [
        {
          changes: [
            {
              value: {
                metadata: { phone_number_id: OUR_PHONE_ID },
                messages: [{ id: "wamid.ABC", from: "992900000001", type: "text", text: { body: "Привет" } }],
              },
            },
          ],
        },
      ],
    };
    expect(parseIncoming(body, OUR_PHONE_ID)[0]?.messageId).toBe("wamid.ABC");
  });

  it("Instagram: берётся из message.mid", () => {
    const body = {
      object: "instagram",
      entry: [{ messaging: [{ sender: { id: "178414" }, message: { mid: "mid.XYZ", text: "Привет" } }] }],
    };
    expect(parseIncoming(body, OUR_PHONE_ID)[0]?.messageId).toBe("mid.XYZ");
  });

  it("без идентификатора сообщение всё равно разбирается", () => {
    const body = {
      object: "instagram",
      entry: [{ messaging: [{ sender: { id: "178414" }, message: { text: "Привет" } }] }],
    };
    const out = parseIncoming(body, OUR_PHONE_ID);
    expect(out).toHaveLength(1);
    expect(out[0].messageId).toBeUndefined();
  });
});

describe("describeError — настоящая причина сетевого отказа", () => {
  it("достаёт код и текст из cause: «fetch failed» сам по себе ничего не объясняет", () => {
    const cause = Object.assign(new Error("getaddrinfo ENOTFOUND graph.instagram.com"), { code: "ENOTFOUND" });
    const err = Object.assign(new Error("fetch failed"), { cause });
    expect(describeError(err)).toBe("fetch failed (ENOTFOUND getaddrinfo ENOTFOUND graph.instagram.com)");
  });

  it("без cause оставляет сообщение как есть", () => {
    expect(describeError(new Error("Graph API HTTP 400: неверный маркер"))).toBe("Graph API HTTP 400: неверный маркер");
  });

  it("причину-строку тоже показывает", () => {
    expect(describeError(Object.assign(new Error("fetch failed"), { cause: "socket hang up" }))).toBe(
      "fetch failed (socket hang up)"
    );
  });

  it("не падает на том, что вообще не Error", () => {
    expect(describeError("просто строка")).toBe("просто строка");
  });
});
