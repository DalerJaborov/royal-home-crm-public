import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { moderationErrorOutcome } from "../src/messengers/commentModerationOutcome.js";

beforeEach(() => {
  vi.resetModules();
  vi.stubEnv("TELEGRAM_BOT_TOKEN", "synthetic-comment-receipt-token");
  vi.stubEnv("TELEGRAM_API_BASE_URL", "https://telegram-fixture.invalid");
});
afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); });

it("actual Telegram comment accessor requires the HTTP/envelope result for this request", async () => {
  const transport = vi.fn(async (_url: unknown, _init?: RequestInit) => new Response(JSON.stringify({ ok: true, result: true }), { status: 200 }));
  vi.stubGlobal("fetch", transport);
  const { deleteChannelCommentMessage } = await import("../src/telegram/api.js");
  expect(await deleteChannelCommentMessage("-100987654321", 42)).toMatchObject({ outcome: "accepted", effect: "delete" });
  expect(transport).toHaveBeenCalledTimes(1);
  expect(String(transport.mock.calls[0][0])).toContain("/deleteMessage");
  expect(JSON.parse(String(transport.mock.calls[0][1]?.body))).toEqual({ chat_id: "-100987654321", message_id: 42 });
});

it.each([
  { status: 200, body: { ok: true, result: false } },
  { status: 200, body: { ok: true } },
  { status: 200, body: { ok: "true", result: true } },
  { status: 403, body: { ok: true, result: true } },
])("actual accessor refuses to invent success for %j", async ({ status, body }) => {
  vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify(body), { status })));
  const { deleteChannelCommentMessage } = await import("../src/telegram/api.js");
  await expect(deleteChannelCommentMessage("-100987654321", 42)).rejects.toThrow("unconfirmed_response");
  expect(fetch).toHaveBeenCalledTimes(1);
});

it("an actual timeout keeps the deletion unknown and does not retry the whole request", async () => {
  vi.stubGlobal("fetch", vi.fn(async () => { throw new Error("socket lost after write"); }));
  const { deleteChannelCommentMessage } = await import("../src/telegram/api.js");
  let failure: unknown;
  try { await deleteChannelCommentMessage("-100987654321", 42); } catch (error) { failure = error; }
  expect(failure).toBeInstanceOf(Error);
  expect(moderationErrorOutcome("TELEGRAM", "delete", failure).outcome).toBe("unknown");
  expect(fetch).toHaveBeenCalledTimes(1);
});
