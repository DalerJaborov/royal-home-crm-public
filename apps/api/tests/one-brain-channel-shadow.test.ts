import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { botTurnTracePayloadSchema, type BotTurnTracePayload } from "@royal-home/shared";

/**
 * One brain, step 2 (owner 16.11.2026): per-channel switch + shadow comparison of the old bot with the core.
 * The core, its runtime and the DB are faked; the trace is the real one (schema-checked), recorded in memory.
 */
const f = vi.hoisted(() => ({
  queryRaw: vi.fn(), brand: vi.fn(async (): Promise<string | null> => null), core: vi.fn(), opened: vi.fn(), publicRead: vi.fn(),
  qualify: vi.fn(), schedule: vi.fn(),
}));
vi.mock("../src/db.js", async importOriginal => {
  const original = await importOriginal<typeof import("../src/db.js")>();
  return { ...original, prisma: new Proxy(original.prisma, { get: (target, key) => key === "$queryRaw" ? f.queryRaw : Reflect.get(target, key) }) };
});
vi.mock("../src/messengers/accounts.js", async importOriginal => ({ ...(await importOriginal<typeof import("../src/messengers/accounts.js")>()),
  accountBrandName: f.brand }));
vi.mock("../src/lib/customerAgentRevision.js", async importOriginal => ({ ...(await importOriginal<typeof import("../src/lib/customerAgentRevision.js")>()),
  decodeCustomerAgentRevision: (row: { id: string }) => ({ id: row.id, knowledgeSourceHash: "k".repeat(64), limits: { deadlineMs: 30_000 } }) }));
vi.mock("../src/lib/customerAgentRuntime.js", async importOriginal => ({ ...(await importOriginal<typeof import("../src/lib/customerAgentRuntime.js")>()),
  openPinnedCustomerAgentRuntime: f.opened }));
vi.mock("../src/ai/customerAgentCore.js", async importOriginal => ({ ...(await importOriginal<typeof import("../src/ai/customerAgentCore.js")>()),
  runCustomerAgentTurn: f.core }));
vi.mock("../src/lib/customerAgentPublicReads.js", async importOriginal => ({ ...(await importOriginal<typeof import("../src/lib/customerAgentPublicReads.js")>()),
  readCustomerAgentPublicData: f.publicRead }));

const { customerAgentChannelMode, customerAgentShadowChannels, customerAgentLegacyChannelKey, customerAgentShadowDailyCap } =
  await import("../src/lib/customerAgentChannelSwitch.js");
const { runLegacyCoreShadow, legacyShadowTurns, legacyShadowCoreView, resetLegacyShadowState } = await import("../src/lib/customerAgentLegacyShadow.js");

const revisionId = "a".repeat(64);
const secret = "synthetic-one-brain-shadow-secret-0000000000";
function recorder() {
  const rows: BotTurnTracePayload[] = [];
  return { rows, traceConfig: { enabled: true, text: true, secret, write: (row: BotTurnTracePayload) => { rows.push(row); } } };
}
const turn = (over: Record<string, unknown> = {}) => ({ channel: "TELEGRAM", accountId: null, traceAccount: null, conversationId: "conv-1",
  eventId: "evt-1", phoneKnown: false,
  history: [{ role: "user" as const, content: "Салом" }, { role: "assistant" as const, content: "Ассалому алейкум!" },
    { role: "user" as const, content: "PRIVATE_CUSTOMER_TEXT нужна двушка в Сино" }],
  legacy: { replied: true, bubbles: 2, askedPhone: true, action: "none" as const }, ...over });
const readyRuntime = () => ({ status: "ready", runtime: { operation: { id: "op" }, modelTurn: vi.fn(), mediaEnabled: false,
  perceiveMedia: vi.fn(), stop: vi.fn(), close: vi.fn(async () => {}) } });

beforeEach(() => {
  resetLegacyShadowState();
  vi.stubEnv("BOT_TURN_TRACE_ENABLED", "1");
  vi.stubEnv("BOT_TURN_TRACE_HMAC_KEY", secret);
  vi.stubEnv("CUSTOMER_AGENT_CHANNEL_SHADOW", "");
  vi.stubEnv("CUSTOMER_AGENT_SHADOW_DAILY_CAP", "");
  f.queryRaw.mockReset().mockResolvedValueOnce([{ activeAgentRevisionId: revisionId }]).mockResolvedValueOnce([{ id: revisionId, manifestJson: {} }]);
  f.opened.mockReset().mockImplementation(async () => readyRuntime());
  f.core.mockReset(); f.publicRead.mockReset(); f.brand.mockReset().mockResolvedValue(null);
});
afterEach(() => { vi.unstubAllEnvs(); });

describe("channel switch", () => {
  it("defaults to the old behaviour for every channel", () => {
    for (const key of ["meta_dm", "arvan", "website", "youtube", "telegram"] as const) expect(customerAgentChannelMode(key, {})).toBe("legacy");
  });
  it("turns shadow on per channel, `all` for every one, unknown keys (incl. a `live` attempt) never widen", () => {
    expect([...customerAgentShadowChannels("telegram, ARVAN")].sort()).toEqual(["arvan", "telegram"]);
    expect(customerAgentShadowChannels("all").size).toBe(5);
    expect([...customerAgentShadowChannels("telegram:live,comments,meta_dm")]).toEqual(["meta_dm"]);
    expect(customerAgentChannelMode("website", { CUSTOMER_AGENT_CHANNEL_SHADOW: "telegram" })).toBe("legacy");
  });
  it("maps a turn to its switch; a branded account (Arvan) is its own channel", () => {
    expect(customerAgentLegacyChannelKey("INSTAGRAM", "Арван")).toBe("arvan");
    expect(customerAgentLegacyChannelKey("FACEBOOK", "  ")).toBe("meta_dm");
    expect(customerAgentLegacyChannelKey("WHATSAPP", null)).toBe("meta_dm");
    expect(customerAgentLegacyChannelKey("TELEGRAM", null)).toBe("telegram");
    expect(customerAgentLegacyChannelKey("YOUTUBE", null)).toBe("youtube");
    expect(customerAgentLegacyChannelKey("WEBSITE", null)).toBe("website");
    expect(customerAgentLegacyChannelKey("SMS", null)).toBeNull();
  });
  it("daily cap: default 200, 0 switches off, garbage falls back", () => {
    expect(customerAgentShadowDailyCap({})).toBe(200);
    expect(customerAgentShadowDailyCap({ CUSTOMER_AGENT_SHADOW_DAILY_CAP: "0" })).toBe(0);
    expect(customerAgentShadowDailyCap({ CUSTOMER_AGENT_SHADOW_DAILY_CAP: "-3" })).toBe(200);
  });
});

describe("shadow run", () => {
  it("default switch: no DB read, no model call, nothing recorded", async () => {
    const rec = recorder();
    expect(await runLegacyCoreShadow(turn(), rec)).toBe("skipped");
    expect(f.queryRaw).not.toHaveBeenCalled(); expect(f.brand).not.toHaveBeenCalled(); expect(f.core).not.toHaveBeenCalled();
    expect(rec.rows).toEqual([]);
  });
  it("switch on but trace storage off: never spends a model call nobody can read", async () => {
    vi.stubEnv("CUSTOMER_AGENT_CHANNEL_SHADOW", "telegram"); vi.stubEnv("BOT_TURN_TRACE_ENABLED", "");
    expect(await runLegacyCoreShadow(turn(), recorder())).toBe("skipped");
    expect(f.core).not.toHaveBeenCalled();
  });
  it("records both verdicts in one metadata-only record; writes are denied, reads carry the account brand", async () => {
    vi.stubEnv("CUSTOMER_AGENT_CHANNEL_SHADOW", "arvan");
    f.brand.mockResolvedValue("Арван");
    f.publicRead.mockResolvedValue({ status: "observed", observation: { kind: "company_information" } });
    const toolResults: unknown[] = [];
    f.core.mockImplementation(async (frame: Record<string, unknown>, ports: { executeAllowedTool: (call: unknown, wait: unknown) => Promise<unknown> }) => {
      expect(frame).toMatchObject({ surface: "dm", sayMode: "shadow", inputText: expect.stringContaining("двушка"), knownPhoneSource: "none" });
      expect((frame.tools as { name: string }[]).map(t => t.name)).not.toContain("save_contact");
      expect((frame.tools as { name: string }[]).map(t => t.name)).not.toContain("get_property_facts");
      expect((frame.verifiedContext as { turns: unknown[] }).turns).toHaveLength(2);
      toolResults.push(await ports.executeAllowedTool({ name: "save_contact", args: {} }, {}));
      toolResults.push(await ports.executeAllowedTool({ name: "get_company_information", args: {} }, {}));
      return { status: "ready", decision: { kind: "clarify", refs: [] }, question: "budget", text: "PRIVATE_TEMPLATE_TEXT", evidence: [],
        rounds: 2, toolCalls: 2, answer: { status: "dropped", reason: "shadow" } };
    });
    const rec = recorder();
    expect(await runLegacyCoreShadow(turn({ channel: "INSTAGRAM", accountId: "acc-arvan", traceAccount: "1784" }), rec)).toBe("recorded");
    expect(toolResults[0]).toEqual({ status: "denied", reason: "channel_read_only" });
    expect(toolResults[1]).toMatchObject({ status: "observed" });
    expect(f.publicRead.mock.calls[0][1]).toMatchObject({ brandName: "Арван", linkPreference: "social" });
    const last = rec.rows.at(-1)!;
    expect(botTurnTracePayloadSchema.safeParse(last).success).toBe(true);
    expect(last.managed).toMatchObject({ surface: "dm", phase: "shadow", revisionId });
    expect(last.customerCore).toMatchObject({ status: "ready", decisionKind: "clarify", answerStatus: "dropped", answerDropReason: "shadow" });
    expect(last.legacyShadow).toEqual({ channelKey: "arvan", legacy: { replied: true, bubbles: 2, askedPhone: true, action: "none" },
      core: { replied: true, askedPhone: false, question: "budget" }, agree: { replied: true, askedPhone: false }, toolsOffered: 5, historyTurns: 2 });
    expect(JSON.stringify(rec.rows)).not.toMatch(/PRIVATE_(CUSTOMER|TEMPLATE)_TEXT/);
  });
  it("Telegram is traced only through the shadow record", async () => {
    vi.stubEnv("CUSTOMER_AGENT_CHANNEL_SHADOW", "telegram");
    f.core.mockResolvedValue({ status: "held", reason: "turn_deadline", evidence: [], unknownToolCalls: [], rounds: 1, toolCalls: 0 });
    const rec = recorder();
    expect(await runLegacyCoreShadow(turn(), rec)).toBe("recorded");
    expect(rec.rows.at(-1)).toMatchObject({ channel: "TELEGRAM", legacyShadow: { channelKey: "telegram", core: { replied: false }, agree: { replied: false } } });
  });
  it("respects the daily cap", async () => {
    vi.stubEnv("CUSTOMER_AGENT_CHANNEL_SHADOW", "telegram"); vi.stubEnv("CUSTOMER_AGENT_SHADOW_DAILY_CAP", "1");
    f.core.mockResolvedValue({ status: "held", reason: "turn_deadline", evidence: [], unknownToolCalls: [], rounds: 1, toolCalls: 0 });
    expect(await runLegacyCoreShadow(turn(), recorder())).toBe("recorded");
    expect(await runLegacyCoreShadow(turn(), recorder())).toBe("skipped");
  });
  it("a runtime that cannot open is a held shadow, not an error", async () => {
    vi.stubEnv("CUSTOMER_AGENT_CHANNEL_SHADOW", "telegram");
    f.opened.mockResolvedValue({ status: "held", reason: "runtime_credentials_or_context" });
    expect(await runLegacyCoreShadow(turn(), recorder())).toBe("held");
    expect(f.core).not.toHaveBeenCalled();
  });
});

describe("pure helpers", () => {
  it("history: own words, current input last, at most six earlier turns", () => {
    const many = Array.from({ length: 10 }, (_, i) => ({ role: (i % 2 ? "assistant" : "user") as "user" | "assistant", content: `m${i}` }));
    const view = legacyShadowTurns([...many, { role: "user", content: "сейчас" }]);
    expect(view.inputText).toBe("сейчас"); expect(view.turns).toHaveLength(6); expect(view.turns.at(-1)?.text).toBe("m9");
    expect(legacyShadowTurns([{ role: "assistant", content: "hi" }]).inputText).toBe("");
  });
  it("core view: escalate and held are not a reply", () => {
    expect(legacyShadowCoreView({ status: "ready", decision: { kind: "escalate" }, question: "none", text: "x", evidence: [], rounds: 1, toolCalls: 0 } as never).replied).toBe(false);
    expect(legacyShadowCoreView({ status: "ready", decision: { kind: "reply" }, question: "phone", text: "x", evidence: [], rounds: 1, toolCalls: 0 } as never))
      .toEqual({ replied: true, askedPhone: true, question: "phone" });
  });
});
