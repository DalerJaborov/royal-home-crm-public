import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createCustomerMessengerFixture, type CustomerMessengerFixture } from "./helpers/customerMessengerFixture.js";
import { presentMessages } from "../src/lib/messageAttachments.js";
import { parseIncoming } from "../src/messengers/meta.js";
import { appendConversationMessages, markMessageDeliveryStatus, stampOutgoingMid } from "../src/messengers/conversation.js";
import { prisma } from "../src/db.js";

let instagram: CustomerMessengerFixture;
let whatsapp: CustomerMessengerFixture;
beforeAll(async () => {
  instagram = await createCustomerMessengerFixture("INSTAGRAM");
  whatsapp = await createCustomerMessengerFixture("WHATSAPP");
});
afterAll(async () => { await instagram?.dispose(); await whatsapp?.dispose(); });

/**
 * ЦИТАТЫ В ПЕРЕПИСКЕ и белый список полей реплики.
 *
 * Два разных отказа, и второй уже случался вживую.
 *
 * 1) Цитата. Клиент отвечает «ответом» на конкретное сообщение — Meta присылает
 *    идентификатор того, на что он ответил (у Instagram/Messenger это
 *    `message.reply_to.mid`, у WhatsApp `context.id`). Раньше оба поля молча
 *    выбрасывались, и короткое «да» в ленте не к чему было отнести.
 *
 * 2) Белый список. `presentMessages` отдаёт наружу перечисленные поля, а не всю
 *    реплику. Дважды новое поле забывали добавить сюда, и правка выглядела
 *    выкаченной, ничего не меняя на экране: время `at` (есть с 01.08.2026) не
 *    показывалось нигде, а вложения «video»/«file» отсеивались набором из двух
 *    слов — плеер, написанный накануне, был мёртвым.
 */

describe("Цитаты: идентификаторы доезжают из вебхука", () => {
  it("Instagram: ответ на конкретное сообщение сохраняет его идентификатор", () => {
    const [msg] = parseIncoming({
      object: "instagram",
      entry: [
        {
          messaging: [
            {
              sender: { id: "sub-1" },
              message: { mid: "mid-client", text: "да, подходит", reply_to: { mid: "mid-our-answer" } },
            },
          ],
        },
      ],
    });
    expect(msg.messageId).toBe("mid-client");
    expect(msg.replyToMessageId).toBe("mid-our-answer");
  });

  it("WhatsApp: ответ приходит в context.id", () => {
    const [msg] = parseIncoming({
      object: "whatsapp_business_account",
      entry: [
        {
          changes: [
            {
              value: {
                metadata: { phone_number_id: "our-number" },
                messages: [
                  { from: "992900000000", id: "wamid-2", type: "text", text: { body: "сколько?" }, context: { id: "wamid-1" } },
                ],
              },
            },
          ],
        },
      ],
      // тот же номер, что в metadata: иначе сработает фильтр песочницы
    } as unknown, "our-number");
    expect(msg.messageId).toBe("wamid-2");
    expect(msg.replyToMessageId).toBe("wamid-1");
  });

  it("обычное сообщение остаётся без ссылки на цитату", () => {
    const [msg] = parseIncoming({
      object: "instagram",
      entry: [{ messaging: [{ sender: { id: "sub-2" }, message: { mid: "m-1", text: "салом" } }] }],
    });
    expect(msg.replyToMessageId).toBeUndefined();
  });
});

describe("Белый список полей реплики", () => {
  const raw = [
    { role: "user", content: "салом", at: "2026-08-16T09:00:00.000Z", mid: "m-1" },
    {
      role: "assistant",
      content: "Салом! Чӣ хизмат карда метавонам?",
      at: "2026-08-16T09:00:30.000Z",
      by: { kind: "bot" },
      mid: "m-2",
      mid2: "m-3",
      replyToMid: "m-1",
    },
    {
      role: "user",
      content: "",
      attachments: [
        { kind: "video", mime: "video/mp4", file: "tour.mp4" },
        { kind: "file", mime: "application/pdf", file: "plan.pdf" },
      ],
    },
  ];

  it("время и идентификаторы цитат доезжают наружу", () => {
    const out = presentMessages(raw, true);
    expect(out[0].at).toBe("2026-08-16T09:00:00.000Z");
    expect(out[0].mid).toBe("m-1");
    expect(out[1].replyToMid).toBe("m-1");
    // Ответ бота из двух пузырей лежит одной репликой и хранит оба идентификатора:
    // клиент мог нажать «ответить» на любой из них.
    expect(out[1].mid).toBe("m-2");
    expect(out[1].mid2).toBe("m-3");
  });

  it("видео и документ не отсеиваются как «неизвестный вид»", () => {
    const out = presentMessages(raw, true);
    expect(out[2].attachments?.map((a) => a.kind)).toEqual(["video", "file"]);
    expect(out[2].attachments?.[0].file).toBe("tour.mp4");
  });

  it("без права на вложения имя файла не приезжает, но вид остаётся", () => {
    const out = presentMessages(raw, false);
    expect(out[2].attachments?.[0].kind).toBe("video");
    expect(out[2].attachments?.[0].file).toBeNull();
  });

  it("чужие поля из колонки наружу не выходят", () => {
    const out = presentMessages([{ role: "user", content: "тест", leadDraft: { secret: 1 } }], true);
    expect(out[0]).not.toHaveProperty("leadDraft");
  });
});

/**
 * Идентификатор отправленного сообщения дописывается ПОСЛЕ записи реплики: ответ
 * бота попадает в переписку до отправки, а mid Meta выдаёт только в ответ на неё.
 */
describe("Отметка отправленного сообщения", () => {
  const subscriberId = `quote-test-${Date.now()}`;
  const ids: string[] = [];

  afterAll(async () => {
    if (ids.length > 0) await prisma.botConversation.deleteMany({ where: { id: { in: ids } } });
  });

  it("первый пузырь занимает mid, второй — mid2, чужие реплики не трогаются", async () => {
    const conversation = await prisma.botConversation.create({
      data: { channel: "INSTAGRAM", accountId: instagram.id, endpointScopeId: instagram.transport.endpointScopeId, subscriberId, messages: [] },
    });
    ids.push(conversation.id);

    await appendConversationMessages(conversation.id, [
      { role: "user", content: "салом" },
      { role: "assistant", content: "Салом!", by: { kind: "bot" } },
    ]);

    await stampOutgoingMid("INSTAGRAM", subscriberId, "mid-first", instagram.transport);
    await stampOutgoingMid("INSTAGRAM", subscriberId, "mid-second", instagram.transport);

    const saved = await prisma.botConversation.findUnique({ where: { id: conversation.id } });
    const messages = saved!.messages as unknown as { role: string; mid?: string; mid2?: string }[];
    expect(messages[1].mid).toBe("mid-first");
    expect(messages[1].mid2).toBe("mid-second");
    // Реплика клиента осталась нетронутой: отметка ставится только последней нашей.
    expect(messages[0].mid).toBeUndefined();
  });

  it("последняя реплика — клиента: отметка не ставится никому", async () => {
    const own = `${subscriberId}-user-last`;
    const conversation = await prisma.botConversation.create({
      data: { channel: "INSTAGRAM", accountId: instagram.id, endpointScopeId: instagram.transport.endpointScopeId, subscriberId: own, messages: [] },
    });
    ids.push(conversation.id);
    await appendConversationMessages(conversation.id, [{ role: "user", content: "салом" }]);

    await stampOutgoingMid("INSTAGRAM", own, "mid-nowhere", instagram.transport);

    const saved = await prisma.botConversation.findUnique({ where: { id: conversation.id } });
    const messages = saved!.messages as unknown as { mid?: string }[];
    expect(messages[0].mid).toBeUndefined();
  });
});

/**
 * Статус доставки WhatsApp (18.08.2026) — находит реплику по mid/mid2, а не по
 * позиции: статус может прийти для сообщения, после которого уже ушли другие.
 */
describe("markMessageDeliveryStatus — галочки доставки WhatsApp", () => {
  const subscriberId = `delivery-test-${Date.now()}`;
  const ids: string[] = [];

  afterAll(async () => {
    if (ids.length > 0) await prisma.botConversation.deleteMany({ where: { id: { in: ids } } });
  });

  it("находит реплику по mid и проставляет статус", async () => {
    const conversation = await prisma.botConversation.create({
      data: { channel: "WHATSAPP", accountId: whatsapp.id, endpointScopeId: whatsapp.transport.endpointScopeId, subscriberId, messages: [] },
    });
    ids.push(conversation.id);
    await appendConversationMessages(conversation.id, [
      { role: "assistant", content: "Здравствуйте!", by: { kind: "bot" }, mid: "wamid.first" },
    ]);

    await markMessageDeliveryStatus(subscriberId, "wamid.first", "delivered", whatsapp.externalId);

    const saved = await prisma.botConversation.findUnique({ where: { id: conversation.id } });
    const messages = saved!.messages as unknown as { deliveryStatus?: string }[];
    expect(messages[0].deliveryStatus).toBe("delivered");
  });

  it("находит реплику НЕ последнюю — статус пришёл для более раннего сообщения", async () => {
    const own = `${subscriberId}-not-last`;
    const conversation = await prisma.botConversation.create({
      data: { channel: "WHATSAPP", accountId: whatsapp.id, endpointScopeId: whatsapp.transport.endpointScopeId, subscriberId: own, messages: [] },
    });
    ids.push(conversation.id);
    await appendConversationMessages(conversation.id, [
      { role: "assistant", content: "Первое", by: { kind: "bot" }, mid: "wamid.one" },
      { role: "user", content: "ок" },
      { role: "assistant", content: "Второе", by: { kind: "bot" }, mid: "wamid.two" },
    ]);

    await markMessageDeliveryStatus(own, "wamid.one", "read", whatsapp.externalId);

    const saved = await prisma.botConversation.findUnique({ where: { id: conversation.id } });
    const messages = saved!.messages as unknown as { content: string; deliveryStatus?: string }[];
    expect(messages[0].deliveryStatus).toBe("read");
    expect(messages[2].deliveryStatus).toBeUndefined();
  });

  it("read не откатывается обратно на delivered при более старом статусе", async () => {
    const own = `${subscriberId}-no-downgrade`;
    const conversation = await prisma.botConversation.create({
      data: { channel: "WHATSAPP", accountId: whatsapp.id, endpointScopeId: whatsapp.transport.endpointScopeId, subscriberId: own, messages: [] },
    });
    ids.push(conversation.id);
    await appendConversationMessages(conversation.id, [
      { role: "assistant", content: "Привет", by: { kind: "bot" }, mid: "wamid.race" },
    ]);

    await markMessageDeliveryStatus(own, "wamid.race", "read", whatsapp.externalId);
    await markMessageDeliveryStatus(own, "wamid.race", "delivered", whatsapp.externalId); // пришёл позже, но по времени события — раньше

    const saved = await prisma.botConversation.findUnique({ where: { id: conversation.id } });
    const messages = saved!.messages as unknown as { deliveryStatus?: string }[];
    expect(messages[0].deliveryStatus).toBe("read");
  });

  it("незнакомый mid — тихо ничего не меняет", async () => {
    const own = `${subscriberId}-unknown-mid`;
    const conversation = await prisma.botConversation.create({
      data: { channel: "WHATSAPP", accountId: whatsapp.id, endpointScopeId: whatsapp.transport.endpointScopeId, subscriberId: own, messages: [] },
    });
    ids.push(conversation.id);
    await appendConversationMessages(conversation.id, [
      { role: "assistant", content: "Привет", by: { kind: "bot" }, mid: "wamid.known" },
    ]);

    await markMessageDeliveryStatus(own, "wamid.does-not-exist", "read", whatsapp.externalId);

    const saved = await prisma.botConversation.findUnique({ where: { id: conversation.id } });
    const messages = saved!.messages as unknown as { deliveryStatus?: string }[];
    expect(messages[0].deliveryStatus).toBeUndefined();
  });
});
