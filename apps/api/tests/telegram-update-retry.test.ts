import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import request from "supertest";
import type { TelegramUpdate } from "../src/telegram/api.js";

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

const isDuplicateDelivery = vi.hoisted(() => vi.fn(async (_channel: string, _id: string) => false));
const releaseProcessedMessage = vi.hoisted(() => vi.fn(async () => undefined));
vi.mock("../src/lib/webhookDedupe.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/lib/webhookDedupe.js")>()),
  isDuplicateDelivery,
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
  telegramRepliesInFlight: () => 0,
}));

const updatesQueue: Array<() => Promise<unknown[]>> = [];
const getUpdates = vi.hoisted(() => vi.fn());
vi.mock("../src/telegram/api.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/telegram/api.js")>()),
  isTelegramEnabled: () => true,
  getUpdates,
}));

function pollingMessage(update_id: number, chatId: number, mediaGroup?: string): TelegramUpdate {
  return {
    update_id,
    message: { message_id: update_id, chat: { id: chatId, type: "private" }, text: "салом", media_group_id: mediaGroup },
  };
}
beforeAll(() => {
  process.env.TELEGRAM_WEBHOOK_SECRET = SECRET;
});

describe("JOB-06: polling не отдаёт Telegram апдейт, который не удалось принять", () => {
  beforeEach(() => {
    logSystemError.mockClear();
    releaseProcessedMessage.mockClear();
    startTelegramUpdate.mockReset();
    isDuplicateDelivery.mockReset().mockResolvedValue(false);
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

  it("при сбое дедупликации повторно получает непринятый апдейт, сохраняя порядок", async () => {
    const { startTelegramBot, stopTelegramBot } = await import("../src/telegram/poller.js");
    const updates = [100, 101, 102, 103].map(update_id => ({
      update_id, message: { message_id: update_id, date: 0, chat: { id: 8, type: "private" }, text: "салом" },
    }));
    getUpdates.mockImplementation(async (offset: number) => {
      const batch = updates.filter(update => update.update_id >= offset);
      if (!batch.length) stopTelegramBot();
      return batch;
    });
    isDuplicateDelivery.mockResolvedValueOnce(false).mockResolvedValueOnce(true)
      .mockRejectedValueOnce(new Error("чтение дубликата оборвалось"));
    startTelegramUpdate.mockResolvedValue({ reply: Promise.resolve() });

    delete process.env.TELEGRAM_WEBHOOK_SECRET;
    startTelegramBot();
    process.env.TELEGRAM_WEBHOOK_SECRET = SECRET;
    await vi.advanceTimersByTimeAsync(4_999);

    expect(getUpdates.mock.calls.map(call => call[0])).toEqual([0]);
    expect(startTelegramUpdate.mock.calls.map(([update]) => update.update_id)).toEqual([100]);
    await vi.advanceTimersByTimeAsync(1);

    expect(getUpdates.mock.calls.map(call => call[0])).toEqual([0, 102, 104]);
    expect(isDuplicateDelivery.mock.calls.map(([, id]) => id)).toEqual(["100", "101", "102", "102", "103"]);
    expect(startTelegramUpdate.mock.calls.map(([update]) => update.update_id)).toEqual([100, 102, 103]);
  });

  it("разбирает разные чаты параллельно, сохраняет порядок кнопки и дожидается пачки при остановке", async () => {
    const { startTelegramBot, stopTelegramBot, isTelegramPollerBusy } = await import("../src/telegram/poller.js");
    const { promise, resolve } = Promise.withResolvers<void>();
    const callback: TelegramUpdate = {
      update_id: 103,
      callback_query: { id: "fixture-button", from: { id: 7 }, message: { chat: { id: 7 }, message_id: 103 } },
    };
    const attempts = () => startTelegramUpdate.mock.calls.map(([update]) => update.update_id);
    let failed = false;
    startTelegramUpdate.mockImplementation(async (update: TelegramUpdate) => {
      if (update.update_id === 100) {
        if (!failed) {
          failed = true;
          throw new Error("временный сбой");
        }
        await promise;
      }
      return { reply: Promise.resolve() };
    });
    updatesQueue.push(async () => [pollingMessage(100, 7), pollingMessage(102, 8), callback]);
    delete process.env.TELEGRAM_WEBHOOK_SECRET;
    startTelegramBot();
    process.env.TELEGRAM_WEBHOOK_SECRET = SECRET;
    try {
      await vi.advanceTimersByTimeAsync(0);
      expect(attempts()).toEqual([100, 102]);
      await vi.advanceTimersByTimeAsync(2_000);
      expect(attempts()).toEqual([100, 102, 100]);
      expect(getUpdates.mock.calls.map(([offset]) => offset)).toEqual([0]);
      stopTelegramBot();
      expect(isTelegramPollerBusy()).toBe(true);
      delete process.env.TELEGRAM_WEBHOOK_SECRET;
      startTelegramBot();
      process.env.TELEGRAM_WEBHOOK_SECRET = SECRET;
    } finally {
      resolve();
      await vi.advanceTimersByTimeAsync(0);
    }
    expect(attempts()).toEqual([100, 102, 100, 103]);
    expect(isTelegramPollerBusy()).toBe(false);
    expect(getUpdates.mock.calls.map(([offset]) => offset)).toEqual([0]);
  });

  it("ограничивает параллельный приём четырьмя чатами и берёт следующий, как только освободится место", async () => {
    const { startTelegramBot, stopTelegramBot } = await import("../src/telegram/poller.js");
    const gates = Array.from({ length: 5 }, () => Promise.withResolvers<void>());
    const updates = gates.map((_, index) => pollingMessage(130 + index, 20 + index));
    const attempts = () => startTelegramUpdate.mock.calls.map(([update]) => update.update_id);
    startTelegramUpdate.mockImplementation(async (update: TelegramUpdate) => {
      await gates[update.update_id - 130].promise;
      return { reply: Promise.resolve() };
    });
    updatesQueue.push(async () => updates);
    delete process.env.TELEGRAM_WEBHOOK_SECRET;
    startTelegramBot();
    process.env.TELEGRAM_WEBHOOK_SECRET = SECRET;
    try {
      await vi.advanceTimersByTimeAsync(0);
      expect(attempts()).toEqual([130, 131, 132, 133]);
      gates[1].resolve();
      await vi.advanceTimersByTimeAsync(0);
      expect(attempts()).toEqual([130, 131, 132, 133, 134]);
    } finally {
      for (const gate of gates) gate.resolve();
      stopTelegramBot();
      await vi.advanceTimersByTimeAsync(0);
    }
  });
  it("не повторяет готовый ответ другого чата, пока восстанавливает непринятый префикс", async () => {
    const { startTelegramBot, stopTelegramBot } = await import("../src/telegram/poller.js");
    const updates = [
      pollingMessage(110, 7), pollingMessage(111, 7), pollingMessage(113, 8), pollingMessage(116, 7),
    ];
    const attempts = () => startTelegramUpdate.mock.calls.map(([update]) => update.update_id);
    let fail = true;
    isDuplicateDelivery.mockImplementation(async (_channel, id) => {
      if (id === "111" && fail) {
        fail = false;
        throw new Error("чтение отметки оборвалось");
      }
      return false;
    });
    startTelegramUpdate.mockResolvedValue({ reply: Promise.resolve() });
    getUpdates.mockImplementation(async (offset: number) => {
      const batch = updates.filter(update => update.update_id >= offset);
      if (!batch.length) stopTelegramBot();
      return batch;
    });
    delete process.env.TELEGRAM_WEBHOOK_SECRET;
    startTelegramBot();
    process.env.TELEGRAM_WEBHOOK_SECRET = SECRET;
    await vi.advanceTimersByTimeAsync(4_999);
    expect(attempts()).toEqual([110, 113]);
    expect(getUpdates.mock.calls.map(([offset]) => offset)).toEqual([0]);
    await vi.advanceTimersByTimeAsync(1);
    expect(attempts()).toEqual([110, 113, 111, 116]);
    expect(getUpdates.mock.calls.map(([offset]) => offset)).toEqual([0, 111, 117]);
    expect(isDuplicateDelivery.mock.calls.filter(([, id]) => id === "113")).toHaveLength(1);
  });

  it("сохраняет последовательную обработку границ с альбомом и кнопкой без чата", async () => {
    const { startTelegramBot, stopTelegramBot } = await import("../src/telegram/poller.js");
    const album = pollingMessage(121, 8, "fixture-album");
    const inline: TelegramUpdate = { update_id: 122, callback_query: { id: "inline", from: { id: 7 } } };
    const { promise, resolve } = Promise.withResolvers<void>();
    const attempts = () => startTelegramUpdate.mock.calls.map(([update]) => update.update_id);
    startTelegramUpdate.mockImplementation(async (update: TelegramUpdate) => {
      if (update.update_id === album.update_id) await promise;
      return { reply: Promise.resolve() };
    });
    updatesQueue.push(async () => [pollingMessage(120, 7), album, inline, pollingMessage(123, 9)]);
    delete process.env.TELEGRAM_WEBHOOK_SECRET;
    startTelegramBot();
    process.env.TELEGRAM_WEBHOOK_SECRET = SECRET;
    try {
      await vi.advanceTimersByTimeAsync(0);
      expect(attempts()).toEqual([120, 121]);
    } finally {
      resolve();
      await vi.advanceTimersByTimeAsync(0);
      stopTelegramBot();
    }
    expect(attempts()).toEqual([120, 121, 122, 123]);
    expect(isDuplicateDelivery.mock.calls.map(([, id]) => id)).toEqual(["120", "122", "123"]);
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
