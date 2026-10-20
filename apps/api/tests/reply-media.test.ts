import { afterAll, beforeAll, afterEach, describe, expect, it, vi } from "vitest";
import { createCustomerMessengerFixture, type CustomerMessengerFixture } from "./helpers/customerMessengerFixture.js";

/**
 * Доставка ФОТО/ВИДЕО сотрудника клиенту (18.08.2026, R2-версия; гибридный режим
 * видео — 18.08.2026 вечер) — тот же приём, что и apps/api/tests/voice-delivery.test.ts:
 * транспорт (Meta, R2) подменён моками, проверяются ПОРЯДОК и РЕШЕНИЯ
 * (файлом/ссылкой/отказать), а не сеть и не диск. Мокается lib/r2Client.ts, как это
 * делают тесты видео-галереи (см. apps/api/tests/video-upload-multipart.test.ts).
 */

const { uploadOutgoingMedia, r2PresignDownloadUrl, isR2Configured, sendImage, sendVideo, sendMessage, sendTelegramPhoto, sendTelegramVideo } =
  vi.hoisted(() => ({
    uploadOutgoingMedia: vi.fn(async (conversationId: string, _src: unknown, ext: string, _type?: string) => `chat-media/${conversationId}/test.${ext}`),
    r2PresignDownloadUrl: vi.fn(async (key: string) => `https://r2.test/${key}?X-Amz-Expires=600`),
    isR2Configured: vi.fn(() => true),
    sendImage: vi.fn(async (_c: string, _to: string, _url: string) => "wamid.sent-image-1"),
    sendVideo: vi.fn(async (_c: string, _to: string, _url: string) => "wamid.sent-video-1"),
    sendMessage: vi.fn(async (_c: string, _to: string, _text: string) => "wamid.sent-text-1"),
    sendTelegramPhoto: vi.fn(async (_chatId: string, _url: string, _caption?: string) => undefined),
    sendTelegramVideo: vi.fn(async (_chatId: string, _url: string, _caption?: string) => undefined),
  }));

vi.mock("../src/lib/outgoingMedia.js", () => ({ uploadOutgoingMedia }));
vi.mock("../src/lib/r2Client.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/lib/r2Client.js")>()),
  r2PresignDownloadUrl,
  isR2Configured,
}));
vi.mock("../src/messengers/meta.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/messengers/meta.js")>()),
  sendImage,
  sendVideo,
  sendMessage,
  isMetaChannelEnabled: vi.fn(async () => true),
}));
vi.mock("../src/telegram/api.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/telegram/api.js")>()),
  sendPhoto: sendTelegramPhoto,
  sendVideo: sendTelegramVideo,
  isTelegramEnabled: vi.fn(() => true),
  // Мок «свой Bot API сервер» (2 ГБ) — то же значение, что telegram/api.ts
  // считает при IS_LOCAL_BOT_API, независимо от окружения теста (найдено
  // 19.09.2026: раньше здесь стояла отдельная захардкоженная TELEGRAM_MEDIA_LIMIT
  // = 16 МБ, забытая при переезде на свой сервер — см. lib/conversationDelivery.ts).
  TELEGRAM_BOT_DOWNLOAD_LIMIT_BYTES: 2000 * 1024 * 1024,
}));

process.env.CRM_PUBLIC_URL = "https://crm-test.royalhome.tj";

const { prisma } = await import("../src/db.js");
const { deliverMediaToConversation } = await import("../src/lib/conversationDelivery.js");

let instagram: CustomerMessengerFixture;
let whatsapp: CustomerMessengerFixture;
beforeAll(async () => {
  instagram = await createCustomerMessengerFixture("INSTAGRAM");
  whatsapp = await createCustomerMessengerFixture("WHATSAPP");
});
function targetOf(c: { id: string; channel: string; subscriberId: string; accountId?: string | null }) {
  const fixture = c.channel === "INSTAGRAM" ? instagram : c.channel === "WHATSAPP" ? whatsapp : null;
  return { kind: "bot" as const, id: c.id, channel: c.channel, subscriberId: c.subscriberId,
    accountId: c.accountId, ...(fixture ? { transport: fixture.transport } : {}) };
}

const runId = Date.now();
const ids: string[] = [];
const telegramIds: string[] = [];

async function makeConversation(channel: "INSTAGRAM" | "WHATSAPP" = "INSTAGRAM") {
  const fixture = channel === "INSTAGRAM" ? instagram : whatsapp;
  const c = await prisma.botConversation.create({
    data: { channel, accountId: fixture.id, endpointScopeId: fixture.transport.endpointScopeId, subscriberId: `media-${runId}-${Math.random()}`, messages: [] },
  });
  ids.push(c.id);
  return c;
}

async function makeTelegramConversation() {
  const c = await prisma.telegramConversation.create({
    data: { chatId: `media-tg-${runId}-${Math.random()}`, messages: [] },
  });
  telegramIds.push(c.id);
  return c;
}

afterEach(() => vi.clearAllMocks());
afterAll(async () => {
  await instagram?.dispose();
  await whatsapp?.dispose();
  if (ids.length > 0) await prisma.botConversation.deleteMany({ where: { id: { in: ids } } });
  if (telegramIds.length > 0) await prisma.telegramConversation.deleteMany({ where: { id: { in: telegramIds } } });
});

describe("Успешная отправка файлом (в пределах лимита канала)", () => {
  it("фото допустимого размера уходит и пишется в историю с mid", async () => {
    const c = await makeConversation();
    const result = await deliverMediaToConversation(
      targetOf(c),
      { buffer: Buffer.alloc(1024, 1), mimetype: "image/jpeg" },
      { sender: { kind: "agent", agentId: "a1", agentName: "Фарход" } }
    );

    expect(result.ok).toBe(true);
    expect(sendImage).toHaveBeenCalledTimes(1);
    expect(sendVideo).not.toHaveBeenCalled();
    expect(sendMessage).not.toHaveBeenCalled();

    const saved = await prisma.botConversation.findUnique({ where: { id: c.id } });
    const messages = saved!.messages as unknown as {
      content: string;
      attachments?: { kind: string; mime?: string; url?: string }[];
      mid?: string;
    }[];
    expect(messages).toHaveLength(1);
    expect(messages[0].content).toBe("[📷 фото]");
    expect(messages[0].attachments?.[0]).toMatchObject({ kind: "image", mime: "image/jpeg" });
    // В историю — наш стабильный прокси-путь (R2-ключ подписывается заново на
    // чтение, см. routes/mediaProxy.ts), НЕ presigned-ссылка, которая истечёт.
    expect(messages[0].attachments?.[0]?.url).toMatch(/^\/api\/v1\/media\/chat\//);
    expect(messages[0].attachments?.[0]?.url).not.toContain("r2.test");
    expect(messages[0].mid).toBe("wamid.sent-image-1");

    const paused = await prisma.botConversation.findUnique({ where: { id: c.id }, select: { pausedUntil: true } });
    expect(paused!.pausedUntil!.getTime()).toBeGreaterThan(Date.now());
  });

  it("видео в пределах лимита канала уходит файлом через sendVideo, не ссылкой", async () => {
    const c = await makeConversation();
    const result = await deliverMediaToConversation(
      targetOf(c),
      { buffer: Buffer.alloc(2048, 1), mimetype: "video/mp4" },
      { sender: { kind: "agent", agentId: "a1", agentName: "Фарход" }, caption: "Ролик квартиры" }
    );

    expect(result.ok).toBe(true);
    expect(sendVideo).toHaveBeenCalledTimes(1);
    expect(sendImage).not.toHaveBeenCalled();
    expect(sendMessage).not.toHaveBeenCalled();

    const saved = await prisma.botConversation.findUnique({ where: { id: c.id } });
    const messages = saved!.messages as unknown as { content: string; attachments?: { kind: string }[] }[];
    expect(messages[0].content).toBe("Ролик квартиры");
    expect(messages[0].attachments?.[0]).toMatchObject({ kind: "video" });
  });

  it("Instagram: 20 МБ видео проходит файлом (предел 25 МБ) — разные каналы, разный потолок", async () => {
    const c = await makeConversation("INSTAGRAM");
    const result = await deliverMediaToConversation(
      targetOf(c),
      { buffer: Buffer.alloc(20 * 1024 * 1024), mimetype: "video/mp4" },
      { sender: { kind: "agent", agentId: "a1", agentName: "Фарход" } }
    );
    expect(result.ok).toBe(true);
    expect(sendVideo).toHaveBeenCalledTimes(1);
    expect(sendMessage).not.toHaveBeenCalled();
  });
});

describe("Файл с диска (загрузка из переписки, аудит 23.09.2026 №74)", () => {
  it("видео путём: в R2 уходит путь, а не буфер; лимит канала считается по размеру файла", async () => {
    const c = await makeConversation("WHATSAPP");
    const result = await deliverMediaToConversation(
      targetOf(c),
      { path: "/tmp/upload-from-inbox.mp4", size: 17 * 1024 * 1024, mimetype: "video/mp4" },
      { sender: { kind: "agent", agentId: "a1", agentName: "Фарход" } }
    );
    expect(result.ok).toBe(true);
    expect(uploadOutgoingMedia).toHaveBeenCalledWith(
      c.id,
      { path: "/tmp/upload-from-inbox.mp4", size: 17 * 1024 * 1024 },
      "mp4",
      "video/mp4"
    );
    // 17 МБ больше предела WhatsApp для видео — ссылкой, как и у буфера того же размера.
    expect(sendVideo).not.toHaveBeenCalled();
    expect(sendMessage).toHaveBeenCalledTimes(1);
  });

  it("фото путём больше предела канала отклоняется до загрузки в R2", async () => {
    const c = await makeConversation("WHATSAPP");
    const result = await deliverMediaToConversation(
      targetOf(c),
      { path: "/tmp/huge.jpg", size: 6 * 1024 * 1024, mimetype: "image/jpeg" },
      { sender: { kind: "agent", agentId: "a1", agentName: "Фарход" } }
    );
    expect(result.ok).toBe(false);
    expect(uploadOutgoingMedia).not.toHaveBeenCalled();
  });
});

describe("Видео больше лимита канала — гибридный режим: ссылка, не файл", () => {
  it("WhatsApp: видео 17 МБ (> 16 МБ) уходит НЕ отклонённым, а текстом со ссылкой", async () => {
    const c = await makeConversation("WHATSAPP");
    const result = await deliverMediaToConversation(
      targetOf(c),
      { buffer: Buffer.alloc(17 * 1024 * 1024), mimetype: "video/mp4" },
      { sender: { kind: "agent", agentId: "a1", agentName: "Фарход" } }
    );
    // Раньше это был отказ 400 — с гибридным режимом видео больше лимита канала
    // больше не отклоняется, файл всё равно уходит в R2.
    expect(result.ok).toBe(true);
    expect(sendVideo).not.toHaveBeenCalled();
    expect(sendImage).not.toHaveBeenCalled();
    expect(sendMessage).toHaveBeenCalledTimes(1);
    expect(uploadOutgoingMedia).toHaveBeenCalledTimes(1);
    // Ссылка Meta не должна быть presigned-адресом R2 — Meta вообще не видит файл
    // напрямую в этой ветке, только текст со ссылкой на наш прокси.
    const [, , sentText] = sendMessage.mock.calls[0];
    expect(sentText).toContain("Видео объекта:");
    expect(sentText).toContain("https://crm-test.royalhome.tj/api/v1/media/chat/");
    expect(sentText).not.toContain("r2.test");

    const saved = await prisma.botConversation.findUnique({ where: { id: c.id } });
    const messages = saved!.messages as unknown as { content: string; attachments?: { kind: string; url?: string }[]; mid?: string }[];
    expect(messages[0].content).toContain("Видео объекта:");
    expect(messages[0].attachments?.[0]).toMatchObject({ kind: "video" });
    expect(messages[0].attachments?.[0]?.url).toMatch(/^\/api\/v1\/media\/chat\//);
    expect(messages[0].mid).toBe("wamid.sent-text-1");
  });

  it("огромный ролик объекта (200 МБ) на Instagram тоже уходит ссылкой, не отклоняется", async () => {
    const c = await makeConversation("INSTAGRAM");
    const result = await deliverMediaToConversation(
      targetOf(c),
      { buffer: Buffer.alloc(200 * 1024 * 1024), mimetype: "video/mp4" },
      { sender: { kind: "agent", agentId: "a1", agentName: "Фарход" }, caption: "Полный ролик" }
    );
    expect(result.ok).toBe(true);
    expect(sendMessage).toHaveBeenCalledTimes(1);
    const [, , sentText] = sendMessage.mock.calls[0];
    // Подпись оператора уходит первой строкой, ссылка — следом.
    expect(sentText).toContain("Полный ролик");
    expect(sentText).toContain("Видео объекта:");
  });

  it("без CRM_PUBLIC_URL большое видео отправить нельзя — 503, без загрузки в R2", async () => {
    const saved = process.env.CRM_PUBLIC_URL;
    delete process.env.CRM_PUBLIC_URL;
    try {
      const c = await makeConversation("WHATSAPP");
      const result = await deliverMediaToConversation(
        targetOf(c),
        { buffer: Buffer.alloc(17 * 1024 * 1024), mimetype: "video/mp4" },
        { sender: { kind: "agent", agentId: "a1", agentName: "Фарход" } }
      );
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.status).toBe(503);
      expect(uploadOutgoingMedia).not.toHaveBeenCalled();
    } finally {
      process.env.CRM_PUBLIC_URL = saved;
    }
  });
});

describe("Отказ по размеру — только фото, до отправки и без записи в файл", () => {
  it("WhatsApp: фото больше 5 МБ отклоняется", async () => {
    const c = await makeConversation("WHATSAPP");
    const result = await deliverMediaToConversation(
      targetOf(c),
      { buffer: Buffer.alloc(6 * 1024 * 1024), mimetype: "image/jpeg" },
      { sender: { kind: "agent", agentId: "a1", agentName: "Фарход" } }
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.status).toBe(400);
    expect(uploadOutgoingMedia).not.toHaveBeenCalled();
    expect(sendImage).not.toHaveBeenCalled();
  });
});

describe("Отказ по типу файла", () => {
  it("недопустимый mime (например audio/*) отклоняется до отправки", async () => {
    const c = await makeConversation();
    const result = await deliverMediaToConversation(
      targetOf(c),
      { buffer: Buffer.from("не фото и не видео"), mimetype: "audio/ogg" },
      { sender: { kind: "agent", agentId: "a1", agentName: "Фарход" } }
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.status).toBe(400);
    expect(sendImage).not.toHaveBeenCalled();
    expect(sendVideo).not.toHaveBeenCalled();
  });
});

describe("R2 не настроен", () => {
  it("отказывает с 503 и не пытается сохранить файл", async () => {
    isR2Configured.mockReturnValueOnce(false);
    const c = await makeConversation();
    const result = await deliverMediaToConversation(
      targetOf(c),
      { buffer: Buffer.alloc(1024, 1), mimetype: "image/jpeg" },
      { sender: { kind: "agent", agentId: "a1", agentName: "Фарход" } }
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.status).toBe(503);
    expect(uploadOutgoingMedia).not.toHaveBeenCalled();
    expect(sendImage).not.toHaveBeenCalled();
  });
});

describe("Telegram — та же цепочка, свой транспорт (19.08.2026)", () => {
  it("фото: presigned-ссылка уходит через sendPhoto, запись в TelegramConversation.messages", async () => {
    const c = await makeTelegramConversation();
    const result = await deliverMediaToConversation(
      { kind: "telegram", id: c.id, subscriberId: c.chatId },
      { buffer: Buffer.alloc(1024, 1), mimetype: "image/jpeg" },
      { sender: { kind: "agent", agentId: "a1", agentName: "Фарход" }, caption: "Вот квартира" }
    );

    expect(result.ok).toBe(true);
    expect(sendTelegramPhoto).toHaveBeenCalledTimes(1);
    expect(sendTelegramPhoto.mock.calls[0][0]).toBe(c.chatId);
    expect(sendTelegramPhoto.mock.calls[0][1]).toContain("https://r2.test/");
    expect(sendTelegramPhoto.mock.calls[0][2]).toBe("Вот квартира");
    expect(sendImage).not.toHaveBeenCalled();

    const saved = await prisma.telegramConversation.findUnique({ where: { id: c.id } });
    const messages = saved!.messages as unknown as { content: string; attachments?: { kind: string }[] }[];
    expect(messages).toHaveLength(1);
    expect(messages[0].content).toBe("Вот квартира");
    expect(messages[0].attachments?.[0]).toMatchObject({ kind: "image" });
  });

  it("видео: тот же путь, sendVideo", async () => {
    const c = await makeTelegramConversation();
    const result = await deliverMediaToConversation(
      { kind: "telegram", id: c.id, subscriberId: c.chatId },
      { buffer: Buffer.alloc(1024, 1), mimetype: "video/mp4" },
      { sender: { kind: "agent", agentId: "a1", agentName: "Фарход" } }
    );

    expect(result.ok).toBe(true);
    expect(sendTelegramVideo).toHaveBeenCalledTimes(1);
    expect(sendVideo).not.toHaveBeenCalled();
  });

  /**
   * Найдено 19.09.2026: TELEGRAM_MEDIA_LIMIT была захардкожена в 16 МБ и не
   * поднялась вместе с переездом на свой Bot API сервер — оператор не мог
   * отправить клиенту видео крупнее 16 МБ через Telegram из инбокса, хотя
   * сервер давно тянет до 2 ГБ. 30 МБ — заведомо больше старого лимита,
   * заведомо меньше нового.
   */
  it("видео 30 МБ (больше старого захардкоженного лимита 16 МБ) — проходит на своём Bot API сервере", async () => {
    const c = await makeTelegramConversation();
    const result = await deliverMediaToConversation(
      { kind: "telegram", id: c.id, subscriberId: c.chatId },
      { buffer: Buffer.alloc(30 * 1024 * 1024, 1), mimetype: "video/mp4" },
      { sender: { kind: "agent", agentId: "a1", agentName: "Фарход" } }
    );

    expect(result.ok).toBe(true);
    expect(sendTelegramVideo).toHaveBeenCalledTimes(1);
  });
});
