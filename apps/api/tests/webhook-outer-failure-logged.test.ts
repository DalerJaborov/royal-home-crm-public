import { beforeAll, describe, expect, it, vi } from "vitest";
import request from "supertest";

/**
 * Аудит 23.09.2026, круг 3, №84: ошибка в фоновой обработке вебхука ВНЕ
 * внутреннего try (например, база не ответила на проверку повторной доставки)
 * пропадала без следа — trackBackgroundTask гасит отказ промиса, и ни журнал
 * ошибок, ни unhandledRejection о потерянном сообщении клиента не узнавали.
 */
const SECRET = "test-telegram-webhook-secret-outer";

const logSystemError = vi.hoisted(() => vi.fn(async () => undefined));
vi.mock("../src/lib/systemError.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/lib/systemError.js")>()),
  logSystemError,
}));
vi.mock("../src/lib/webhookDedupe.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/lib/webhookDedupe.js")>()),
  isDuplicateDelivery: vi.fn(async () => {
    throw new Error("timeout exceeded when trying to connect");
  }),
}));

beforeAll(() => {
  process.env.TELEGRAM_WEBHOOK_SECRET = SECRET;
});

describe("сбой вне внутреннего try в вебхуке попадает в журнал", () => {
  it("Telegram: отказ проверки повтора записан, а не проглочен", async () => {
    const { app } = await import("../src/app.js");
    const { drainBackgroundTasks } = await import("../src/lib/shutdownState.js");
    const res = await request(app)
      .post("/api/v1/webhooks/telegram")
      .set("x-telegram-bot-api-secret-token", SECRET)
      .send({ update_id: 990002002, message: { message_id: 1, date: 0, chat: { id: 7, type: "private" }, text: "тест" } });
    expect(res.status).toBe(200);
    await drainBackgroundTasks(2_000);
    const messages = logSystemError.mock.calls.map((c) => String((c as unknown[])[1]));
    expect(messages.some((m) => m.includes("Вебхук Telegram: обработка оборвалась") && m.includes("timeout exceeded"))).toBe(true);
  });
});
