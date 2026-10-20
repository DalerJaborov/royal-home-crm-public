/**
 * Кэш профилей Instagram в messengers/meta.ts.
 *
 * Проверяет три вещи:
 *   1. Успешный ответ Graph API НЕ кэшируется: is_user_follow_business — живой
 *      признак подписки, по нему воронка лид-магнита решает, отдавать ли файл.
 *   2. HTTP 400 + error_subcode 33 («Object does not exist») кэшируется как {}
 *      на 24 часа; logSystemError вызывается ОДИН раз, повторные запросы молчат.
 *   3. После истечения TTL негативный кэш пропускает новый запрос к Graph API.
 *
 * База не нужна: мокаем loadCredentials, fetchWithRetry и logSystemError.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// Моки до импорта модуля — иначе реальные зависимости подтянутся первыми.
vi.mock("../src/db.js", () => ({
  prisma: {
    settings: {
      findUnique: vi.fn().mockResolvedValue({
        metaAppSecret: null,
        metaVerifyToken: null,
        metaWaToken: null,
        metaWaPhoneId: null,
        metaIgToken: null,
        metaIgAppSecret: null,
        metaPageToken: null,
        metaPageId: null,
      }),
    },
    messengerAccount: { findMany: vi.fn().mockResolvedValue([]) },
    $disconnect: vi.fn().mockResolvedValue(undefined),
  },
}));
vi.mock("../src/lib/systemError.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/lib/systemError.js")>()),
  logSystemError: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("../src/crypto.js", () => ({
  decryptSecretSafe: (v: string | null) => v,
}));
vi.mock("../src/lib/describeError.js", () => ({
  describeError: (e: unknown) => String(e),
}));
vi.mock("../src/ai/geminiTransport.js", () => ({
  GEMINI_RETRY_DELAYS_MS: [],
  sleep: vi.fn(),
}));
vi.mock("../src/messengers/outgoingMids.js", () => ({
  rememberOutgoingMid: vi.fn(),
}));

const mockFetch = vi.fn();
vi.stubGlobal("fetch", mockFetch);

import { fetchInstagramProfile, resetInstagramProfileCache } from "../src/messengers/meta.js";
import { logSystemError } from "../src/lib/systemError.js";

const TOKEN = "test-ig-token";
const SENDER_ID = "123456789";

function graphOkResponse() {
  return new Response(
    JSON.stringify({
      id: SENDER_ID,
      username: "test_user",
      name: "Test User",
      profile_picture_url: "https://example.com/pic.jpg",
      follower_count: 42,
      is_user_follow_business: true,
    }),
    { status: 200, headers: { "Content-Type": "application/json" } }
  );
}

function graphSubcode33Response() {
  return new Response(
    JSON.stringify({
      error: {
        message: "Object does not exist",
        type: "OAuthException",
        code: 400,
        error_subcode: 33,
      },
    }),
    { status: 400, headers: { "Content-Type": "application/json" } }
  );
}

describe("Instagram profile cache", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
    // Модуль-синглтон живёт весь процесс воркера vitest, а не один тестовый
    // файл: без явного сброса другой файл, запущенный в том же воркере ДО
    // этого, оставляет здесь чужие записи (найдено 03.09.2026 — тесты падали
    // только в общем прогоне, поодиночке проходили). Уникальные senderId сами
    // по себе от этого не защищают: кэш недоступности хранит по senderId, а
    // не по имени теста.
    resetInstagramProfileCache();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("успешный профиль НЕ кэшируется — признак подписки должен быть свежим", async () => {
    const sid = `${SENDER_ID}_ok`;
    mockFetch.mockResolvedValueOnce(graphOkResponse());

    const first = await fetchInstagramProfile(sid, TOKEN);
    expect(first.username).toBe("test_user");
    expect(mockFetch).toHaveBeenCalledTimes(1);

    mockFetch.mockResolvedValueOnce(graphOkResponse());
    const second = await fetchInstagramProfile(sid, TOKEN);
    expect(second.username).toBe("test_user");
    expect(mockFetch).toHaveBeenCalledTimes(2);
  });

  it("кэширует subcode 33 как пустой объект и логирует один раз", async () => {
    const sid = `${SENDER_ID}_sub33`;
    mockFetch.mockResolvedValueOnce(graphSubcode33Response());

    const first = await fetchInstagramProfile(sid, TOKEN);
    expect(first).toEqual({});
    expect(mockFetch).toHaveBeenCalledTimes(1);
    expect(logSystemError).toHaveBeenCalledTimes(1);

    // Повторный запрос — из кэша, без fetch и без второго лога.
    const second = await fetchInstagramProfile(sid, TOKEN);
    expect(second).toEqual({});
    expect(mockFetch).toHaveBeenCalledTimes(1);
    expect(logSystemError).toHaveBeenCalledTimes(1);
  });

  it("пропускает запрос после истечения TTL (24ч)", async () => {
    const sid = `${SENDER_ID}_ttl`;
    mockFetch.mockResolvedValueOnce(graphSubcode33Response());

    await fetchInstagramProfile(sid, TOKEN);
    expect(mockFetch).toHaveBeenCalledTimes(1);

    // Через 23 часа — всё ещё негативный кэш.
    vi.advanceTimersByTime(23 * 60 * 60 * 1000);
    await fetchInstagramProfile(sid, TOKEN);
    expect(mockFetch).toHaveBeenCalledTimes(1);

    // Через 25 часов — TTL истёк, новый запрос.
    mockFetch.mockResolvedValueOnce(graphOkResponse());
    vi.advanceTimersByTime(2 * 60 * 60 * 1000);
    await fetchInstagramProfile(sid, TOKEN);
    expect(mockFetch).toHaveBeenCalledTimes(2);
  });
});