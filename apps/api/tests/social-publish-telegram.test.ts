import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

// Дополнительные чаты Telegram (26.09.2026, describe ниже) идут через
// publishApprovedPost, а не только через publishTelegramVideo — она читает
// Settings.telegramExtraChatIds/telegramChannelId из настоящей БД (тот же
// приём, что social-publish-facebook-pending.test.ts), поэтому переменные
// окружения задаются здесь же, до импорта прикладного кода ниже.
process.env.CRM_PUBLIC_URL = process.env.CRM_PUBLIC_URL ?? "https://crm-test.royalhome.tj";
process.env.SETTINGS_ENCRYPTION_KEY =
  process.env.SETTINGS_ENCRYPTION_KEY ?? "7e58774a6ca3f8f094b302efc65290b09ba8d51dacebdb60e8e693452f1ab810";

/**
 * Кросспост в Telegram-канал (Фаза 1.5 docs/publishing-hub-plan-22-08-2026.md).
 *
 * ПЕРЕПИСАН 20.09.2026: было sendVideo(videoUrl) — Telegram сам качал ролик по
 * публичной ссылке, и на проде это почти всегда падало с `Bad Request: failed
 * to get HTTP URL content» (9 записей ErrorLog, из 8 объектов с публикациями
 * TELEGRAM дошёл только у одного). Ссылка рабочая (проверено вживую изнутри
 * контейнера telegram-bot-api: HTTP 200, верный Content-Length), поэтому вместо
 * дальнейшего разбора «почему падает загрузчик ссылок Bot API» отправка ушла на
 * sendVideoFile — видео и обложка телом запроса, тем же приёмом, что
 * sendDocumentFile у монтажёра (videoHandoff.ts).
 *
 * Настоящий Bot API здесь не дёргается — подменяем telegram/api.js, как это
 * делают остальные тесты внешних вызовов.
 *
 * ДОБАВЛЕНО 21.09.2026 (регрессия PR #586): sendVideoFile получил новый
 * аргумент dimensions (width/height/duration/supports_streaming), который
 * publishTelegramVideo теперь определяет через lib/ffmpeg.ts::probeVideoDimensions
 * ДО отправки — реального ffprobe здесь тоже нет, мокаем ffmpeg.js целиком
 * (тем же приёмом, что tiktok-video-transcode.test.ts).
 */

const sendVideoFileMock = vi.fn();
const isTelegramEnabledMock = vi.fn(() => true);
/** Предел ОТПРАВКИ своего Bot API сервера (2 ГБ на --local, было 50 МБ в
 *  облаке) — publishTelegramVideo теперь проверяет размер файла на диске этим
 *  пределом, а не пределом СКАЧИВАНИЯ по ссылке (тот был вдвое строже и вообще
 *  больше не участвует, ссылка не используется). */
let telegramSendLimitBytesMock = 2000 * 1024 * 1024;

vi.mock("../src/telegram/api.js", () => ({
  sendVideoFile: (...args: unknown[]) => sendVideoFileMock(...args),
  isTelegramEnabled: () => isTelegramEnabledMock(),
  get TELEGRAM_BOT_SEND_LIMIT_BYTES() {
    return telegramSendLimitBytesMock;
  },
}));

const probeVideoDimensionsMock = vi.fn();
const probeImageDimensionsMock = vi.fn();
vi.mock("../src/lib/ffmpeg.js", () => ({
  tryRunFfmpeg: vi.fn(),
  runFfmpeg: vi.fn(),
  probeVideoDimensions: (...args: unknown[]) => probeVideoDimensionsMock(...args),
  probeImageDimensions: (...args: unknown[]) => probeImageDimensionsMock(...args),
}));

const logSystemErrorMock = vi.fn().mockResolvedValue(undefined);
vi.mock("../src/lib/systemError.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/lib/systemError.js")>()),
  logSystemError: (...args: unknown[]) => logSystemErrorMock(...args),
}));

const { publishTelegramVideo, publishApprovedPost } = await import("../src/lib/socialPublish.js");
const { prisma } = await import("../src/db.js");
const { uploadsDir } = await import("../src/upload.js");

/** Реальный вертикальный Reels — то, что ffprobe отдал бы на живом ролике монтажёра. */
const REAL_DIMENSIONS = { width: 1080, height: 1920, durationSec: 14.7 };

/** Файл на диске нужного размера — тот же приём, что и в video-handoff.test.ts
 *  (truncate, разрежённый файл: реальное место на диске не расходуется, а
 *  fs.stat().size / fs.readFile честно отвечают заданным размером). */
async function makeSizedFile(sizeBytes: number, ext = "mp4"): Promise<string> {
  const filePath = path.join(os.tmpdir(), `social-publish-telegram-${Date.now()}-${Math.random().toString(36).slice(2)}.${ext}`);
  const handle = await fs.open(filePath, "w");
  await handle.truncate(Math.round(sizeBytes));
  await handle.close();
  return filePath;
}

const tempFiles: string[] = [];

beforeEach(() => {
  sendVideoFileMock.mockReset();
  isTelegramEnabledMock.mockReset();
  isTelegramEnabledMock.mockReturnValue(true);
  telegramSendLimitBytesMock = 2000 * 1024 * 1024;
  probeVideoDimensionsMock.mockReset();
  probeVideoDimensionsMock.mockResolvedValue(REAL_DIMENSIONS);
  probeImageDimensionsMock.mockReset();
  probeImageDimensionsMock.mockResolvedValue(null);
  logSystemErrorMock.mockClear();
});

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(tempFiles.splice(0).map((f) => fs.unlink(f).catch(() => {})));
});

describe("publishTelegramVideo", () => {
  it("шлёт видео в канал ТЕЛОМ запроса (не ссылкой) и возвращает номер сообщения", async () => {
    sendVideoFileMock.mockResolvedValue({ message_id: 4242 });
    const filePath = await makeSizedFile(1024);
    tempFiles.push(filePath);

    const result = await publishTelegramVideo("-1001234567890", filePath, "Подпись");

    expect(result).toEqual({ channel: "TELEGRAM", ok: true, postId: "4242" });
    // 1-й — чат канала, 2-й — файл ЛЕНИВЫМ Blob с диска (не URL-строка и не буфер:
    // ролик до 2 ГБ не читается в память целиком, аудит 23.09.2026 №80), 3-й — имя файла,
    // 4-й — подпись, 5-й — обложка (null, не передана), 6-й — явный таймаут
    // отправки (120с, TELEGRAM_VIDEO_TIMEOUT_MS), 7-й — width/height/duration
    // из ffprobe (регрессия PR #586).
    expect(sendVideoFileMock).toHaveBeenCalledTimes(1);
    const call = sendVideoFileMock.mock.calls[0];
    expect(call[0]).toBe("-1001234567890");
    expect(Buffer.isBuffer(call[1])).toBe(false);
    expect(call[1]).toBeInstanceOf(Blob);
    expect((call[1] as Blob).size).toBe(1024);
    expect(Buffer.from(await (call[1] as Blob).arrayBuffer()).equals(await fs.readFile(filePath))).toBe(true);
    expect(call[2]).toBe(path.basename(filePath));
    expect(call[3]).toBe("Подпись");
    expect(call[4]).toBeNull();
    expect(call[5]).toBe(120_000);
    expect(call[6]).toEqual({ width: 1080, height: 1920, duration: 14.7 });
    expect(logSystemErrorMock).not.toHaveBeenCalled();
  });

  /**
   * РЕГРЕССИЯ PR #586 (21.09.2026): владелец увидел квадратное, «будто сжали со
   * сторон» видео объекта ОБ-000113 в Telegram-канале — sendVideo телом запроса
   * не сообщал Telegram реальную геометрию ролика. probeVideoDimensions
   * (lib/ffmpeg.ts, ffprobe) теперь определяет width/height/duration ДО отправки,
   * и они уходят в sendVideoFile.
   */
  it("определяет width/height/duration через ffprobe и передаёт их в sendVideoFile", async () => {
    sendVideoFileMock.mockResolvedValue({ message_id: 7 });
    probeVideoDimensionsMock.mockResolvedValue({ width: 1080, height: 1920, durationSec: 22.3 });
    const filePath = await makeSizedFile(4096);
    tempFiles.push(filePath);

    await publishTelegramVideo("-100", filePath, "Подпись");

    expect(probeVideoDimensionsMock).toHaveBeenCalledWith(filePath);
    const call = sendVideoFileMock.mock.calls[0];
    expect(call[6]).toEqual({ width: 1080, height: 1920, duration: 22.3 });
  });

  /**
   * ffprobe недоступен/файл битый — probeVideoDimensions отдаёт null. Публикация
   * НЕ отменяется (задание: «молчать нельзя, но и не ронять канал»): ролик уходит
   * без width/height/duration, как было до фикса, а причина попадает в журнал
   * через logSystemError, а не тонет молча.
   */
  it("ffprobe не определил размеры — публикация всё равно уходит, без полей размеров, причина в журнале", async () => {
    sendVideoFileMock.mockResolvedValue({ message_id: 8 });
    probeVideoDimensionsMock.mockResolvedValue(null);
    const filePath = await makeSizedFile(4096);
    tempFiles.push(filePath);

    const result = await publishTelegramVideo("-100", filePath, "Подпись");

    expect(result.ok).toBe(true);
    const call = sendVideoFileMock.mock.calls[0];
    expect(call[6]).toBeNull();
    expect(logSystemErrorMock).toHaveBeenCalledTimes(1);
    expect(logSystemErrorMock.mock.calls[0][0]).toBe("telegram");
    expect(logSystemErrorMock.mock.calls[0][1]).toContain("width/height/duration");
  });

  /**
   * Обложка непропорциональна ролику (например, фото не той формы, присланное
   * монтажёром вручную) — публикация всё равно уходит, но причина попадает в
   * журнал, чтобы не искать вслепую следующее «странное превью».
   */
  it("обложка непропорциональна ролику — публикация уходит, несоответствие в журнале", async () => {
    sendVideoFileMock.mockResolvedValue({ message_id: 9 });
    probeVideoDimensionsMock.mockResolvedValue({ width: 1080, height: 1920, durationSec: 10 });
    probeImageDimensionsMock.mockResolvedValue({ width: 1920, height: 1080 }); // горизонтальная обложка на вертикальный ролик
    const videoPath = await makeSizedFile(2048);
    const coverPath = await makeSizedFile(512, "jpg");
    tempFiles.push(videoPath, coverPath);

    const result = await publishTelegramVideo("-100", videoPath, "Подпись", coverPath);

    expect(result.ok).toBe(true);
    expect(logSystemErrorMock).toHaveBeenCalledWith("telegram", expect.stringContaining("непропорциональна"));
  });

  it("передаёт обложку буфером байтов, когда файл есть (31.08.2026, lib/video/coverStill.ts)", async () => {
    sendVideoFileMock.mockResolvedValue({ message_id: 5 });
    const videoPath = await makeSizedFile(2048);
    const coverPath = await makeSizedFile(512, "jpg");
    tempFiles.push(videoPath, coverPath);

    await publishTelegramVideo("-100", videoPath, "Подпись", coverPath);

    const call = sendVideoFileMock.mock.calls[0];
    expect(call[4]).toEqual({ buffer: expect.any(Buffer), filename: path.basename(coverPath) });
  });

  /** Обложка необязательна: нет файла на диске (объект старый, сырьё убрано) —
   *  публикуем ролик без неё, публикация не срывается из-за одной картинки. */
  it("обложки нет на диске — публикация всё равно уходит, просто без обложки", async () => {
    sendVideoFileMock.mockResolvedValue({ message_id: 6 });
    const videoPath = await makeSizedFile(2048);
    tempFiles.push(videoPath);

    const result = await publishTelegramVideo("-100", videoPath, "Подпись", path.join(os.tmpdir(), "не-существует-совсем.jpg"));

    expect(result.ok).toBe(true);
    const call = sendVideoFileMock.mock.calls[0];
    expect(call[4]).toBeNull();
  });

  /**
   * Предел Telegram — 1024 символа на подпись, и при превышении он отклоняет
   * ЗАПРОС ЦЕЛИКОМ, а не обрезает сам. У Instagram предел 2200, и шаблоны Reels
   * рассчитаны на него — без обрезки длинный шаблон ронял бы весь кросспост.
   */
  it("длинную подпись обрезает до предела Telegram, а не роняет отправку", async () => {
    sendVideoFileMock.mockResolvedValue({ message_id: 1 });
    const filePath = await makeSizedFile(1024);
    tempFiles.push(filePath);
    const longCaption = "я".repeat(1500);

    const result = await publishTelegramVideo("-100", filePath, longCaption);

    expect(result.ok).toBe(true);
    const sentCaption = sendVideoFileMock.mock.calls[0][3] as string;
    expect(sentCaption).toHaveLength(1024);
  });

  it("токен бота не настроен — честная ошибка, а не молчаливый успех", async () => {
    isTelegramEnabledMock.mockReturnValue(false);

    const result = await publishTelegramVideo("-100", "/tmp/несуществующий.mp4", "Подпись");

    expect(result.ok).toBe(false);
    expect(result.error).toContain("TELEGRAM_BOT_TOKEN");
    expect(sendVideoFileMock).not.toHaveBeenCalled();
  });

  /** Отказ Telegram (бот не админ канала, канал удалён) не должен бросать
   *  исключение наружу: публикация в Instagram/Facebook уже могла пройти. */
  it("отказ Telegram возвращается ошибкой, а не исключением", async () => {
    sendVideoFileMock.mockRejectedValue(new Error("Telegram API sendVideo (файлом): CHAT_ADMIN_REQUIRED"));
    const filePath = await makeSizedFile(1024);
    tempFiles.push(filePath);

    const result = await publishTelegramVideo("-100", filePath, "Подпись");

    expect(result.ok).toBe(false);
    expect(result.channel).toBe("TELEGRAM");
    expect(result.error).toContain("CHAT_ADMIN_REQUIRED");
  });

  /**
   * Файла ролика нет на диске (объект старый, сырьё убрано, путь битый) — раньше
   * (ссылкой) это была бы ошибка Telegram где-то посередине скачивания; теперь,
   * когда мы сами читаем файл, это должен быть честный отказ ДО похода в API,
   * с записью в журнал — а не тихий пропуск канала.
   */
  it("файла ролика нет на диске — честный отказ и запись в журнал, а не попытка отправки", async () => {
    const result = await publishTelegramVideo("-100", path.join(os.tmpdir(), "нет-такого-файла-12345.mp4"), "Подпись");

    expect(result.ok).toBe(false);
    expect(result.channel).toBe("TELEGRAM");
    expect(result.error).toContain("не найден на диске");
    expect(sendVideoFileMock).not.toHaveBeenCalled();
  });

  /**
   * Найдено 19.09.2026 на проде: объект №105 не ушёл в Telegram-канал — файл
   * 36.2 МБ упирался в старый предел. Теперь предел — TELEGRAM_BOT_SEND_LIMIT_BYTES
   * (отправка на своём сервере, 2 ГБ), а не предел скачивания по ссылке.
   */
  it("свой Bot API сервер (лимит 2 ГБ на отправку) — ролик 36.2 МБ проходит", async () => {
    sendVideoFileMock.mockResolvedValue({ message_id: 105 });
    const filePath = await makeSizedFile(36.2 * 1024 * 1024);
    tempFiles.push(filePath);

    const result = await publishTelegramVideo("-100", filePath, "Подпись");

    expect(result).toEqual({ channel: "TELEGRAM", ok: true, postId: "105" });
    expect(sendVideoFileMock).toHaveBeenCalled();
  });

  it("файл крупнее предела отправки — честная ошибка с РЕАЛЬНЫМ порогом в тексте, не захардкоженной цифрой", async () => {
    telegramSendLimitBytesMock = 100 * 1024 * 1024; // условный маленький «лимит» для теста, не 2 ГБ
    const filePath = await makeSizedFile(150 * 1024 * 1024);
    tempFiles.push(filePath);

    const result = await publishTelegramVideo("-100", filePath, "Подпись");

    expect(result.ok).toBe(false);
    expect(result.error).toContain("150.0 МБ");
    expect(result.error).toContain("100 МБ");
    expect(sendVideoFileMock).not.toHaveBeenCalled();
  });
});

/**
 * ДОПОЛНИТЕЛЬНЫЕ ЧАТЫ TELEGRAM (26.09.2026, «ролик уходит в несколько
 * Telegram-групп и каналов, а не в один») — через publishApprovedPost, не
 * publishTelegramVideo напрямую: сама сборка PublishResult, запись
 * publishedPostIds.TELEGRAM_EXTRA и журнал отказов по чату живут в
 * publishApprovedPost (socialPublish.ts), а не в publishTelegramVideo.
 *
 * НУЖНА НАСТОЯЩАЯ БАЗА (district/property/settings, как в
 * social-publish-facebook-pending.test.ts) — при точечном прогоне без неё
 * этот describe падает на подключении, не на логике; см. отчёт задания.
 */
describe("publishApprovedPost — дополнительные чаты Telegram", () => {
  const runId = Date.now();
  const CAPTION = `Подпись объекта ${runId}`;
  const VIDEO_PUBLIC_PATH = `/uploads/handoff/tg-extra-${runId}.mp4`;
  const videoDiskPath = path.join(uploadsDir, VIDEO_PUBLIC_PATH.slice("/uploads/".length));

  let districtId: string;
  let propertyId: string;
  let savedSettings: Record<string, unknown>;

  async function postIds(): Promise<Record<string, unknown>> {
    const p = await prisma.property.findUniqueOrThrow({ where: { id: propertyId }, select: { publishedPostIds: true } });
    return (p.publishedPostIds ?? {}) as Record<string, unknown>;
  }

  beforeAll(async () => {
    districtId = (await prisma.district.create({ data: { name: `Тест-район-tg-extra-${runId}` } })).id;
    propertyId = (
      await prisma.property.create({
        data: {
          title: `Объект TG extra ${runId}`,
          type: "APARTMENT",
          areaSqm: 50,
          price: 40000,
          currency: "TJS",
          districtId,
          address: "Тестовая, 1",
          condition: "GOOD",
        },
      })
    ).id;
    await fs.mkdir(path.dirname(videoDiskPath), { recursive: true });
    await fs.writeFile(videoDiskPath, "fake mp4 bytes");

    const current = await prisma.settings.upsert({ where: { id: "singleton" }, update: {}, create: { id: "singleton" } });
    savedSettings = {
      metaIgToken: current.metaIgToken,
      metaPageToken: current.metaPageToken,
      metaPageId: current.metaPageId,
      telegramChannelId: current.telegramChannelId,
      telegramExtraChatIds: current.telegramExtraChatIds,
      youtubeRefreshToken: current.youtubeRefreshToken,
      tiktokRefreshToken: current.tiktokRefreshToken,
    };
    // Только Telegram — остальные каналы молча пропускаются (нет ключей).
    await prisma.settings.update({
      where: { id: "singleton" },
      data: { metaIgToken: null, metaPageToken: null, metaPageId: null, youtubeRefreshToken: null, tiktokRefreshToken: null },
    });
  });

  afterAll(async () => {
    await prisma.settings.update({ where: { id: "singleton" }, data: savedSettings });
    await prisma.property.deleteMany({ where: { id: propertyId } });
    await prisma.district.deleteMany({ where: { id: districtId } });
    await fs.rm(videoDiskPath, { force: true });
    await prisma.$disconnect();
  });

  beforeEach(async () => {
    await prisma.property.update({ where: { id: propertyId }, data: { publishedChannels: [], publishedPostIds: {} } });
    sendVideoFileMock.mockReset();
    isTelegramEnabledMock.mockReset();
    isTelegramEnabledMock.mockReturnValue(true);
    probeVideoDimensionsMock.mockReset();
    probeVideoDimensionsMock.mockResolvedValue(REAL_DIMENSIONS);
    probeImageDimensionsMock.mockReset();
    probeImageDimensionsMock.mockResolvedValue(null);
    logSystemErrorMock.mockClear();
  });

  it("основной канал + два дополнительных чата — три отправки, TELEGRAM_EXTRA записан по обоим", async () => {
    await prisma.settings.update({
      where: { id: "singleton" },
      data: { telegramChannelId: "-1009990000", telegramExtraChatIds: "-1009990001, -1009990002" },
    });
    let seq = 100;
    sendVideoFileMock.mockImplementation(async () => ({ message_id: ++seq }));

    const results = await publishApprovedPost({ propertyId, localVideoPath: VIDEO_PUBLIC_PATH, caption: CAPTION });

    const tg = results.find((r) => r.channel === "TELEGRAM");
    expect(tg?.ok).toBe(true);
    expect(tg?.note).toContain("ещё в 2 чатов");
    expect(sendVideoFileMock).toHaveBeenCalledTimes(3);
    expect(sendVideoFileMock.mock.calls.map((c) => c[0])).toEqual(["-1009990000", "-1009990001", "-1009990002"]);

    // Порядок вызовов — основной канал первым (seq→101, его postId), затем
    // дополнительные чаты по порядку списка (seq→102, 103).
    expect(tg?.postId).toBe("101");
    const ids = await postIds();
    expect(ids.TELEGRAM_EXTRA).toEqual({ "-1009990001": "102", "-1009990002": "103" });
  });

  it("отказ одного дополнительного чата не мешает второму и не портит основной канал", async () => {
    await prisma.settings.update({
      where: { id: "singleton" },
      data: { telegramChannelId: "-1009990000", telegramExtraChatIds: "-1009990001, -1009990002" },
    });
    sendVideoFileMock.mockImplementation(async (chatId: string) => {
      if (chatId === "-1009990001") throw new Error("Telegram API: CHAT_ADMIN_REQUIRED");
      return { message_id: chatId === "-1009990000" ? 200 : 201 };
    });

    const results = await publishApprovedPost({ propertyId, localVideoPath: VIDEO_PUBLIC_PATH, caption: CAPTION });

    const tg = results.find((r) => r.channel === "TELEGRAM");
    // Основной канал прошёл — отказ дополнительного чата не отказ канала.
    expect(tg?.ok).toBe(true);
    expect(tg?.postId).toBe("200");
    expect(tg?.note).toContain("ещё в 1 чатов");
    expect(tg?.note).toContain("отказов 1");
    // Один провалившийся чат — одна запись в журнал, а не падение всего задания.
    expect(logSystemErrorMock).toHaveBeenCalledWith(
      "telegram",
      expect.stringContaining("Публикация в дополнительный чат Telegram -1009990001")
    );
    const ids = await postIds();
    expect(ids.TELEGRAM_EXTRA).toEqual({ "-1009990002": "201" });
  });

  it("основной канал не настроен, но дополнительные есть — публикуется в них, TELEGRAM в publishedChannels, postId основного пуст", async () => {
    await prisma.settings.update({
      where: { id: "singleton" },
      data: { telegramChannelId: null, telegramExtraChatIds: "-1009990001" },
    });
    sendVideoFileMock.mockResolvedValue({ message_id: 300 });

    const results = await publishApprovedPost({ propertyId, localVideoPath: VIDEO_PUBLIC_PATH, caption: CAPTION });

    const tg = results.find((r) => r.channel === "TELEGRAM");
    // ok:true — ЭТО caller (videoHandoff.ts::publishHandoffResult) заносит
    // канал в publishedChannels (nextPublishedChannels), publishApprovedPost
    // сама пишет в БД только TELEGRAM_EXTRA (см. ниже) — та же граница
    // ответственности, что у остальных каналов в этом файле.
    expect(tg?.ok).toBe(true);
    expect(tg?.postId).toBeUndefined();
    expect(sendVideoFileMock).toHaveBeenCalledTimes(1);
    expect(sendVideoFileMock.mock.calls[0][0]).toBe("-1009990001");

    const ids = await postIds();
    expect(ids.TELEGRAM).toBeUndefined();
    expect(ids.TELEGRAM_EXTRA).toEqual({ "-1009990001": "300" });
  });

  it("дополнительный чат, совпадающий с основным каналом, не дублируется", async () => {
    await prisma.settings.update({
      where: { id: "singleton" },
      data: { telegramChannelId: "-1009990000", telegramExtraChatIds: "-1009990000, -1009990001" },
    });
    sendVideoFileMock.mockImplementation(async () => ({ message_id: 400 }));

    await publishApprovedPost({ propertyId, localVideoPath: VIDEO_PUBLIC_PATH, caption: CAPTION });

    // Основной канал сам, плюс РОВНО ОДИН дополнительный (второй — дубль основного, исключён parseTelegramChatIds).
    expect(sendVideoFileMock).toHaveBeenCalledTimes(2);
    expect(sendVideoFileMock.mock.calls.map((c) => c[0])).toEqual(["-1009990000", "-1009990001"]);
  });
});
