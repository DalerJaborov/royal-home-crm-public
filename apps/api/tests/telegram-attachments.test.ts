import fs from "node:fs";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import bcrypt from "bcrypt";
import request from "supertest";
import { app } from "../src/app.js";
import { prisma } from "../src/db.js";
import { savePrivateFile, privateFilePath } from "../src/lib/privateFiles.js";
import { fetchTelegramAttachments } from "../src/telegram/attachments.js";
import { handleTelegramUpdate } from "../src/telegram/bot.js";

/* Транспорт и ИИ подменены только для блока «сообщение без подписи» ниже:
 * разбор вложений выше идёт настоящим кодом (без токена — без сети). */
const { sendMessage, callAiText } = vi.hoisted(() => ({
  sendMessage: vi.fn(async (_chatId: string, _text: string) => {}),
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

/**
 * Вложения из переписки в Telegram.
 *
 * Фото и голосовые из Instagram, WhatsApp и Messenger давно скачиваются и видны в
 * CRM: они идут через processMessengerTurn. У Telegram своя таблица и свой путь
 * обработки, который мимо этого конвейера и проходил — клиент присылал фото
 * квартиры, а сотрудник видел пустоту. Здесь стерегутся оба конца починки:
 *
 *   1. Вход: медиа в сообщении вообще ЗАМЕЧЕНО (раньше поля даже не читались), а
 *      обычный текст при этом по-прежнему не считается вложением.
 *   2. Выход: сохранённое вложение доезжает до инбокса ровно с теми же правами,
 *      что и у остальных каналов, — имя файла видит только тот, кому положено.
 *
 * Скачивание в тестах не происходит: TELEGRAM_BOT_TOKEN не задан, поэтому getFile
 * даже не вызывается. Проверяется именно разбор сообщения, без сети.
 */

const runId = Date.now();
const password = "testpass123";

const directorPhone = `+99295${String(runId).slice(-7)}`;
const managerPhone = `+99296${String(runId).slice(-7)}`;

let directorToken: string;
let managerToken: string;

const createdAgentIds: string[] = [];
const createdFiles: string[] = [];
let conversationId: string;
let photoFile: string;
let voiceFile: string;

async function login(phone: string): Promise<string> {
  const res = await request(app).post("/api/v1/auth/login").send({ phone, password });
  expect(res.status).toBe(200);
  return res.body.accessToken;
}

async function createAgent(fullName: string, phone: string, role: "DIRECTOR" | "MANAGER") {
  const agent = await prisma.agent.create({
    data: { fullName, phone, passwordHash: await bcrypt.hash(password, 10), role, isActive: true },
  });
  createdAgentIds.push(agent.id);
  return agent;
}

beforeAll(async () => {
  await createAgent(`Директор Телеграма ${runId}`, directorPhone, "DIRECTOR");
  await createAgent(`Руководитель Телеграма ${runId}`, managerPhone, "MANAGER");
  [directorToken, managerToken] = await Promise.all([login(directorPhone), login(managerPhone)]);

  const savedPhoto = await savePrivateFile(Buffer.from(`tg-photo-${runId}`), "image/jpeg");
  const savedVoice = await savePrivateFile(Buffer.from(`tg-voice-${runId}`), "audio/ogg");
  expect(savedPhoto).toBeTruthy();
  expect(savedVoice).toBeTruthy();
  photoFile = savedPhoto!;
  voiceFile = savedVoice!;
  createdFiles.push(photoFile, voiceFile);

  const conversation = await prisma.telegramConversation.create({
    data: {
      chatId: `tg-att-${runId}`,
      username: `client_${runId}`,
      messages: [
        { role: "user", content: "салом" },
        { role: "assistant", content: "Здравствуйте! Что ищете?" },
        {
          role: "user",
          content: "[📷]",
          attachments: [
            { kind: "image", file: photoFile, mime: "image/jpeg" },
            { kind: "audio", file: voiceFile, mime: "audio/ogg" },
          ],
        },
      ],
      lastMessageAt: new Date(),
    },
  });
  conversationId = conversation.id;
});

afterAll(async () => {
  // Убираем за собой: база и хранилище общие с другими прогонами.
  await prisma.telegramConversation.deleteMany({ where: { id: conversationId } });
  await prisma.agent.deleteMany({ where: { id: { in: createdAgentIds } } });
  for (const name of createdFiles) {
    const full = privateFilePath(name);
    if (full) fs.rmSync(full, { force: true });
  }
});

describe("Разбор входящего сообщения Telegram", () => {
  it("обычный текст вложением не считается", async () => {
    const fetched = await fetchTelegramAttachments({});
    expect(fetched.images).toHaveLength(0);
    expect(fetched.audios).toHaveLength(0);
    // Ни одного вложения не было — и пометки «файл не открылся» быть не должно,
    // иначе бот извинялся бы за файл на каждое «салом».
    expect(fetched.hadUnsupported).toBe(false);
  });

  it("фото в сообщении замечено — раньше эти поля не читались вовсе", async () => {
    // Telegram отдаёт лесенку превью; берётся самый крупный элемент.
    const fetched = await fetchTelegramAttachments({
      photo: [
        { file_id: "small", width: 90 },
        { file_id: "large", width: 1280 },
      ],
    });
    // Токена бота в тестах нет, поэтому адрес не добывается и файл не скачивается —
    // но само вложение обнаружено, и это видно по честной пометке.
    expect(fetched.hadUnsupported).toBe(true);
  });

  it("голосовое замечено", async () => {
    const fetched = await fetchTelegramAttachments({ voice: { file_id: "voice-1", mime_type: "audio/ogg" } });
    expect(fetched.hadUnsupported).toBe(true);
  });

  it("видеокружок помечается как неоткрытый, но запроса к Telegram не делает", async () => {
    // Хранить его негде и показать нечем — отсекаем до обращения к API,
    // а клиент честно узнаёт, что файл мы не посмотрели.
    const fetched = await fetchTelegramAttachments({ video_note: { file_id: "circle-1" } });
    expect(fetched.hadUnsupported).toBe(true);
    expect(fetched.images).toHaveLength(0);
  });

  it("обычное видео (рум-тур) замечено — раньше msg.video не читалось вовсе (24.09.2026)", async () => {
    const fetched = await fetchTelegramAttachments({ video: { file_id: "tour-1", mime_type: "video/mp4" } });
    // Токена нет — адрес не добыт, но само вложение обнаружено (как у фото выше).
    expect(fetched.hadUnsupported).toBe(true);
  });

  it("стикер и геометка помечаются как неоткрытые, запроса к Telegram нет", async () => {
    expect((await fetchTelegramAttachments({ sticker: { file_id: "st-1" } })).hadUnsupported).toBe(true);
    expect((await fetchTelegramAttachments({ location: { latitude: 38.56, longitude: 68.79 } })).hadUnsupported).toBe(true);
  });

  it("документ-картинка берётся, а договор в pdf — нет", async () => {
    const asPdf = await fetchTelegramAttachments({
      document: { file_id: "doc-1", mime_type: "application/pdf", file_name: "договор.pdf" },
    });
    expect(asPdf.hadUnsupported).toBe(true);
    expect(asPdf.images).toHaveLength(0);

    // Скриншот «без сжатия» приходит документом — такой мы открыть умеем.
    const asPng = await fetchTelegramAttachments({
      document: { file_id: "doc-2", mime_type: "image/png", file_name: "экран.png" },
    });
    expect(asPng.hadUnsupported).toBe(true); // адрес не добыт: токена нет
    expect(asPng.images).toHaveLength(0);
  });
});

/**
 * Ночная проверка 24.09.2026 (bot-kanaly №7): видеокружок, стикер, геометка БЕЗ
 * подписи исчезали без следа — пометка «файл не открылся» клеилась только при
 * тексте или фото, history оставалась пустой, saveIncoming выходил на `if (!content)`.
 * В CRM сообщения не было, клиент ответа не получал.
 */
describe("Сообщение Telegram без подписи, которое мы не открываем", () => {
  const chatIds: string[] = [];
  let nextUpdateId = runId % 1_000_000_000;
  let savedBot: { botEnabled: boolean; botTelegramEnabled: boolean; telegramOwnerChatId: string | null };

  beforeAll(async () => {
    savedBot = await prisma.settings.upsert({
      where: { id: "singleton" },
      update: {},
      create: { id: "singleton" },
      select: { botEnabled: true, botTelegramEnabled: true, telegramOwnerChatId: true },
    });
    await prisma.settings.update({
      where: { id: "singleton" },
      data: { botEnabled: true, botTelegramEnabled: true, telegramOwnerChatId: null },
    });
  });
  afterAll(async () => {
    await prisma.telegramConversation.deleteMany({ where: { chatId: { in: chatIds } } });
    await prisma.settings.update({ where: { id: "singleton" }, data: savedBot });
  });
  beforeEach(() => {
    sendMessage.mockClear();
    callAiText.mockReset();
    callAiText.mockResolvedValue({ reply: ["Файл не открылся, напишите текстом"], ready: false, intent: "buy", confident: true });
  });

  async function lastClientLine(chatId: string): Promise<string | undefined> {
    const row = await prisma.telegramConversation.findUnique({ where: { chatId }, select: { messages: true } });
    const messages = (row?.messages as unknown as { role: string; content: string }[] | null) ?? [];
    return messages.filter((m) => m.role === "user").at(-1)?.content;
  }

  it("видеокружок без подписи: в переписке есть реплика с пометкой, бот ответил", async () => {
    const chatId = String(783000001 + (runId % 100000));
    chatIds.push(chatId);
    await handleTelegramUpdate({
      update_id: nextUpdateId++,
      message: { chat: { id: Number(chatId) }, from: { username: `circle_${runId}` }, video_note: { file_id: "circle-9" } },
    });
    expect(await lastClientLine(chatId)).toContain("[видеокружок]");
    expect(sendMessage).toHaveBeenCalledTimes(1);
  });

  it("стикер и геометка без подписи: пометка в переписке", async () => {
    const chatId = String(783000002 + (runId % 100000));
    chatIds.push(chatId);
    await handleTelegramUpdate({
      update_id: nextUpdateId++,
      message: { chat: { id: Number(chatId) }, from: { username: `sticker_${runId}` }, sticker: { file_id: "st-9" } },
    });
    expect(await lastClientLine(chatId)).toContain("[стикер]");
    await handleTelegramUpdate({
      update_id: nextUpdateId++,
      message: { chat: { id: Number(chatId) }, from: { username: `sticker_${runId}` }, location: { latitude: 38.56, longitude: 68.79 } },
    });
    expect(await lastClientLine(chatId)).toContain("[геометка]");
  });
});

describe("Вложения Telegram в инбоксе", () => {
  it("директор видит имена файлов в переписке Telegram", async () => {
    const res = await request(app)
      .get(`/api/v1/conversations/tg_${conversationId}`)
      .set("Authorization", `Bearer ${directorToken}`);

    expect(res.status).toBe(200);
    const withFiles = res.body.messages[2];
    expect(withFiles.attachments).toHaveLength(2);
    expect(withFiles.attachments[0]).toEqual({ kind: "image", mime: "image/jpeg", file: photoFile });
    expect(withFiles.attachments[1]).toEqual({ kind: "audio", mime: "audio/ogg", file: voiceFile });
  });

  it("руководителю имя файла не приезжает — то же правило, что у остальных каналов", async () => {
    const res = await request(app)
      .get(`/api/v1/conversations/tg_${conversationId}`)
      .set("Authorization", `Bearer ${managerToken}`);

    expect(res.status).toBe(200);
    const withFiles = res.body.messages[2];
    expect(withFiles.attachments).toHaveLength(2);
    expect(withFiles.attachments[0].file).toBeNull();
    expect(withFiles.attachments[1].file).toBeNull();
    // Текст переписки при этом виден целиком — право закрывает только файлы.
    expect(res.body.messages[0].content).toBe("салом");
  });
});

// Ответ бота в Telegram ждёт окно склейки быстрых сообщений (находка №132,
// 01.10.2026; по умолчанию 25 секунд). Здесь проверяется сам ответ, а не
// склейка, — окно на время файла нулевое (склейку проверяет telegram-debounce).
const { instantBotReplyWindow } = await import("./helpers/botReplyWindow.js");
let restoreReplyWindow: (() => Promise<void>) | undefined;
beforeAll(async () => {
  restoreReplyWindow = await instantBotReplyWindow();
});
afterAll(async () => {
  await restoreReplyWindow?.();
});
