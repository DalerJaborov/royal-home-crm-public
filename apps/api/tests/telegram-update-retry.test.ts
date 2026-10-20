import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import request from "supertest";

/**
 * JOB-06 (аудит Codex, 04.10.2026): сбой приёма апдейта Telegram терял сообщение клиента.
 * Polling: offset уходил вперёд ДО обработки, при исключении замок дубля снимался, но
 * Telegram апдейт уже считал подтверждённым. Вебхук: Telegram получал 200 до обработки,
 * и тот же сбой тоже выбрасывал апдейт. Теперь обе дороги повторяют приём ограниченное
 * число раз и только потом пишут в журнал и пропускают апдейт (ядовитый апдейт не
 * блокирует бота).
 */
const SECRET = "test-telegram-webhook-secret-retry";

const logSystemError = vi.hoisted(() => vi.fn(async () => undefined));
vi.mock("../src/lib/systemError.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/lib/systemError.js")>()),
  logSystemError,
}));

const releaseProcessedMessage = vi.hoisted(() => vi.fn(async () => undefined));
vi.mock("../src/lib/webhookDedupe.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/lib/webhookDedupe.js")>()),
  isDuplicateDelivery: vi.fn(async () => false),
  markProcessedMessageComplete: vi.fn(async () => undefined),
  releaseProcessedMessage,
  resetIncompleteProcessedMessages: vi.fn(async () => 0),
}));

const startTelegramUpdate = vi.hoisted(() => vi.fn());
const handleTelegramUpdate = vi.hoisted(() => vi.fn());
vi.mock("../src/telegram/bot.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/telegram/bot.js")>()),
  startTelegramUpdate,
  handleTelegramUpdate,
  isAlbumPart: () => false,
  telegramRepliesInFlight: () => 0,
}));

const updatesQueue: Array<() => Promise<unknown[]>> = [];
const getUpdates = vi.hoisted(() => vi.fn());
vi.mock("../src/telegram/api.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/telegram/api.js")>()),
  isTelegramEnabled: () => true,
  getUpdates,
}));

beforeAll(() => {
  process.env.TELEGRAM_WEBHOOK_SECRET = SECRET;
});

describe("JOB-06: polling не отдаёт Telegram апдейт, который не удалось принять", () => {
  beforeEach(() => {
    logSystemError.mockClear();
    releaseProcessedMessage.mockClear();
    startTelegramUpdate.mockReset();
    getUpdates.mockReset();
    updatesQueue.length = 0;
    // По умолчанию пустой опрос через секунду, как long polling: мгновенный ответ крутил бы
    // цикл микрозадачами без единого таймера и съел бы всю память.
    getUpdates.mockImplementation(() => {
      const next = updatesQueue.shift();
      return next ? next() : new Promise((resolve) => setTimeout(() => resolve([]), 1_000));
    });
    vi.spyOn(console, "error").mockImplementation(() => {});
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.useFakeTimers();
  });

  afterEach(async () => {
    const { stopTelegramBot } = await import("../src/telegram/poller.js");
    stopTelegramBot();
    await vi.advanceTimersByTimeAsync(60_000);
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("разовый сбой приёма: апдейт принят со второй попытки, в журнал и в снятие замка не попадает", async () => {
    delete process.env.TELEGRAM_WEBHOOK_SECRET;
    const { startTelegramBot } = await import("../src/telegram/poller.js");
    startTelegramBot();
    process.env.TELEGRAM_WEBHOOK_SECRET = SECRET;
    startTelegramUpdate.mockRejectedValueOnce(new Error("база моргнула")).mockResolvedValue({ reply: Promise.resolve() });
    updatesQueue.push(() => Promise.resolve([{ update_id: 10, message: { message_id: 1, date: 0, chat: { id: 7, type: "private" }, text: "салом" } }]));

    await vi.advanceTimersByTimeAsync(30_000);

    expect(startTelegramUpdate).toHaveBeenCalledTimes(2);
    expect(logSystemError).not.toHaveBeenCalled();
    expect(releaseProcessedMessage).not.toHaveBeenCalled();
    // Подтверждение уходит в Telegram только после успешного приёма: следующий опрос с offset=11.
    expect(getUpdates.mock.calls.map((c) => c[0])).toContain(11);
  });

  it("ядовитый апдейт: ограниченное число попыток, потом запись в журнал и пропуск, бот не встаёт", async () => {
    delete process.env.TELEGRAM_WEBHOOK_SECRET;
    const { startTelegramBot } = await import("../src/telegram/poller.js");
    startTelegramBot();
    process.env.TELEGRAM_WEBHOOK_SECRET = SECRET;
    startTelegramUpdate.mockRejectedValue(new Error("всегда падает"));
    updatesQueue.push(() => Promise.resolve([{ update_id: 20, message: { message_id: 2, date: 0, chat: { id: 8, type: "private" }, text: "салом" } }]));

    await vi.advanceTimersByTimeAsync(60_000);

    expect(startTelegramUpdate).toHaveBeenCalledTimes(3);
    const messages = logSystemError.mock.calls.map((c) => String((c as unknown[])[1]));
    expect(messages.filter((m) => m.includes("Апдейт не обработан"))).toHaveLength(1);
    expect(releaseProcessedMessage).toHaveBeenCalledTimes(1);
    expect(getUpdates.mock.calls.map((c) => c[0])).toContain(21);
  });
});

describe("JOB-06: вебхук Telegram повторяет приём, а не выбрасывает апдейт", () => {
  beforeEach(() => {
    logSystemError.mockClear();
    releaseProcessedMessage.mockClear();
    handleTelegramUpdate.mockReset();
  });

  it("разовый сбой: апдейт обработан повторно, замок дубля не снят, ошибки в журнале нет", async () => {
    const { app } = await import("../src/app.js");
    const { drainBackgroundTasks } = await import("../src/lib/shutdownState.js");
    const { telegramUpdateRetryPolicy } = await import("../src/telegram/updateRetry.js");
    const saved = [...telegramUpdateRetryPolicy.delaysMs];
    telegramUpdateRetryPolicy.delaysMs = [0, 0];
    try {
      handleTelegramUpdate.mockRejectedValueOnce(new Error("база моргнула")).mockResolvedValue(undefined);
      const res = await request(app)
        .post("/api/v1/webhooks/telegram")
        .set("x-telegram-bot-api-secret-token", SECRET)
        .send({ update_id: 990003003, message: { message_id: 1, date: 0, chat: { id: 9, type: "private" }, text: "салом" } });
      expect(res.status).toBe(200);
      await drainBackgroundTasks(5_000);

      expect(handleTelegramUpdate).toHaveBeenCalledTimes(2);
      expect(releaseProcessedMessage).not.toHaveBeenCalled();
      expect(logSystemError).not.toHaveBeenCalled();
    } finally {
      telegramUpdateRetryPolicy.delaysMs = saved;
    }
  });

  it("устойчивый сбой: после лимита попыток запись в журнал и снятие замка дубля", async () => {
    const { app } = await import("../src/app.js");
    const { drainBackgroundTasks } = await import("../src/lib/shutdownState.js");
    const { telegramUpdateRetryPolicy } = await import("../src/telegram/updateRetry.js");
    const saved = [...telegramUpdateRetryPolicy.delaysMs];
    telegramUpdateRetryPolicy.delaysMs = [0, 0];
    try {
      handleTelegramUpdate.mockRejectedValue(new Error("всегда падает"));
      await request(app)
        .post("/api/v1/webhooks/telegram")
        .set("x-telegram-bot-api-secret-token", SECRET)
        .send({ update_id: 990003004, message: { message_id: 2, date: 0, chat: { id: 10, type: "private" }, text: "салом" } });
      await drainBackgroundTasks(5_000);

      expect(handleTelegramUpdate).toHaveBeenCalledTimes(3);
      const messages = logSystemError.mock.calls.map((c) => String((c as unknown[])[1]));
      expect(messages.filter((m) => m.includes("Апдейт не обработан (вебхук)"))).toHaveLength(1);
      expect(releaseProcessedMessage).toHaveBeenCalledTimes(1);
    } finally {
      telegramUpdateRetryPolicy.delaysMs = saved;
    }
  });
});
