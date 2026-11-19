import { afterAll, describe, expect, it, vi } from "vitest";

/**
 * Ответ Telegram «группа стала супергруппой» несёт parameters.migrate_to_chat_id (Bot API, ResponseParameters).
 * До 20.11.2026 call() выбрасывал parameters целиком, кроме retry_after: по отказу нельзя было узнать новый id,
 * и регистрация рабочей группы помощницы навсегда осталась на старом. Здесь сам call() — через настоящий
 * fetch-подставной ответ, а не подмена функций api.ts.
 */

const calls: { method: string; body: unknown }[] = [];
let respond: (method: string) => unknown = () => ({ ok: true, result: true });

// Токен читается api.ts при загрузке модуля, поэтому окружение и подмена fetch стоят ДО импорта, а модуль грузится заново.
process.env.TELEGRAM_BOT_TOKEN = "123456:synthetic-test-token";
delete process.env.TELEGRAM_API_BASE_URL;
vi.stubGlobal("fetch", vi.fn(async (url: string, init?: { body?: string }) => {
  const method = String(url).split("/").pop() ?? "";
  calls.push({ method, body: init?.body ? JSON.parse(init.body) : undefined });
  return { json: async () => respond(method) } as unknown as Response;
}));
vi.resetModules();
const api = await import("../src/telegram/api.js");
afterAll(() => {
  vi.unstubAllGlobals();
  delete process.env.TELEGRAM_BOT_TOKEN;
});

const UPGRADED = { ok: false, error_code: 400, description: "Bad Request: group chat was upgraded to a supergroup chat", parameters: { migrate_to_chat_id: -1_001_234_567_890 } };

describe("Telegram API: parameters.migrate_to_chat_id", () => {
  it("probeChatAction отдаёт новый id в ошибке и не повторяет вызов", async () => {
    calls.length = 0;
    respond = () => UPGRADED;

    const error = await api.probeChatAction("-4000000001").catch((e: unknown) => e);

    expect(error).toBeInstanceOf(api.TelegramApiError);
    expect((error as InstanceType<typeof api.TelegramApiError>).errorCode).toBe(400);
    expect((error as InstanceType<typeof api.TelegramApiError>).migrateToChatId).toBe(-1_001_234_567_890);
    expect(api.telegramMigratedChatId(error)).toBe("-1001234567890");
    expect(calls.filter((c) => c.method === "sendChatAction")).toHaveLength(1);
    expect(calls[0].body).toEqual({ chat_id: "-4000000001", action: "typing" });
  });

  it("getChatMemberStatus тоже несёт параметр, если отказ пришёл на нём", async () => {
    respond = (method) => (method === "getMe" ? { ok: true, result: { id: 777, username: "rh_test_bot" } } : UPGRADED);

    const error = await api.getChatMemberStatus("-4000000001").catch((e: unknown) => e);

    expect(api.telegramMigratedChatId(error)).toBe("-1001234567890");
  });

  it("обычный отказ и сетевая ошибка id не дают; чужие значения параметра не принимаются", async () => {
    expect(api.telegramMigratedChatId(new api.TelegramApiError(403, "sendChatAction", "Forbidden: bot is not a member"))).toBeNull();
    expect(api.telegramMigratedChatId(new Error("timeout"))).toBeNull();
    expect(api.telegramMigratedChatId(null)).toBeNull();
    // Новый id обязан быть id супергруппы (-100…): положительное, обычногрупповое и дробное отбрасываются.
    for (const bad of [5, -4_000_000_002, -1_001_234_567_890.5, Number.MAX_SAFE_INTEGER + 2]) {
      expect(api.telegramMigratedChatId(new api.TelegramApiError(400, "m", "d", { migrate_to_chat_id: bad }))).toBeNull();
    }
  });

  it("retry_after по-прежнему работает: 429 повторяется, параметр переезда ему не мешает", async () => {
    expect(api.telegramRetryDelayMs({ ok: false, error_code: 429, parameters: { retry_after: 2 } }, 0)).toBe(3_000);
    expect(api.telegramRetryDelayMs({ ok: false, error_code: 400, parameters: { migrate_to_chat_id: -1_001_234_567_890 } }, 0)).toBeNull();
    const error = await (async () => {
      respond = () => ({ ok: false, error_code: 429, description: "Too Many Requests: retry after 90", parameters: { retry_after: 90 } });
      return api.probeChatAction("-4000000001").catch((e: unknown) => e);
    })();
    expect((error as InstanceType<typeof api.TelegramApiError>).errorCode).toBe(429);
    expect(api.telegramMigratedChatId(error)).toBeNull();
  });
});
