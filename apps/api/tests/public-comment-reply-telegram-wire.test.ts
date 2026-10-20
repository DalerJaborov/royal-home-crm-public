import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { publicReplyReceipt } from "../src/messengers/publicCommentReply.js";
import { publicCommentWireFixture } from "./helpers/publicCommentWireFixture.js";
vi.mock("../src/lib/outboundShield.js", async importOriginal => ({ ...(await importOriginal<typeof import("../src/lib/outboundShield.js")>()),
  // Transport-only fixture; no principal/customer write grant is issued.
  admitOutbound: vi.fn(async () => ({ allowed: true as const, kind: "initiative" as const })),
}));
beforeEach(() => { vi.resetModules(); vi.stubEnv("TELEGRAM_BOT_TOKEN", "synthetic-public-receipt-token"); vi.stubEnv("TELEGRAM_API_BASE_URL", "https://telegram-fixture.invalid"); });
afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); vi.restoreAllMocks(); });
it("actual TG wire returns message ID and cannot silently detach from the original comment", async () => {
  const events: string[] = [];
  const fetch = vi.fn(async (_url: unknown, _init?: RequestInit) => { events.push("POST"); return new Response(JSON.stringify({ ok: true, result: { message_id: 41 } }), { status: 200 }); });
  vi.stubGlobal("fetch", fetch); const { sendMessage } = await import("../src/telegram/api.js");
  const raw = await sendMessage("-100987654321", "Synthetic public answer", 27, undefined, { requireReply: true, beforePost: async () => { events.push("guard"); } });
  expect(events).toEqual(["guard", "POST"]); expect(publicReplyReceipt("TELEGRAM", raw)).toMatchObject({ outcome: "accepted", providerId: "41" });
  expect(JSON.parse(String(fetch.mock.calls[0][1]?.body))).toMatchObject({ chat_id: "-100987654321", reply_to_message_id: 27, allow_sending_without_reply: false });
});
it("actual TG pre-POST target check prevents every provider call", async () => {
  const fetch = vi.fn(); vi.stubGlobal("fetch", fetch); const { sendMessage } = await import("../src/telegram/api.js");
  await expect(sendMessage("-100987654321", "Synthetic", 27, undefined, { requireReply: true, beforePost: async () => { throw new Error("Synthetic source changed"); } })).rejects.toThrow("Synthetic source changed");
  expect(fetch).not.toHaveBeenCalled();
});
it("actual TG HTTP 500 with a forged success envelope is not acceptance", async () => {
  const fetch = vi.fn(async () => new Response(JSON.stringify({ ok: true, result: { message_id: 41 } }), { status: 500 }));
  vi.stubGlobal("fetch", fetch); const { sendMessage } = await import("../src/telegram/api.js");
  await expect(sendMessage("-100987654321", "Synthetic", 27, undefined, { requireReply: true })).rejects.toThrow("unconfirmed");
  expect(fetch).toHaveBeenCalledTimes(1);
});
it("actual TG 429 retry cannot issue a second physical POST under the same reply attempt", async () => {
  const fetch = vi.fn(async () => new Response(JSON.stringify({ ok: false, error_code: 429, parameters: { retry_after: 0 } }), { status: 429 }));
  vi.stubGlobal("fetch", fetch); const { sendMessage } = await import("../src/telegram/api.js");
  const wire = publicCommentWireFixture({ channel: "TELEGRAM", groupChatId: "-100987654321", messageId: "27", postMessageId: "25" });
  await expect(wire.run(beforePost => sendMessage("-100987654321", "Synthetic", 27, undefined, { requireReply: true, beforePost }))).rejects.toMatchObject({ receipt: { outcome: "unknown" } });
  expect(fetch).toHaveBeenCalledTimes(1);
});
it("actual TG awaits the shield, then sees revocation before physical POST", async () => {
  const { admitOutbound } = await import("../src/lib/outboundShield.js");
  const wire = publicCommentWireFixture({ channel: "TELEGRAM", groupChatId: "-100987654321", messageId: "27", postMessageId: "25" });
  vi.mocked(admitOutbound).mockImplementationOnce(async () => { await Promise.resolve(); wire.state.current = false; return { allowed: true, kind: "initiative" }; });
  const fetch = vi.fn(); vi.stubGlobal("fetch", fetch); const { sendMessage } = await import("../src/telegram/api.js");
  await expect(wire.run(beforePost => sendMessage("-100987654321", "Synthetic", 27, undefined, { requireReply: true, beforePost }))).rejects.toMatchObject({ receipt: { outcome: "unknown" } });
  expect(fetch).not.toHaveBeenCalled();
});
it("actual TG contradictory success:false envelope never confirms a returned ID", async () => {
  const fetch = vi.fn(async () => new Response(JSON.stringify({ ok: true, success: false, result: { message_id: 41 } }), { status: 200 }));
  vi.stubGlobal("fetch", fetch); const { sendMessage } = await import("../src/telegram/api.js");
  await expect(sendMessage("-100987654321", "Synthetic", 27, undefined, { requireReply: true })).rejects.toThrow("unconfirmed");
  expect(fetch).toHaveBeenCalledTimes(1);
});
