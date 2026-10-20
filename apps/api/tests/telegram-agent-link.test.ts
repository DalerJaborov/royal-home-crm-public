import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import bcrypt from "bcrypt";

/**
 * Личный чат сотрудника с CRM-ботом (telegram/bot.ts::handleAgentTelegramMessage,
 * 01.09.2026) — привязка по коду и приём готового ролика от монтажёра.
 *
 * САМОЕ ВАЖНОЕ, что здесь проверяется: этот путь НИКОГДА не должен перехватывать
 * настоящего клиента. Один тест нарочно шлёт /start с чужим/неизвестным кодом —
 * это должно провалиться в обычную клиентскую логику (callAiText вызван), а не
 * потеряться молча.
 *
 * Telegram (sendMessage/downloadFile) и ИИ (callAiText) — подменены: тест не
 * ходит ни в Telegram, ни к Anthropic. receiveEditedVideo — тоже подменена: её
 * собственное поведение (очередь, публикация) уже покрыто tests/video-handoff.test.ts,
 * здесь важно только то, что бот её ВЫЗЫВАЕТ с правильными параметрами и не
 * пускает видео в клиентский разбор.
 */

const {
  sendMessage,
  sendMessageWithButtons,
  resolveTelegramFileMaterialization,
  receiveEditedVideo,
  receiveEditedVideoFromFile,
  findResendCandidate,
  reopenForResend,
  undoReopenForResend,
  queueStatusForMontajer,
  montajerCardText,
  resendSourceVideos,
  recordMontajerMessage,
  callAiText,
} =
  vi.hoisted(() => ({
    sendMessage: vi.fn(async (_chatId: string, _text: string) => {}),
    sendMessageWithButtons: vi.fn(async (_chatId: string, _text: string, _buttons: unknown) => {}),
    // Заменяет старый downloadFile-мок (23.09.2026, приём B3): bot.ts больше не
    // читает файл своего Bot API в буфер — резолвит путь-или-буфер, по умолчанию
    // здесь облачный вид (buffer), как раньше давал downloadFile.
    resolveTelegramFileMaterialization: vi.fn(async (_fileId: string, _maxBytes?: number) => ({
      kind: "buffer" as const,
      buffer: Buffer.from("готовый ролик"),
    })),
    receiveEditedVideoFromFile: vi.fn(async (_propertyId: string, _srcPath: string, _filename: string) => ({
      ok: true,
      summary: null,
    })),
    // По умолчанию — «опубликовано»: расписка монтажёру тогда «Ролик принят ✅»
    // (до 20.09.2026 текст начинался с «Готово» — тесты ниже сверяют по
    // «Ролик принят», общему для всех удачных исходов); честность самого текста
    // по разным исходам покрыта отдельно в videoHandoff.test.ts.
    receiveEditedVideo: vi.fn(async (_propertyId: string, _buffer: Buffer, _filename: string) => ({
      ok: true,
      summary: {
        attempted: true,
        succeededChannels: ["INSTAGRAM"],
        failedChannels: [],
        notes: [],
        instagramUrl: null,
        wentAvailable: false,
        blockers: [],
      },
    })),
    findResendCandidate: vi.fn(async () => null),
    reopenForResend: vi.fn(async (_propertyId: string) => true),
    undoReopenForResend: vi.fn(async (_propertyId: string) => {}),
    // Содержимое статуса очереди своё покрыто в video-handoff.test.ts — здесь
    // важно только то, что обычный текст текущего монтажёра уходит именно сюда,
    // а не в клиентскую квалификацию.
    queueStatusForMontajer: vi.fn(async () => "Сейчас монтаж ничего не ждёт."),
    // Карточка по номеру — то, чего 19.09.2026 не хватило монтажёру: содержимое
    // проверяется в video-handoff.test.ts, здесь — что бот её вообще спрашивает.
    montajerCardText: vi.fn(async (shortId: number) => `Объект №${shortId}\nПлощадь: 48 м²`),
    resendSourceVideos: vi.fn(async () => ({ ok: true, shortId: 108 })),
    // Запись отправленного монтажёру: тест её содержимое не проверяет, но
    // bot.ts её зовёт, а подмена ниже перечисляет вывоз модуля ЦЕЛИКОМ — без
    // этой заглушки прогон падает «No export is defined on the mock».
    recordMontajerMessage: vi.fn(async (_propertyId: string, _kind: string, _text: string) => {}),
    callAiText: vi.fn(),
  }));

vi.mock("../src/telegram/api.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/telegram/api.js")>()),
  sendMessage,
  sendMessageWithButtons,
  resolveTelegramFileMaterialization,
}));
/* Подмена БЕЗ importOriginal: модуль тяжёлый, и тест нарочно отрезает его
 * целиком. Цена этого выбора — список должен содержать КАЖДЫЙ вывоз
 * videoHandoff.ts, который зовёт telegram/bot.ts: забытый вывоз валит прогон
 * не здесь, а в bot.ts, текстом «No <имя> export is defined on the mock».
 * Так и вышло 20.09.2026 с recordMontajerMessage, а 23.09.2026 — с
 * receiveEditedVideoFromFile (приём B3, приём с диска Bot API без буфера). */
/** Настоящее определение «кто держит место» — объект, а не функция. Но в полном
 *  прогоне соседний файл того же шарда оставляет СВОЕГО держателя места, и бот
 *  берёт его вместо нашего (25.09.2026: 7 красных только в полном прогоне,
 *  в одиночку файл зелёный). Поэтому объект изменяемый: в beforeEach сужаем его
 *  до объектов этого файла — у всех в названии runId. */
const HOLDER_WHERE = vi.hoisted(
  () => ({ videoHandoffStatus: "SENT_TO_EDITOR", deletedAt: null, videoHandoffManualSince: null }) as Record<string, unknown>
);
vi.mock("../src/lib/videoHandoff.js", () => ({
  receiveEditedVideo,
  receiveEditedVideoFromFile,
  findResendCandidate,
  reopenForResend,
  undoReopenForResend,
  // Настоящее определение «кто держит место» — объект, а не функция, подменять незачем.
  EDITOR_HOLDER_WHERE: HOLDER_WHERE,
  // Окно пересылки — число, подменять незачем; бот сверяет по нему файл с номером (24.09.2026).
  RESEND_WINDOW_MS: 3 * 60 * 60 * 1000,
  queueStatusForMontajer,
  montajerCardText,
  resendSourceVideos,
  recordMontajerMessage,
  // bot.ts → lib/telegramModeration → lib/propertyReview импортирует и это (22.09.2026).
  queueVideoHandoff: async () => {},
  // Меню монтажёра (telegram/montajerBot.ts → lib/montajerViews.ts, 25.09.2026):
  // очередь, ссылки на исходники и общий порядок файлов. Свои тесты у меню —
  // tests/montajer-menu.test.ts, здесь только чтобы бот не падал на отсутствии.
  orderedQueue: async () => [],
  rawVideoDownloadLink: () => null,
  SOURCE_VIDEO_ORDER: [{ uploadedAt: "asc" }, { id: "asc" }],
  // Проверка готового ролика (telegram/clipReviewBot.ts, 25.09.2026): подписка на
  // событие и факты карточки — здесь заглушки, свои тесты у неё в tests/clip-review.test.ts.
  onClipReviewRequested: () => {},
  propertyFactsForMontajer: async () => "",
  videoHandoffFinalDiskPath: () => null,
}));
vi.mock("../src/ai/client.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/ai/client.js")>()),
  callAiText,
}));

// Маркер бота убираем: без него getBotUsername/getFile лезли бы в сеть. Проверяем
// маршрутизацию, а не саму отправку — тем же приёмом, что и telegram-album.test.ts.
delete process.env.TELEGRAM_BOT_TOKEN;

const { prisma } = await import("../src/db.js");
const { handleTelegramUpdate } = await import("../src/telegram/bot.js");
const { createTelegramLinkCode } = await import("../src/lib/telegramAgentLink.js");

const runId = Date.now();
const phone = `+99297${runId.toString().slice(-7)}`;
const AGENT_CHAT_ID = 790000000 + (runId % 1_000_000);
const CLIENT_CHAT_ID = 791000000 + (runId % 1_000_000);
let nextUpdateId = runId % 1_000_000_000;

let agentId: string;
let districtId: string;
const propertyIds: string[] = [];

type SettingsSnapshot = {
  botEnabled: boolean;
  botTelegramEnabled: boolean;
  telegramOwnerChatId: string | null;
  videoMontajerAgentId: string | null;
  videoHandoffEnabled: boolean;
};
const SELECT = { botEnabled: true, botTelegramEnabled: true, telegramOwnerChatId: true, videoMontajerAgentId: true, videoHandoffEnabled: true } as const;
let savedSettings: SettingsSnapshot;

async function textUpdate(chatId: number, text: string) {
  return handleTelegramUpdate({
    update_id: nextUpdateId++,
    message: { chat: { id: chatId }, from: { username: `u_${runId}` }, text },
  });
}

beforeEach(async () => {
  // Только держатели этого файла (см. HOLDER_WHERE выше).
  HOLDER_WHERE.title = { contains: String(runId) };
  sendMessage.mockClear();
  sendMessageWithButtons.mockClear();
  montajerCardText.mockClear();
  resendSourceVideos.mockClear();
  resolveTelegramFileMaterialization.mockClear();
  resolveTelegramFileMaterialization.mockResolvedValue({ kind: "buffer", buffer: Buffer.from("готовый ролик") });
  receiveEditedVideo.mockClear();
  receiveEditedVideoFromFile.mockClear();
  findResendCandidate.mockClear();
  reopenForResend.mockClear();
  callAiText.mockReset();
  callAiText.mockResolvedValue({ reply: ["Ответ клиенту"], ready: false, confident: true });

  if (!agentId) {
    const agent = await prisma.agent.create({
      data: {
        fullName: "Монтажёр привязки",
        phone,
        role: "AGENT",
        passwordHash: await bcrypt.hash("testpass123", 10),
      },
    });
    agentId = agent.id;
    const district = await prisma.district.create({ data: { name: `Привязка Telegram-${runId}` } });
    districtId = district.id;
    savedSettings = await prisma.settings.upsert({
      where: { id: "singleton" },
      update: {},
      create: { id: "singleton" },
      select: SELECT,
    });
    await prisma.settings.update({
      where: { id: "singleton" },
      // Чат владельца обнуляем: совпади он с тестовым CLIENT_CHAT_ID, бот принял
      // бы клиента за служебную переписку директора. videoMontajerAgentId — этим же
      // агентом: с 14.09.2026 приём ролика в личном чате гейтится на «назначенного
      // монтажёра», иначе просто привязанный чат ролик принять не может.
      // videoHandoffEnabled — с 25.09.2026 бот без него ролик не принимает (А8).
      data: { botEnabled: true, botTelegramEnabled: true, telegramOwnerChatId: null, videoMontajerAgentId: agentId, videoHandoffEnabled: true },
    });
  }
  // Каждый тест стартует с чистой привязкой — иначе один тест мог бы жить с
  // уже привязанным чатом от предыдущего.
  await prisma.agent.update({ where: { id: agentId }, data: { telegramChatId: null, telegramLinkCode: null } });
  // Очередь общая на всю таблицу Property — объект, оставшийся SENT_TO_EDITOR
  // от одного теста, иначе ложно находится следующим тестом на «нет объекта».
  if (propertyIds.length) {
    await prisma.property.updateMany({ where: { id: { in: propertyIds } }, data: { videoHandoffStatus: "NONE" } });
  }
});

afterAll(async () => {
  await prisma.telegramConversation.deleteMany({ where: { chatId: { in: [String(AGENT_CHAT_ID), String(CLIENT_CHAT_ID)] } } });
  await prisma.property.deleteMany({ where: { id: { in: propertyIds } } });
  await prisma.district.deleteMany({ where: { id: districtId } });
  await prisma.agent.deleteMany({ where: { phone } });
  if (savedSettings) await prisma.settings.update({ where: { id: "singleton" }, data: savedSettings });
});

describe("Привязка личного чата по коду", () => {
  it("верный код — чат привязывается, ответ подтверждает, клиентская логика не трогается", async () => {
    const { code } = await createTelegramLinkCode(agentId);

    await textUpdate(AGENT_CHAT_ID, `/start ${code}`);

    const agent = await prisma.agent.findUniqueOrThrow({ where: { id: agentId } });
    expect(agent.telegramChatId).toBe(String(AGENT_CHAT_ID));
    expect(agent.telegramLinkCode).toBeNull();
    expect(sendMessage).toHaveBeenCalledWith(String(AGENT_CHAT_ID), expect.stringContaining("Готово"));
    expect(callAiText).not.toHaveBeenCalled();
  });

  it("неизвестный/чужой код — не привязывает и не глушит, уходит в обычную клиентскую логику", async () => {
    await textUpdate(CLIENT_CHAT_ID, "/start не-существующий-код");

    const agent = await prisma.agent.findUniqueOrThrow({ where: { id: agentId } });
    expect(agent.telegramChatId).toBeNull();
    // Раз чат не привязан ни к какому агенту — сообщение дошло до квалификации клиента.
    expect(callAiText).toHaveBeenCalledTimes(1);
  });
});

describe("Приём готового ролика в привязанном чате", () => {
  async function linkAgentChat() {
    const { code } = await createTelegramLinkCode(agentId);
    await textUpdate(AGENT_CHAT_ID, `/start ${code}`);
    sendMessage.mockClear();
  }

  it("видео документом в привязанном чате — уходит в receiveEditedVideo для объекта в очереди, не в клиентский разбор", async () => {
    await linkAgentChat();
    const property = await prisma.property.create({
      data: {
        title: `Ждёт монтажёра-${runId}`,
        type: "APARTMENT",
        areaSqm: 40,
        price: 200000,
        currency: "TJS",
        districtId,
        address: "Тестовая, 21",
        condition: "GOOD",
        videoHandoffStatus: "SENT_TO_EDITOR",
      },
    });
    propertyIds.push(property.id);

    await handleTelegramUpdate({
      update_id: nextUpdateId++,
      message: {
        chat: { id: AGENT_CHAT_ID },
        document: { file_id: "doc-1", mime_type: "video/mp4", file_name: "ready.mp4" },
      },
    });

    expect(receiveEditedVideo).toHaveBeenCalledWith(property.id, expect.any(Buffer), "ready.mp4");
    expect(callAiText).not.toHaveBeenCalled();
    // Квитанция называет объект (24.09.2026): монтажёр видит, куда лёг файл.
    expect(sendMessage).toHaveBeenCalledWith(String(AGENT_CHAT_ID), expect.stringContaining(`Ролик по объекту №${property.shortId} принят`));
  });

  it("нет объекта, ждущего ролик, — понятный ответ, receiveEditedVideo не вызывается", async () => {
    await linkAgentChat();

    await handleTelegramUpdate({
      update_id: nextUpdateId++,
      message: { chat: { id: AGENT_CHAT_ID }, video: { file_id: "vid-1" } },
    });

    expect(receiveEditedVideo).not.toHaveBeenCalled();
    expect(sendMessage).toHaveBeenCalledWith(String(AGENT_CHAT_ID), expect.stringContaining("Не вижу объекта"));
  });

  it("чат привязан, но агент сейчас не назначен монтажёром — ролик не принимается", async () => {
    await linkAgentChat();
    await prisma.settings.update({ where: { id: "singleton" }, data: { videoMontajerAgentId: null } });

    await handleTelegramUpdate({
      update_id: nextUpdateId++,
      message: { chat: { id: AGENT_CHAT_ID }, video: { file_id: "vid-1" } },
    });

    expect(receiveEditedVideo).not.toHaveBeenCalled();
    expect(sendMessage).toHaveBeenCalledWith(String(AGENT_CHAT_ID), expect.stringContaining("не назначен монтажёром"));

    await prisma.settings.update({ where: { id: "singleton" }, data: { videoMontajerAgentId: agentId } });
  });

  it("недавно принятый и ЕЩЁ не опубликованный ролик — новый файл открывает объект заново и уходит в receiveEditedVideo (переслать, если ошибся файлом)", async () => {
    await linkAgentChat();
    const property = await prisma.property.create({
      data: {
        title: `Пересылка-${runId}`,
        type: "APARTMENT",
        areaSqm: 40,
        price: 200000,
        currency: "TJS",
        districtId,
        address: "Тестовая, 22",
        condition: "GOOD",
        videoHandoffStatus: "RECEIVED",
        videoHandoffSentAt: new Date(),
      },
    });
    propertyIds.push(property.id);
    findResendCandidate.mockResolvedValueOnce({ propertyId: property.id, shortId: property.shortId, alreadyPublished: false });

    await handleTelegramUpdate({
      update_id: nextUpdateId++,
      message: {
        chat: { id: AGENT_CHAT_ID },
        document: { file_id: "doc-2", mime_type: "video/mp4", file_name: "исправленный.mp4" },
      },
    });

    expect(reopenForResend).toHaveBeenCalledWith(property.id);
    expect(receiveEditedVideo).toHaveBeenCalledWith(property.id, expect.any(Buffer), "исправленный.mp4");
  });

  /**
   * Ночная проверка 24.09.2026: reopenForResend ставит объект в SENT_TO_EDITOR
   * ДО скачивания. Если файл не скачался, откат обязателен — иначе объект
   * вечно «на монтаже», досылка и тревога молчат, очередь стоит.
   */
  it("пересылка: файл не скачался — переоткрытый объект откатывается (undoReopenForResend), приёма нет", async () => {
    await linkAgentChat();
    undoReopenForResend.mockClear();
    const propertyId = `resend-undo-${runId}`;
    findResendCandidate.mockResolvedValueOnce({ propertyId, shortId: 999_001, alreadyPublished: false });
    resolveTelegramFileMaterialization.mockResolvedValueOnce(null);

    await handleTelegramUpdate({
      update_id: nextUpdateId++,
      message: {
        chat: { id: AGENT_CHAT_ID },
        document: { file_id: "doc-broken", mime_type: "video/mp4", file_name: "исправленный.mp4" },
      },
    });

    expect(reopenForResend).toHaveBeenCalledWith(propertyId);
    // Второй аргумент (задание F, 24.09.2026) — метка, которую вернул
    // reopenForResend (здесь замокан значением true), undoReopenForResend
    // сверяет её перед откатом, чтобы не задеть чужую передачу.
    expect(undoReopenForResend).toHaveBeenCalledWith(propertyId, true);
    expect(receiveEditedVideo).not.toHaveBeenCalled();
    expect(receiveEditedVideoFromFile).not.toHaveBeenCalled();
    expect(sendMessage).toHaveBeenCalledWith(String(AGENT_CHAT_ID), expect.stringContaining("Не получилось скачать файл"));
  });

  it("недавно принятый и УЖЕ опубликованный ролик — пересылка отклоняется без обращения к receiveEditedVideo", async () => {
    await linkAgentChat();
    findResendCandidate.mockResolvedValueOnce({ propertyId: "не важно-для-этого-теста", shortId: 999_002, alreadyPublished: true });

    await handleTelegramUpdate({
      update_id: nextUpdateId++,
      message: { chat: { id: AGENT_CHAT_ID }, video: { file_id: "vid-2" } },
    });

    expect(reopenForResend).not.toHaveBeenCalled();
    expect(receiveEditedVideo).not.toHaveBeenCalled();
    expect(sendMessage).toHaveBeenCalledWith(String(AGENT_CHAT_ID), expect.stringContaining("уже опубликован"));
  });

  it("обычный текст в привязанном чате — нейтральный ответ, не клиентская квалификация", async () => {
    await linkAgentChat();

    await textUpdate(AGENT_CHAT_ID, "привет");

    expect(callAiText).not.toHaveBeenCalled();
    expect(sendMessage).toHaveBeenCalledTimes(1);
  });

  /**
   * Обложка от монтажёра снята целиком (владелец, 21.09.2026: «обложки будем
   * мы с тобой генерировать, сделаем механизм скоро»). Фото от монтажёра
   * больше не скачивается и никуда не сохраняется — только понятный ответ,
   * не молчание и не отказ с руганью.
   */
  it("монтажёр присылает фото — обложка больше не принимается, понятный ответ, файл не скачивается", async () => {
    await linkAgentChat();

    await handleTelegramUpdate({
      update_id: nextUpdateId++,
      message: { chat: { id: AGENT_CHAT_ID }, photo: [{ file_id: "cover-1", width: 1080 }] },
    });

    expect(resolveTelegramFileMaterialization).not.toHaveBeenCalled();
    expect(sendMessage).toHaveBeenCalledWith(String(AGENT_CHAT_ID), expect.stringContaining("Обложки теперь делаем сами"));
  });

  /**
   * B1 (23.09.2026): .mov с айфона Telegram часто приходит документом БЕЗ
   * mime_type вовсе — до этой правки такой файл проваливался в текстовый
   * разбор (montajerTextReply) и ролик молча терялся.
   */
  it("документ .mov без mime_type — распознаётся как видео и уходит в приём", async () => {
    await linkAgentChat();
    const property = await prisma.property.create({
      data: {
        title: `mov без mime-${runId}`,
        type: "APARTMENT",
        areaSqm: 40,
        price: 200000,
        currency: "TJS",
        districtId,
        address: "Тестовая, 23",
        condition: "GOOD",
        videoHandoffStatus: "SENT_TO_EDITOR",
      },
    });
    propertyIds.push(property.id);

    await handleTelegramUpdate({
      update_id: nextUpdateId++,
      message: {
        chat: { id: AGENT_CHAT_ID },
        document: { file_id: "doc-mov", file_name: "IMG_0001.MOV" },
      },
    });

    expect(receiveEditedVideo).toHaveBeenCalledWith(property.id, expect.any(Buffer), "IMG_0001.MOV");
    expect(sendMessage).toHaveBeenCalledWith(String(AGENT_CHAT_ID), expect.stringContaining("принят, публикую"));
  });

  /** B1: кружок Telegram сжимает сам — просим переслать файлом, ничего не скачивая. */
  it("video_note (кружок) — явный ответ, receive не вызывается, файл не скачивается", async () => {
    await linkAgentChat();

    await handleTelegramUpdate({
      update_id: nextUpdateId++,
      message: { chat: { id: AGENT_CHAT_ID }, video_note: { file_id: "note-1" } },
    });

    expect(resolveTelegramFileMaterialization).not.toHaveBeenCalled();
    expect(receiveEditedVideo).not.toHaveBeenCalled();
    expect(sendMessage).toHaveBeenCalledWith(String(AGENT_CHAT_ID), expect.stringContaining("Кружок не подходит"));
  });

  /** B1: голосовое/аудио/стикер/гиф — явный ответ про то, что пришло, а не статус очереди. */
  it("голосовое вместо ролика — понятный ответ, не статус очереди", async () => {
    await linkAgentChat();
    queueStatusForMontajer.mockClear();

    await handleTelegramUpdate({
      update_id: nextUpdateId++,
      message: { chat: { id: AGENT_CHAT_ID }, voice: { file_id: "voice-1" } },
    });

    expect(queueStatusForMontajer).not.toHaveBeenCalled();
    expect(sendMessage).toHaveBeenCalledWith(String(AGENT_CHAT_ID), expect.stringContaining("готовый ролик"));
  });

  /**
   * B2 (23.09.2026): альбом из 2+ файлов в чате монтажёра. До этой правки
   * вторая часть либо молча подменяла только что принятый ролик, либо
   * терялась с «Не вижу объекта…» — исход зависел от гонки.
   */
  it("альбом из двух файлов — берётся только первый, вторая часть не скачивается и не переоткрывает объект", async () => {
    await linkAgentChat();
    const property = await prisma.property.create({
      data: {
        title: `Альбом-${runId}`,
        type: "APARTMENT",
        areaSqm: 40,
        price: 200000,
        currency: "TJS",
        districtId,
        address: "Тестовая, 24",
        condition: "GOOD",
        videoHandoffStatus: "SENT_TO_EDITOR",
      },
    });
    propertyIds.push(property.id);
    const groupId = `album-${runId}`;

    await handleTelegramUpdate({
      update_id: nextUpdateId++,
      message: {
        chat: { id: AGENT_CHAT_ID },
        media_group_id: groupId,
        document: { file_id: "doc-album-1", mime_type: "video/mp4", file_name: "первый.mp4" },
      },
    });
    expect(receiveEditedVideo).toHaveBeenCalledTimes(1);
    expect(receiveEditedVideo).toHaveBeenCalledWith(property.id, expect.any(Buffer), "первый.mp4");

    resolveTelegramFileMaterialization.mockClear();
    findResendCandidate.mockClear();
    sendMessage.mockClear();

    await handleTelegramUpdate({
      update_id: nextUpdateId++,
      message: {
        chat: { id: AGENT_CHAT_ID },
        media_group_id: groupId,
        document: { file_id: "doc-album-2", mime_type: "video/mp4", file_name: "второй.mp4" },
      },
    });

    expect(resolveTelegramFileMaterialization).not.toHaveBeenCalled();
    expect(findResendCandidate).not.toHaveBeenCalled();
    expect(receiveEditedVideo).toHaveBeenCalledTimes(1); // всё ещё один раз — вторая часть не принята
    expect(sendMessage).toHaveBeenCalledWith(String(AGENT_CHAT_ID), expect.stringContaining("взят только первый файл"));

    // Третья часть той же группы — ответ уже отправлен, второй раз не шлём.
    sendMessage.mockClear();
    await handleTelegramUpdate({
      update_id: nextUpdateId++,
      message: {
        chat: { id: AGENT_CHAT_ID },
        media_group_id: groupId,
        document: { file_id: "doc-album-3", mime_type: "video/mp4", file_name: "третий.mp4" },
      },
    });
    expect(sendMessage).not.toHaveBeenCalled();
  });
});

/**
 * ФАЙЛ С НОМЕРОМ ОБЪЕКТА (24.09.2026, проверка готового ролика по классам).
 * Место монтажёра освобождается в момент приёма, и следующий объект уходит ему
 * через секунды. Исправленный или поздний файл прежнего объекта ложился на
 * нового держателя места и публиковался под чужим объявлением. Теперь номер в
 * имени файла (или в начале подписи) решает, чей это ролик.
 */
describe("Файл монтажёра с номером объекта", () => {
  async function linkAgentChat() {
    const { code } = await createTelegramLinkCode(agentId);
    await textUpdate(AGENT_CHAT_ID, `/start ${code}`);
    sendMessage.mockClear();
    reopenForResend.mockClear();
  }

  async function makeObject(label: string, data: Record<string, unknown>) {
    const property = await prisma.property.create({
      data: {
        title: `${label}-${runId}`,
        type: "APARTMENT",
        areaSqm: 40,
        price: 200000,
        currency: "TJS",
        districtId,
        address: "Тестовая, 25",
        condition: "GOOD",
        ...data,
      },
    });
    propertyIds.push(property.id);
    return property;
  }

  /** Держатель места монтажёра — с самой ранней отправкой, чтобы бот нашёл
   *  именно его, а не держателя из соседнего теста в общей базе. */
  function makeHolder() {
    return makeObject("Держит место", { videoHandoffStatus: "SENT_TO_EDITOR", videoHandoffSentAt: new Date(0) });
  }

  function sendFile(fileName: string, caption?: string) {
    return handleTelegramUpdate({
      update_id: nextUpdateId++,
      message: {
        chat: { id: AGENT_CHAT_ID },
        document: { file_id: `doc-${fileName}`, mime_type: "video/mp4", file_name: fileName },
        ...(caption ? { caption } : {}),
      },
    });
  }

  it("поздний файл с номером прежнего объекта не уходит на нового держателя места", async () => {
    await linkAgentChat();
    const holder = await makeHolder();
    const earlier = await makeObject("Сдан минуту назад", { videoHandoffStatus: "RECEIVED", videoHandoffSentAt: new Date() });

    await sendFile(`${earlier.shortId}.mp4`);

    expect(reopenForResend).toHaveBeenCalledWith(earlier.id, { besideHolder: true });
    expect(receiveEditedVideo).toHaveBeenCalledWith(earlier.id, expect.any(Buffer), `${earlier.shortId}.mp4`);
    expect(receiveEditedVideo).not.toHaveBeenCalledWith(holder.id, expect.anything(), expect.anything());
    expect(sendMessage).toHaveBeenCalledWith(String(AGENT_CHAT_ID), expect.stringContaining(`№${earlier.shortId}`));
  });

  it("номер объекта, который ролик не ждёт, — файл не принят ни на него, ни на держателя места", async () => {
    await linkAgentChat();
    const holder = await makeHolder();
    const other = await makeObject("Не на монтаже", { videoHandoffStatus: "NONE" });

    await sendFile(`${other.shortId}_финал.mp4`);

    expect(receiveEditedVideo).not.toHaveBeenCalled();
    expect(reopenForResend).not.toHaveBeenCalled();
    // С 25.09.2026 отказ идёт с кнопкой «Это №<держатель>» — вдруг опечатка в имени.
    expect(sendMessageWithButtons).toHaveBeenCalledWith(
      String(AGENT_CHAT_ID),
      expect.stringContaining(`Сейчас у вас в работе №${holder.shortId}`),
      [[expect.objectContaining({ text: `Это №${holder.shortId}` })]]
    );
  });

  it("номер уже опубликованного объекта — отказ, на держателя места не кладётся", async () => {
    await linkAgentChat();
    await makeHolder();
    const published = await makeObject("Уже вышел", {
      videoHandoffStatus: "RECEIVED",
      videoHandoffSentAt: new Date(),
      publishedChannels: ["INSTAGRAM"],
    });

    await sendFile(`${published.shortId}.mp4`);

    expect(receiveEditedVideo).not.toHaveBeenCalled();
    expect(sendMessage).toHaveBeenCalledWith(String(AGENT_CHAT_ID), expect.stringContaining("уже опубликован"));
  });

  it("номер держателя места (как бот и выдал исходник: «N_1из2») — обычный приём", async () => {
    await linkAgentChat();
    const holder = await makeHolder();

    await sendFile(`${holder.shortId}_1из2.mp4`);

    expect(reopenForResend).not.toHaveBeenCalled();
    expect(receiveEditedVideo).toHaveBeenCalledWith(holder.id, expect.any(Buffer), `${holder.shortId}_1из2.mp4`);
  });

  it("номера в имени нет — берётся из подписи", async () => {
    await linkAgentChat();
    await makeHolder();
    const other = await makeObject("Подпись с номером", { videoHandoffStatus: "NONE" });

    await sendFile("IMG_4521.MOV", `объект ${other.shortId}`);

    expect(receiveEditedVideo).not.toHaveBeenCalled();
    expect(sendMessageWithButtons).toHaveBeenCalledWith(String(AGENT_CHAT_ID), expect.stringContaining(`№${other.shortId}`), expect.any(Array));
  });
});

/**
 * МЕНЮ МОНТАЖЁРА (владелец 19.09.2026, после перемешанных описаний двух квартир
 * одного продавца: «чтобы там было управление и все нужные функции»).
 *
 * Главное в меню — «объект <номер>». До починки на любой текст монтажёра бот
 * отвечал ТОЛЬКО статусом очереди, и на живой вопрос «отправь информацию
 * ролика» ответил «сейчас монтаж ничего не ждёт»: данные объекта прочитать было
 * негде, и они были восстановлены по памяти — по предыдущей квартире.
 */
describe("Меню монтажёра в личном чате", () => {
  beforeEach(async () => {
    // Привязка чата сбрасывается перед каждым тестом (см. общий beforeEach) —
    // меню живёт только в привязанном чате назначенного монтажёра.
    const { code } = await createTelegramLinkCode(agentId);
    await textUpdate(AGENT_CHAT_ID, `/start ${code}`);
    await prisma.settings.update({ where: { id: "singleton" }, data: { videoMontajerAgentId: agentId } });
    sendMessage.mockClear();
    queueStatusForMontajer.mockClear();
  });

  it("монтажёр пишет номер объекта — приходит карточка, а не статус очереди", async () => {
    await textUpdate(AGENT_CHAT_ID, "108");

    expect(montajerCardText).toHaveBeenCalledWith(108);
    // Карточка приходит с кнопками (фото, исходники, где вышел), если объект №108
    // есть в базе, и простым текстом — если нет: в общей базе бывает и так и так.
    const replies = [...sendMessage.mock.calls, ...sendMessageWithButtons.mock.calls].map((c) => c[1]);
    expect(replies.some((t) => String(t).includes("Объект №108"))).toBe(true);
    expect(queueStatusForMontajer).not.toHaveBeenCalled();
  });

  it("«объект №112» — тот же ответ: номер узнаётся и словом тоже", async () => {
    await textUpdate(AGENT_CHAT_ID, "объект №112");

    expect(montajerCardText).toHaveBeenCalledWith(112);
  });

  it("«меню» — короткий список с кнопками", async () => {
    await textUpdate(AGENT_CHAT_ID, "меню");

    expect(sendMessageWithButtons).toHaveBeenCalledTimes(1);
    const [, text, buttons] = sendMessageWithButtons.mock.calls[0];
    expect(text).toContain("объект 108");
    expect(JSON.stringify(buttons)).toContain("mj:card");
  });

  it("«файлы» — исходники объекта в работе уходят заново", async () => {
    await textUpdate(AGENT_CHAT_ID, "файлы");

    expect(resendSourceVideos).toHaveBeenCalledTimes(1);
    expect(sendMessage.mock.calls.at(-1)?.[1]).toContain("№108");
  });

  it("«повтор» и «файл» — тоже точная команда, срабатывают как «файлы»", async () => {
    await textUpdate(AGENT_CHAT_ID, "повтор");
    await textUpdate(AGENT_CHAT_ID, "файл");

    expect(resendSourceVideos).toHaveBeenCalledTimes(2);
  });

  /**
   * 24.09.2026: до этой правки `/^\s*(файл|исходник|пришл|повтор|отправ)/i`
   * ловило НАЧАЛО слова — «пришлю вечером» (обычная реплика в диалоге о том,
   * когда будет готов ролик) запускало пересылку ВСЕХ исходников объекта
   * монтажёру, гигабайты в Telegram на обычную фразу. Теперь команда — точное
   * совпадение одного из трёх слов, а не префикс.
   */
  it("«пришлю вечером» — обычный ответ, повтор исходников НЕ запускается", async () => {
    await textUpdate(AGENT_CHAT_ID, "пришлю вечером");

    expect(resendSourceVideos).not.toHaveBeenCalled();
    expect(queueStatusForMontajer).toHaveBeenCalled();
  });

  it("«отправил?» и «файл не открывается» — тоже не команда, а обычный текст", async () => {
    await textUpdate(AGENT_CHAT_ID, "отправил?");
    await textUpdate(AGENT_CHAT_ID, "файл не открывается");

    expect(resendSourceVideos).not.toHaveBeenCalled();
  });

  it("непонятный текст — статус очереди и подсказка про меню, как и раньше", async () => {
    await textUpdate(AGENT_CHAT_ID, "добрый день");

    expect(queueStatusForMontajer).toHaveBeenCalled();
    expect(sendMessage.mock.calls.at(-1)?.[1]).toContain("меню");
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
