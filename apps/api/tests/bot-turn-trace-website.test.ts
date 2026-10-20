import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import express from "express";
import request from "supertest";
import type { BotTurnTracePayload } from "@royal-home/shared";
const state = vi.hoisted(() => ({ rows: [] as BotTurnTracePayload[], enabled: true, duplicate: false, background: undefined as undefined | (() => Promise<unknown>) }));
const db = vi.hoisted(() => ({ $disconnect: vi.fn(async () => {}), $executeRaw: vi.fn(),
  customerRuntimePolicy: { findUnique: vi.fn() },
  processedMessage: { deleteMany: vi.fn(), updateMany: vi.fn(), delete: vi.fn() } }));
// Complete no-side-effect replacements: never construct Prisma or read dotenv.
vi.mock("../src/db.js", () => ({ prisma: db }));
vi.mock("../src/loadEnv.js", () => ({}));
vi.mock("../src/lib/webhookDedupe.js", async (importOriginal) => ({ ...(await importOriginal<typeof import("../src/lib/webhookDedupe.js")>()), isDuplicateDelivery: vi.fn(async () => state.duplicate), markProcessedMessageComplete: vi.fn(), releaseProcessedMessage: vi.fn() }));
vi.mock("../src/messengers/websiteChat.js", async (importOriginal) => ({ ...(await importOriginal<typeof import("../src/messengers/websiteChat.js")>()), isWebsiteChatEnabled: vi.fn(async () => state.enabled), recordWebsiteChatMessageOnly: vi.fn(async () => {}), handleWebsiteChatTurn: vi.fn(async () => state.background?.()) }));
import { webhooksRouter } from "../src/routes/webhooks.js";
import * as website from "../src/messengers/websiteChat.js";
import { traceBindConversation, traceWidgetAvailable } from "../src/lib/botTurnTrace.js";
const app = express(); app.use(express.json()); app.use("/webhooks", webhooksRouter);
const settle = () => new Promise<void>((resolve) => setImmediate(resolve));
let session = 0;
async function send() { return request(app).post("/webhooks/website-chat").set("X-Api-Key", "fake-site-key").send({ sessionId: `fake-session-${String(++session).padStart(6, "0")}`, messageId: `fake-message-${session}`, text: "Цена?" }); }
beforeEach(async () => {
  vi.clearAllMocks(); state.rows.length = 0; state.enabled = true; state.duplicate = false; state.background = undefined;
  // This suite exercises the existing compatibility wrapper. A missing policy
  // mock must not masquerade as a real storage failure in the new before-ACK gate.
  db.customerRuntimePolicy.findUnique.mockResolvedValue({ contractVersion: "compat", rolloutMode: "OFF" });
  db.$executeRaw.mockImplementation(async (sql: { values: unknown[] }) => { state.rows.push(JSON.parse(sql.values.at(-1) as string) as BotTurnTracePayload); return 1; });
  // Warm the lazy diagnostic import, never a real connection. Assertions below
  // wait for best-effort persistence rather than assume HTTP ACK implies it.
  await import("../src/lib/botTurnTraceStore.js");
  vi.stubEnv("WEBSITE_LEAD_API_KEY", "fake-site-key"); vi.stubEnv("BOT_TURN_TRACE_ENABLED", "1");
  vi.stubEnv("BOT_TURN_TRACE_HMAC_KEY", "fictional-trace-key-only-for-unit-tests-0000"); vi.stubEnv("BOT_TURN_TRACE_TEXT_ENABLED", "0");
  vi.stubGlobal("fetch", vi.fn(async () => { throw Error("unmocked external fetch forbidden"); }));
});
afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); });
describe("actual website webhook wrapper without DB/external network", () => {
  it("does not ACK or start the legacy turn when policy storage is unavailable", async () => {
    db.customerRuntimePolicy.findUnique.mockRejectedValueOnce(new Error("synthetic policy read failure"));
    expect((await send()).status).toBe(503); await settle();
    expect(website.handleWebsiteChatTurn).not.toHaveBeenCalled();
    expect(website.recordWebsiteChatMessageOnly).not.toHaveBeenCalled();
    expect(state.rows).toEqual([]); expect(fetch).not.toHaveBeenCalled();
  });
  it("uses WEBSITE business coverage for a duplicate, preserving the original ACK", async () => {
    state.duplicate = true; const response = await send(); await vi.waitFor(() => expect(state.rows.at(-1)?.completedAt).toBeTruthy());
    expect(response.status).toBe(200); expect(response.body).toEqual({ ok: true, messages: [], accepted: false });
    expect(state.rows.at(-1)).toMatchObject({ channel: "WEBSITE", source: "website", outcome: "duplicate" });
    expect(website.handleWebsiteChatTurn).not.toHaveBeenCalled(); expect(fetch).not.toHaveBeenCalled();
  });
  it("bot off stays bot_off and still calls the existing message-only path", async () => {
    state.enabled = false; const response = await send(); await vi.waitFor(() => expect(state.rows.at(-1)?.completedAt).toBeTruthy());
    expect(response.body).toEqual({ ok: true, messages: [], botOff: true }); expect(website.recordWebsiteChatMessageOnly).toHaveBeenCalledTimes(1);
    expect(state.rows.at(-1)).toMatchObject({ outcome: "bot_off", outgoing: [] }); expect(fetch).not.toHaveBeenCalled();
  });
  it("ACK does not wait for the existing background; its later receipt stays in the same attempt", async () => {
    let release!: () => void; const waiting = new Promise<void>((resolve) => { release = resolve; });
    state.background = async () => { await waiting; traceBindConversation("fake-conversation"); traceWidgetAvailable("Ответ"); };
    const response = await send(); await settle();
    expect(response.body).toEqual({ ok: true, messages: [], accepted: false }); expect(state.rows.some((row) => row.completedAt)).toBe(false);
    release(); await vi.waitFor(() => expect(state.rows.at(-1)?.completedAt).toBeTruthy());
    expect(state.rows.at(-1)?.completedAt).not.toBeNull(); expect(state.rows.at(-1)?.outgoing[0].providerOutcome).toBe("available_to_widget");
    expect(new Set(state.rows.map((row) => row.traceId)).size).toBe(1); expect(website.handleWebsiteChatTurn).toHaveBeenCalledTimes(1);
  });
  it("trace off preserves the existing message-only call and creates no diagnostic writes", async () => {
    vi.stubEnv("BOT_TURN_TRACE_ENABLED", "0"); state.enabled = false;
    expect((await send()).status).toBe(200); await settle();
    expect(state.rows).toEqual([]); expect(website.recordWebsiteChatMessageOnly).toHaveBeenCalledTimes(1); expect(fetch).not.toHaveBeenCalled();
  });
});
