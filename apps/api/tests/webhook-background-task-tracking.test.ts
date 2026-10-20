import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import request from "supertest";
import { prisma } from "../src/db.js";

/**
 * ФОНОВАЯ ОБРАБОТКА ПОСЛЕ res.json ДОЛЖНА БЫТЬ ВИДНА МЕХАНИЗМУ ОСТАНОВКИ (21.09.2026).
 *
 * Ночь 20→21.09: рестарт контейнера посреди работы оставил объект №114 «принят, но
 * не опубликован» — публикация шла ПОСЛЕ ответа вебхуку и не была зарегистрирована
 * ни в одном механизме мягкой остановки (lib/shutdownState.ts). Разведка нашла тот
 * же приём в /telegram и /meta (routes/webhooks.ts): `res.json({ ok: true })` уходит
 * до `await handleTelegramUpdate(update)` / разбора входящих Meta, а дальнейшая
 * работа ничем не отслеживалась — при рестарте она обрывалась на полуслове, и
 * терялось не событие публикации, а сама реплика клиента.
 *
 * Этот тест не проверяет бизнес-логику обработки апдейта (для этого есть другие
 * тесты бота) — только то, что промис продолжения зарегистрирован через
 * `trackBackgroundTask`, и `drainBackgroundTasks` (та же функция, которую index.ts
 * зовёт перед `prisma.$disconnect()` при SIGTERM) реально дожидается его, а не
 * возвращается мгновенно, будто фоновой работы не было вовсе.
 */

const SECRET = "test-telegram-webhook-secret";

let resolveHandled: (() => void) | null = null;

vi.mock("../src/telegram/bot.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/telegram/bot.js")>();
  return {
    ...actual,
    // Висит, пока тест сам не отпустит — так видно, что res.json ушёл раньше
    // завершения этой работы, а не то, что она успела кончиться сама.
    handleTelegramUpdate: vi.fn(
      () =>
        new Promise<void>((resolve) => {
          resolveHandled = resolve;
        })
    ),
  };
});

beforeAll(() => {
  process.env.TELEGRAM_WEBHOOK_SECRET = SECRET;
});

afterEach(async () => {
  resolveHandled?.();
  resolveHandled = null;
  await prisma.processedMessage.deleteMany({ where: { channel: "TELEGRAM", messageId: "990001001" } });
});

describe("POST /api/v1/webhooks/telegram — регистрация в реестре остановки", () => {
  it("отвечает немедленно, но drainBackgroundTasks дожидается работы, начатой после ответа", async () => {
    const { app } = await import("../src/app.js");
    const { drainBackgroundTasks } = await import("../src/lib/shutdownState.js");

    const res = await request(app)
      .post("/api/v1/webhooks/telegram")
      .set("x-telegram-bot-api-secret-token", SECRET)
      .send({
        update_id: 990001001,
        message: { message_id: 1, date: 0, chat: { id: 1, type: "private" }, text: "тест" },
      });

    // Ответ ушёл сразу — обработка (наш мок) в этот момент ещё висит.
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true });

    let drained = false;
    const drainPromise = drainBackgroundTasks(2_000).then(() => {
      drained = true;
    });

    // Даём event loop тик, чтобы drain успел подписаться, пока задача ещё висит.
    await new Promise((resolve) => setTimeout(resolve, 20));
    // Если бы продолжение не было зарегистрировано в trackBackgroundTask,
    // drainBackgroundTasks увидел бы пустой реестр и вернулся бы мгновенно —
    // именно это отличие тест и проверяет.
    expect(drained).toBe(false);

    resolveHandled?.();
    await drainPromise;
    expect(drained).toBe(true);
  });
});
