import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import request from "supertest";
import { prisma } from "../src/db.js";

/**
 * ИДЕМПОТЕНТНОСТЬ /website-chat — ЗАМОК ПРИВЯЗАН К ХОДУ, А НЕ К КОРОТКОМУ ОКНУ
 * (CLAUDE.md, пункт 4 разведки 22.09.2026).
 *
 * Ход бота в чате на сайте — фоновый: HTTP-ответ виджету уходит мгновенно, а сам
 * ход идёт после. До правки замок жил окном в 15 секунд НЕЗАВИСИМО от того, идёт
 * ли ход ещё: повтор позже окна, пока ход ещё выполнялся, запускал ВТОРОЙ
 * независимый ход, а падение хода не снимало замок вовсе (`isRepeatDelivery` не
 * знала ни `release`, ни `completedAt`) — честный ретрай в пределах окна молча
 * съедался.
 */

let turnCalls = 0;
let resolveTurn: (() => void) | null = null;
let rejectTurn: ((err: Error) => void) | null = null;

vi.mock("../src/messengers/websiteChat.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/messengers/websiteChat.js")>();
  return {
    ...actual,
    isWebsiteChatEnabled: vi.fn(async () => true),
    handleWebsiteChatTurn: vi.fn(
      () =>
        new Promise<void>((resolve, reject) => {
          turnCalls += 1;
          resolveTurn = resolve;
          rejectTurn = reject;
        })
    ),
  };
});

const runId = Date.now().toString(36);
const API_KEY = `test-chat-lock-${runId}`;

beforeAll(() => {
  process.env.WEBSITE_LEAD_API_KEY = API_KEY;
});

afterAll(async () => {
  delete process.env.WEBSITE_LEAD_API_KEY;
  // Замки доставки НЕ чистятся по всему каналу (28.09.2026): соседний файл,
  // идущий в другом процессе на той же базе, терял свой замок посреди теста и
  // писал реплику второй раз («expected 2 to be 1»). Ключи этого файла уникальны
  // (в sessionId есть runId), старые строки убирает плановая чистка (index.ts).
});

afterEach(() => {
  resolveTurn?.();
  resolveTurn = null;
  rejectTurn = null;
  turnCalls = 0;
});

describe("POST /website-chat — замок держится, пока идёт фоновый ход", () => {
  it("повтор, пока ход ещё выполняется, не запускает второй ход", async () => {
    const { app } = await import("../src/app.js");
    const { drainBackgroundTasks } = await import("../src/lib/shutdownState.js");

    const sessionId = `wchat-lock-a-${runId}-1234567890`;
    const body = { sessionId, text: "Здравствуйте, подскажите цену" };

    const first = await request(app).post("/api/v1/webhooks/website-chat").set("X-Api-Key", API_KEY).send(body);
    expect(first.status).toBe(200);
    expect(turnCalls).toBe(1);

    // Ход ещё висит (resolveTurn не звали). Честный повтор — сайт не дождался
    // ответа за таймаут и шлёт тот же вызов снова, пока ход ЕЩЁ ИДЁТ.
    const second = await request(app).post("/api/v1/webhooks/website-chat").set("X-Api-Key", API_KEY).send(body);
    expect(second.status).toBe(200);
    // Главная проверка: второй, независимый ход бота не запущен.
    expect(turnCalls).toBe(1);

    resolveTurn?.();
    await drainBackgroundTasks(2_000);
  });

  it("падение хода снимает замок — честный повтор проходит немедленно", async () => {
    const { app } = await import("../src/app.js");
    const { drainBackgroundTasks } = await import("../src/lib/shutdownState.js");

    const sessionId = `wchat-lock-b-${runId}-1234567890`;
    const body = { sessionId, text: "Есть трёхкомнатные?" };

    const first = await request(app).post("/api/v1/webhooks/website-chat").set("X-Api-Key", API_KEY).send(body);
    expect(first.status).toBe(200);
    expect(turnCalls).toBe(1);

    rejectTurn?.(new Error("ИИ недоступен (тест)"));
    await drainBackgroundTasks(2_000);

    // Ретрай сразу после падения — не должен ждать STALE_AFTER_MS (10 минут).
    const second = await request(app).post("/api/v1/webhooks/website-chat").set("X-Api-Key", API_KEY).send(body);
    expect(second.status).toBe(200);
    expect(turnCalls).toBe(2);

    resolveTurn?.();
    await drainBackgroundTasks(2_000);
  });
});
