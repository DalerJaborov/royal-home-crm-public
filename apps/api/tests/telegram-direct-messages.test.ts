import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Direct Messages канала (01.09.2026, t.me/<канал>?direct) — главная проверка:
 * разные отправители делят ОДИН chat.id (сам канал), Telegram различает их
 * только через direct_messages_topic.topic_id. Ошибка здесь означала бы
 * склеенных в один диалог/одну карточку РАЗНЫХ клиентов — самый чувствительный
 * риск этой функции (см. messengers/telegramDirectMessages.ts).
 *
 * Транспорт и ИИ подменены — тест не ходит ни в Telegram, ни к модели.
 */

const { sendMessage, callAiText } = vi.hoisted(() => ({
  sendMessage: vi.fn(async (_chatId: string, _text: string, _replyTo?: number, _topicId?: number) => {}),
  callAiText: vi.fn(),
}));

vi.mock("../src/telegram/api.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/telegram/api.js")>()),
  sendMessage,
}));
vi.mock("../src/ai/client.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/ai/client.js")>()),
  callAiText,
}));

delete process.env.TELEGRAM_BOT_TOKEN;

const { prisma } = await import("../src/db.js");
const { handleTelegramUpdate } = await import("../src/telegram/bot.js");

const runId = Date.now();
const DM_CHAT_ID = -(2_000_000_000_000 + (runId % 1_000_000_000));

type SettingsSnapshot = {
  botEnabled: boolean;
  botTelegramEnabled: boolean;
  telegramOwnerChatId: string | null;
  telegramDirectMessagesEnabled: boolean;
};
const SELECT = {
  botEnabled: true,
  botTelegramEnabled: true,
  telegramOwnerChatId: true,
  telegramDirectMessagesEnabled: true,
} as const;
let savedSettings: SettingsSnapshot;

let nextUpdateId = runId % 1_000_000_000;

function dmUpdate(topicId: number, username: string, text: string, contact?: { phone_number: string; first_name?: string; user_id?: number }) {
  return {
    update_id: nextUpdateId++,
    message: {
      chat: { id: DM_CHAT_ID, type: "supergroup", is_direct_messages: true },
      from: { id: topicId, username },
      text,
      ...(contact ? { contact } : {}),
      direct_messages_topic: { topic_id: topicId, user: { id: topicId, is_bot: false, username } },
    },
  };
}

beforeAll(async () => {
  savedSettings = await prisma.settings.upsert({
    where: { id: "singleton" },
    update: {},
    create: { id: "singleton" },
    select: SELECT,
  });
  await prisma.settings.update({
    where: { id: "singleton" },
    data: { botEnabled: true, botTelegramEnabled: true, telegramOwnerChatId: null, telegramDirectMessagesEnabled: true },
  });
});

afterAll(async () => {
  await prisma.telegramDirectConversation.deleteMany({ where: { chatId: String(DM_CHAT_ID) } });
  await prisma.settings.update({ where: { id: "singleton" }, data: savedSettings });
});

beforeEach(() => {
  sendMessage.mockClear();
  callAiText.mockReset();
  callAiText.mockResolvedValue({ reply: ["Здравствуйте! Чем можем помочь?"], ready: false, intent: "buy", confident: true });
});

describe("Direct Messages канала: разные topic_id — разные диалоги", () => {
  it("два разных отправителя на одном chat.id не сливаются в один диалог", async () => {
    const topicA = 700000000 + (runId % 1000);
    const topicB = 800000000 + (runId % 1000);

    await handleTelegramUpdate(dmUpdate(topicA, "buyer_a", "Здравствуйте, ищу квартиру"));
    await handleTelegramUpdate(dmUpdate(topicB, "buyer_b", "Привет, сколько стоит трёшка?"));

    const rows = await prisma.telegramDirectConversation.findMany({
      where: { chatId: String(DM_CHAT_ID) },
      orderBy: { topicId: "asc" },
    });

    expect(rows).toHaveLength(2);
    expect(new Set(rows.map((r) => r.topicId))).toEqual(new Set([String(topicA), String(topicB)]));
    expect(rows.find((r) => r.topicId === String(topicA))?.username).toBe("buyer_a");
    expect(rows.find((r) => r.topicId === String(topicB))?.username).toBe("buyer_b");

    // Ответ каждому ушёл с ЕГО topic_id — иначе оба получили бы ответы друг друга.
    const topicIdsReplied = sendMessage.mock.calls.map((call) => call[3]);
    expect(topicIdsReplied).toEqual(expect.arrayContaining([topicA, topicB]));
  });

  it("заявка заводится БЕЗ telegramChatId — на общий DM-инбокс нельзя писать без topicId", async () => {
    const topic = 900000000 + (runId % 1000);
    await handleTelegramUpdate(dmUpdate(topic, "buyer_c", "Здравствуйте"));
    await handleTelegramUpdate(dmUpdate(topic, "buyer_c", "+992900123456"));

    const row = await prisma.telegramDirectConversation.findUnique({
      where: { chatId_topicId: { chatId: String(DM_CHAT_ID), topicId: String(topic) } },
    });
    expect(row?.clientId).toBeTruthy();

    const client = await prisma.client.findUnique({ where: { id: row!.clientId! } });
    expect(client?.telegramChatId).toBeNull();

    await prisma.client.delete({ where: { id: row!.clientId! } });
  });
});

describe("Direct Messages канала после заявки (ревизия 02.10.2026)", () => {
  it("«заявка уже у агента» — один раз подряд и на языке клиента, а не на каждое сообщение", async () => {
    const topic = 910000000 + (runId % 1000);
    await handleTelegramUpdate(dmUpdate(topic, "buyer_tj", "Салом, хона мехарам"));
    await handleTelegramUpdate(dmUpdate(topic, "buyer_tj", "+992900123457"));
    sendMessage.mockClear();

    await handleTelegramUpdate(dmUpdate(topic, "buyer_tj", "Ман метавонам пагоҳ биёям?"));
    await handleTelegramUpdate(dmUpdate(topic, "buyer_tj", "Ва боз як савол ҳаст"));

    const texts = sendMessage.mock.calls.map((call) => call[1]);
    expect(texts).toHaveLength(1);
    expect(texts[0]).toContain("Дархости шумо аллакай дар агент аст");

    const row = await prisma.telegramDirectConversation.findUnique({
      where: { chatId_topicId: { chatId: String(DM_CHAT_ID), topicId: String(topic) } },
    });
    if (row?.clientId) await prisma.client.delete({ where: { id: row.clientId } });
  });
});

describe("Direct Messages канала: ссылка на объект ведёт заявку к его агенту (02.10.2026)", () => {
  it("клиент прислал ссылку на объект, потом номер — заявка у агента объекта, а не в общей очереди", async () => {
    const topic = 920000000 + (runId % 1000);
    const tail = String(runId).slice(-7);
    const saved = await prisma.settings.findUnique({ where: { id: "singleton" }, select: { workHoursStart: true, workHoursEnd: true } });
    await prisma.settings.update({ where: { id: "singleton" }, data: { workHoursStart: "00:00", workHoursEnd: "24:00" } });
    const district = await prisma.district.create({ data: { name: `Тест-район-tgdm-${runId}` } });
    const agent = await prisma.agent.create({
      data: { fullName: `Агент объекта ${runId}`, phone: `+99293${tail}`, role: "AGENT", passwordHash: "x" },
    });
    const property = await prisma.property.create({
      data: {
        title: `Тест-объект-tgdm-${runId}`, type: "APARTMENT", rooms: 2, areaSqm: 55, price: 45000, currency: "USD",
        districtId: district.id, address: "Тестовая, 1", condition: "GOOD", intakeAgentId: agent.id,
      },
    });
    let clientId: string | null = null;
    try {
      await prisma.propertyExposure.create({
        data: { channel: "TELEGRAM", recipientId: String(topic), propertyId: property.id, shortId: property.shortId, kind: "CLIENT_SHARED" },
      });
      await handleTelegramUpdate(dmUpdate(topic, "buyer_obj", "Здравствуйте, эта квартира ещё есть?"));
      await handleTelegramUpdate(dmUpdate(topic, "buyer_obj", `+99290${tail}`));
      const row = await prisma.telegramDirectConversation.findUnique({
        where: { chatId_topicId: { chatId: String(DM_CHAT_ID), topicId: String(topic) } },
      });
      clientId = row?.clientId ?? null;
      expect(clientId).toBeTruthy();
      const client = await prisma.client.findUnique({ where: { id: clientId! }, select: { assignedAgentId: true, assignReason: true } });
      // Причина важнее имени: новый агент без нагрузки мог прийти и из общей очереди.
      expect(client).toMatchObject({ assignedAgentId: agent.id, assignReason: "own_property_shown" });
    } finally {
      if (clientId) await prisma.client.delete({ where: { id: clientId } }).catch(() => {});
      await prisma.propertyExposure.deleteMany({ where: { propertyId: property.id } });
      await prisma.property.delete({ where: { id: property.id } });
      await prisma.agent.delete({ where: { id: agent.id } }).catch(() => {});
      await prisma.district.delete({ where: { id: district.id } });
      await prisma.settings.update({ where: { id: "singleton" }, data: saved! });
    }
  });
});
