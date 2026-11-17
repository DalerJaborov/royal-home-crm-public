import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createHash } from "node:crypto";

/**
 * One brain, step 3 (owner 16.11.2026): the core channel adapter for Telegram (bot), the website chat and YouTube comments,
 * the lead fields «outside Dushanbe» / «other country», and the company voice per account.
 * The core run and the DB are faked where the adapter is wired; the pure parts run for real.
 */
const f = vi.hoisted(() => ({ qualify: vi.fn(), channelCore: vi.fn(), alert: vi.fn(async () => "sent"), schedule: vi.fn() }));
vi.mock("../src/ai/leadQualifier.js", async importOriginal => ({ ...(await importOriginal<typeof import("../src/ai/leadQualifier.js")>()),
  runQualifyTurn: f.qualify }));
vi.mock("../src/lib/customerChannelCore.js", async importOriginal => ({ ...(await importOriginal<typeof import("../src/lib/customerChannelCore.js")>()),
  runChannelCoreTurn: f.channelCore }));
vi.mock("../src/lib/channelStaffAlert.js", async importOriginal => ({ ...(await importOriginal<typeof import("../src/lib/channelStaffAlert.js")>()),
  alertChannelStaff: f.alert }));
vi.mock("../src/lib/customerAgentLegacyShadow.js", async importOriginal => ({ ...(await importOriginal<typeof import("../src/lib/customerAgentLegacyShadow.js")>()),
  scheduleLegacyCoreShadow: f.schedule }));

const { customerAgentChannelMode, customerAgentCoreChannels } = await import("../src/lib/customerAgentChannelSwitch.js");
const { channelCoreTurns, channelCoreIntake, channelCoreOutcome } = await import("../src/lib/customerChannelCore.js");
const { runLegacyQualifyTurn, channelCoreQualifyResult } = await import("../src/ai/legacyQualifyDoor.js");
const { youtubeCoreDecision } = await import("../src/messengers/youtubeCoreComment.js");
const { customerAgentHandoverLine } = await import("../src/ai/customerAgentRenderer.js");
const { customerIntakeLocation } = await import("../src/ai/customerAgentIntake.js");
const { customerAgentBrandBlock, CUSTOMER_AGENT_BRAND_VOICE_MAX } = await import("../src/ai/customerAgentBrand.js");
const { customerAgentBrandVoiceEnabled } = await import("../src/lib/customerAgentBrandRead.js");
const { runCustomerAgentTurn } = await import("../src/ai/customerAgentCore.js");
const { createProviderOperation } = await import("../src/ai/providerContract.js");
const { CUSTOMER_AGENT_SYSTEM } = await import("../src/ai/customerAgentPrompt.js");
const { CUSTOMER_AGENT_QUALITY_CONTINUITY_UPGRADE_V2 } = await import("../src/lib/customerAgentQualityContinuityUpgrade.js");

const ready = (decision: Record<string, unknown>, text = "Ответ", question = "none") =>
  ({ status: "ready", decision, question, text, evidence: [], rounds: 1, toolCalls: 0 }) as never;
const intake = { role: "buyer" as const };
const user = (content: string) => ({ role: "user" as const, content });
const bot = (content: string) => ({ role: "assistant" as const, content });

beforeEach(() => {
  vi.stubEnv("CUSTOMER_AGENT_CHANNEL_CORE", ""); vi.stubEnv("CUSTOMER_AGENT_CHANNEL_SHADOW", "");
  f.qualify.mockReset().mockResolvedValue({ reply: ["old bot"], ready: false, lead: null });
  f.channelCore.mockReset(); f.alert.mockClear(); f.schedule.mockReset();
});
afterEach(() => { vi.unstubAllEnvs(); });

describe("switch: `core` only where the channel has no core door of its own", () => {
  it("telegram, website, youtube can be `core`; Meta keys never (their door is rolloutConfig)", () => {
    expect([...customerAgentCoreChannels("telegram,website,youtube")].sort()).toEqual(["telegram", "website", "youtube"]);
    expect([...customerAgentCoreChannels("all")].sort()).toEqual(["telegram", "website", "youtube"]);
    expect([...customerAgentCoreChannels("meta_dm,arvan")]).toEqual([]);
    expect(customerAgentChannelMode("meta_dm", { CUSTOMER_AGENT_CHANNEL_CORE: "all", CUSTOMER_AGENT_CHANNEL_SHADOW: "meta_dm" })).toBe("shadow");
  });
  it("`core` wins over `shadow`; empty = legacy (today's behaviour)", () => {
    expect(customerAgentChannelMode("telegram", { CUSTOMER_AGENT_CHANNEL_CORE: "telegram", CUSTOMER_AGENT_CHANNEL_SHADOW: "telegram" })).toBe("core");
    expect(customerAgentChannelMode("website", {})).toBe("legacy");
  });
});

describe("adapter pure parts", () => {
  it("several unanswered customer messages are one turn; at most six earlier turns", () => {
    const history = [user("Салом"), bot("Ассалому алейкум!"), user("нужна квартира"), user("двушка в Сино")];
    expect(channelCoreTurns(history)).toEqual({ inputText: "нужна квартира\nдвушка в Сино",
      turns: [{ role: "user", text: "Салом" }, { role: "assistant", text: "Ассалому алейкум!" }] });
    expect(channelCoreTurns([bot("hi")]).inputText).toBe("");
  });
  it("lead place from the customer's words: outside the zone, abroad (seller only), Dushanbe/Rudaki lifts both", () => {
    expect(customerIntakeLocation(["Продаю дом в Худжанде"], "seller")).toMatchObject({ locationOutsideDushanbe: true });
    expect(customerIntakeLocation(["Хочу купить квартиру, я из Куляба"], "buyer")).toMatchObject({ locationOutsideDushanbe: true });
    expect(customerIntakeLocation(["Продаю квартиру в Москве"], "seller")).toMatchObject({ locationDifferentCountry: true });
    expect(customerIntakeLocation(["Живу в Москве, ищу квартиру"], "buyer")).toEqual({});
    expect(customerIntakeLocation(["Живу в Москве, продаю квартиру в Душанбе"], "seller")).toEqual({});
    expect(customerIntakeLocation(["Хонаамро дар ноҳияи Рӯдакӣ мефурӯшам"], "seller")).toEqual({});
    expect(customerIntakeLocation(["Мебели нав, оби гарм ҳаст"], "seller")).toEqual({});
    expect(channelCoreIntake([user("Хочу продать квартиру"), bot("Где она?"), user("в Вахдате")]))
      .toEqual({ role: "seller", locationOutsideDushanbe: true });
  });
  it("outcome: reply / staff / silent / moderation / unavailable", () => {
    expect(channelCoreOutcome(ready({ kind: "reply" }, "Да", "phone"), intake, "dm")).toEqual({ status: "reply", text: "Да", askedPhone: true, intake });
    expect(channelCoreOutcome(ready({ kind: "escalate", reason: "needs_staff" }), intake, "dm", "tg")).toEqual({ status: "staff", reason: "escalate", intake, language: "tg" });
    expect(channelCoreOutcome(ready({ kind: "propose", ref: "e0" }), intake, "dm")).toEqual({ status: "staff", reason: "action_needs_staff", intake, language: "ru" });
    expect(channelCoreOutcome(ready({ kind: "skip", reason: "no_reply_needed" }), intake, "dm")).toEqual({ status: "silent", reason: "no_reply_needed" });
    expect(channelCoreOutcome(ready({ kind: "moderation_proposal", action: "delete", reason: "spam" }), intake, "public_comment"))
      .toEqual({ status: "moderate", action: "delete" });
    expect(channelCoreOutcome(ready({ kind: "reply" }, "  "), intake, "dm")).toEqual({ status: "silent", reason: "empty_reply" });
    expect(channelCoreOutcome({ status: "held", reason: "turn_deadline", evidence: [], unknownToolCalls: [], rounds: 1, toolCalls: 0 } as never, intake, "dm"))
      .toEqual({ status: "unavailable", reason: "turn_deadline" });
    // The core's own verdict is not repeated (re-review #223 N3): a person, in the customer's language.
    expect(channelCoreOutcome({ status: "held", reason: "unsupported_decision_evidence", evidence: [], unknownToolCalls: [], rounds: 1, toolCalls: 0 } as never, intake, "dm", "tg"))
      .toEqual({ status: "staff", reason: "core_refused", intake, language: "tg" });
  });
  it("old result shape: lead fields from the customer's words, `ready` = the server asked for the number", () => {
    const result = channelCoreQualifyResult({ status: "reply", text: "Какой район?", askedPhone: false, intake: { role: "buyer" } },
      ["Ищу 2 комнатную квартиру до 600000 сомони"]);
    expect(result).toEqual({ reply: ["Какой район?"], ready: false, intent: "buy", lead: { budgetMax: 600000, rooms: 2, type: "APARTMENT" }, verified: true });
    // «Possibly abroad» never refuses a lead (review #223 H1): the flag does not reach the channel's lead fields.
    expect(channelCoreQualifyResult({ status: "staff", reason: "escalate", intake: { role: "seller", locationDifferentCountry: true }, language: "ru" }, ["x"]))
      .toEqual({ reply: [], ready: false, intent: "sell", lead: null, silent: "staff" });
    expect(channelCoreQualifyResult({ status: "silent", reason: "duplicate" }, ["x"])).toEqual({ reply: [], ready: false, lead: null, silent: "intended" });
  });
  it("YouTube: a reply that sends to private messages is not posted (no DMs there); moderation only hides", () => {
    expect(youtubeCoreDecision({ status: "reply", text: "Цена 500 000 сомони.", askedPhone: false, intake })).toEqual({ action: "reply", reply: "Цена 500 000 сомони." });
    expect(youtubeCoreDecision({ status: "reply", text: "Напишите нам в личные сообщения.", askedPhone: false, intake }).action).toBe("escalate");
    expect(youtubeCoreDecision({ status: "reply", text: "Дар паёми шахсӣ нависед.", askedPhone: false, intake }).action).toBe("escalate");
    expect(youtubeCoreDecision({ status: "moderate", action: "delete" })).toMatchObject({ action: "hide" });
    expect(youtubeCoreDecision({ status: "staff", reason: "escalate", intake, language: "ru" })).toMatchObject({ action: "escalate" });
    expect(youtubeCoreDecision({ status: "staff", reason: "core_refused", intake, language: "ru" }))
      .toEqual({ action: "escalate", reason: "бот не смог ответить по существу" });
    expect(youtubeCoreDecision({ status: "staff", reason: "unreadable_input", intake, language: "ru" }))
      .toEqual({ action: "escalate", reason: "бот не смог прочитать комментарий" });
    expect(youtubeCoreDecision({ status: "silent", reason: "no_reply_needed" })).toMatchObject({ action: "ignore" });
    expect(youtubeCoreDecision({ status: "unavailable", reason: "x" })).toBeNull();
  });
});

describe("the legacy door routes a `core` channel to the adapter", () => {
  const options = { conversationId: "conv-1" } as never;
  it("default: the old bot answers, the core is not called (today's behaviour)", async () => {
    const result = await runLegacyQualifyTurn([user("Салом")] as never, { stage: "chatting" }, options, { channel: "TELEGRAM" });
    expect(result?.reply).toEqual(["old bot"]);
    expect(f.channelCore).not.toHaveBeenCalled();
  });
  it("`core`: the old bot is never called; the verified reply goes out in the old shape", async () => {
    vi.stubEnv("CUSTOMER_AGENT_CHANNEL_CORE", "telegram");
    f.channelCore.mockResolvedValue({ status: "reply", text: "Какой бюджет?", askedPhone: false, intake });
    const result = await runLegacyQualifyTurn([user("Нужна квартира")] as never, { stage: "chatting" }, options, { channel: "TELEGRAM" });
    expect(f.qualify).not.toHaveBeenCalled();
    expect(result).toMatchObject({ reply: ["Какой бюджет?"], ready: false, intent: "buy", verified: true });
    expect(f.channelCore.mock.calls[0][1]).toEqual({ mode: "live" });
  });
  it("`core` + escalate: nothing to the customer, staff are told", async () => {
    vi.stubEnv("CUSTOMER_AGENT_CHANNEL_CORE", "website");
    f.channelCore.mockResolvedValue({ status: "staff", reason: "escalate", intake, language: "ru" });
    const result = await runLegacyQualifyTurn([user("Позовите человека")] as never, { stage: "chatting" }, { conversationId: "c-2", channel: "WEBSITE" } as never, { channel: "WEBSITE" });
    // The person was told → the customer hears the core's approved handover line, untouched by the old guards.
    expect(result).toMatchObject({ reply: ["Спасибо, передал ваше сообщение сотруднику."], verified: true });
    expect(result?.silent).toBeUndefined();
    expect(f.alert).toHaveBeenCalledWith({ channel: "WEBSITE", conversationId: "c-2", text: "Позовите человека", why: "escalate", eventId: null });
  });
  it("`core` + escalate but nobody could be told: no «передал» promise, silent + the channel's sweep", async () => {
    vi.stubEnv("CUSTOMER_AGENT_CHANNEL_CORE", "website");
    f.alert.mockResolvedValueOnce("skipped");
    f.channelCore.mockResolvedValue({ status: "staff", reason: "escalate", intake, language: "ru" });
    const result = await runLegacyQualifyTurn([user("Позовите человека")] as never, { stage: "chatting" }, { conversationId: "c-3", channel: "WEBSITE" } as never, { channel: "WEBSITE" });
    expect(result).toMatchObject({ reply: [], silent: "staff" });
  });
  it("`core` + core unavailable: null, so the channel's AI-retry job plays the turn again", async () => {
    vi.stubEnv("CUSTOMER_AGENT_CHANNEL_CORE", "telegram");
    f.channelCore.mockResolvedValue({ status: "unavailable", reason: "turn_deadline" });
    expect(await runLegacyQualifyTurn([user("x")] as never, { stage: "chatting" }, options, { channel: "TELEGRAM", repeat: "retry" })).toBeNull();
    expect(f.qualify).not.toHaveBeenCalled();
  });
  it("`core` + the core's own refusal (re-review #223 N3): a person now and the handover line — also on a queued retry", async () => {
    vi.stubEnv("CUSTOMER_AGENT_CHANNEL_CORE", "telegram");
    f.channelCore.mockResolvedValue({ status: "staff", reason: "core_refused", intake, language: "tg" });
    for (const repeat of [undefined, "retry" as const]) {
      f.alert.mockClear();
      const result = await runLegacyQualifyTurn([user("Нархаш чанд?")] as never, { stage: "chatting" }, { conversationId: "c-9" } as never,
        { channel: "TELEGRAM", ...(repeat ? { repeat } : {}) });
      expect(result).toMatchObject({ reply: [customerAgentHandoverLine("tg")], verified: true });
      expect(f.alert).toHaveBeenCalledWith(expect.objectContaining({ channel: "TELEGRAM", conversationId: "c-9", why: "core_refused" }));
    }
  });
  it("Telegram channel direct messages (re-review #223 N2): `telegram` does not move them; their own key does, and the alert names the right table", async () => {
    vi.stubEnv("CUSTOMER_AGENT_CHANNEL_CORE", "telegram");
    await runLegacyQualifyTurn([user("x")] as never, { stage: "chatting" }, { conversationId: "td-1" } as never, { channel: "TELEGRAM_DIRECT" });
    expect(f.channelCore).not.toHaveBeenCalled();
    expect(f.qualify).toHaveBeenCalledTimes(1);
    vi.stubEnv("CUSTOMER_AGENT_CHANNEL_CORE", "telegram_direct");
    f.channelCore.mockResolvedValue({ status: "staff", reason: "escalate", intake, language: "ru" });
    const result = await runLegacyQualifyTurn([user("Позовите человека")] as never, { stage: "chatting" }, { conversationId: "td-1" } as never,
      { channel: "TELEGRAM_DIRECT" });
    expect(f.channelCore.mock.calls[0][0]).toMatchObject({ channel: "TELEGRAM_DIRECT", channelKey: "telegram_direct" });
    expect(f.alert).toHaveBeenCalledWith(expect.objectContaining({ channel: "TELEGRAM_DIRECT", conversationId: "td-1", why: "escalate" }));
    expect(result).toMatchObject({ verified: true });
  });
  it("`core`: a guard's regeneration does not run the core twice (its text is already verified)", async () => {
    vi.stubEnv("CUSTOMER_AGENT_CHANNEL_CORE", "telegram");
    expect(await runLegacyQualifyTurn([user("x")] as never, { stage: "chatting" }, options, { channel: "TELEGRAM", repeat: "regeneration" })).toBeNull();
    expect(f.channelCore).not.toHaveBeenCalled();
    expect(f.qualify).not.toHaveBeenCalled();
  });
  it("Meta channels never reach the adapter, even with `all`", async () => {
    vi.stubEnv("CUSTOMER_AGENT_CHANNEL_CORE", "all");
    await runLegacyQualifyTurn([user("x")] as never, { stage: "chatting" }, { channel: "INSTAGRAM" } as never, { channel: "INSTAGRAM" });
    expect(f.channelCore).not.toHaveBeenCalled();
    expect(f.qualify).toHaveBeenCalledTimes(1);
  });
  it("repeats never start a second shadow", async () => {
    vi.stubEnv("CUSTOMER_AGENT_CHANNEL_SHADOW", "telegram");
    await runLegacyQualifyTurn([user("x")] as never, { stage: "chatting" }, options, { channel: "TELEGRAM", repeat: "retry" });
    expect(f.schedule).not.toHaveBeenCalled();
    await runLegacyQualifyTurn([user("x")] as never, { stage: "chatting" }, options, { channel: "TELEGRAM" });
    expect(f.schedule).toHaveBeenCalledTimes(1);
  });
});

describe("company voice per account rides in the turn, never in the pinned prompt", () => {
  const hash = "a".repeat(64);
  function frame(brand?: { name?: string; voice?: string }) {
    const controller = new AbortController();
    const operation = createProviderOperation({ managed: true, deadlineAt: Date.now() + 30_000, maxAttempts: 8, signal: controller.signal,
      accountant: { reserve: async () => true, settle: async () => {} }, supports: () => true });
    const modelTurn = vi.fn(async () => ({ text: JSON.stringify({ kind: "skip", reason: "no_reply_needed" }), calls: [], modelParts: [] }));
    return { modelTurn, run: () => runCustomerAgentTurn({ surface: "dm", language: "ru", inputText: "Салом", knownPhoneSource: "none", requestedFacts: [],
      revision: { id: hash, coreHash: hash, modelSchemaHash: hash, toolSchemaHash: hash, rendererHash: hash, knowledgeSchemaHash: hash, knowledgeSourceHash: hash,
        providerProfileHash: hash, providerPolicyHash: hash, promptHash: hash,
        limits: { maxRounds: 3, maxToolCalls: 4, maxInputChars: 40_000, maxOutputChars: 2000, maxModelOutputTokens: 1024, deadlineMs: 30_000 } },
      startedAt: Date.now(), operation, tools: [], verifiedContext: { surface: "dm", revisionId: hash, turns: [], publicState: { topic: "unknown" } as never },
      ...(brand ? { brand } : {}) }, { modelTurn, executeAllowedTool: vi.fn(), assertCurrent: vi.fn(async () => true),
      requestStop: (reason: "deadline" | "cancelled") => controller.abort(reason), observeLateToolResult: vi.fn() } as never) };
  }
  const sent = (f: ReturnType<typeof frame>) => (f.modelTurn.mock.calls[0] as unknown as [{ contents: { parts: { text?: string }[] }[] }])[0]
    .contents.flatMap(c => c.parts.map(p => p.text ?? "")).join("\n");
  it("Arvan: the company name reaches the model as serverBrand", async () => {
    const f = frame({ name: "Арван" });
    await f.run();
    expect(sent(f)).toContain("\"serverBrand\":{\"companyName\":\"Арван\"");
  });
  it("main Royal Home account (no name, no voice): no block at all — identical to before", async () => {
    const f = frame();
    await f.run();
    expect(sent(f)).not.toContain("serverBrand");
    expect(customerAgentBrandBlock({ name: " ", voice: "" })).toBeUndefined();
  });
  it("voice is bounded; owner's voice text is off until CUSTOMER_AGENT_BRAND_VOICE=on", () => {
    expect(customerAgentBrandBlock({ voice: "x".repeat(10_000) })?.voice).toHaveLength(CUSTOMER_AGENT_BRAND_VOICE_MAX);
    expect(customerAgentBrandVoiceEnabled({})).toBe(false);
    expect(customerAgentBrandVoiceEnabled({ CUSTOMER_AGENT_BRAND_VOICE: "on" })).toBe(true);
  });
  it("the pinned system prompt is unchanged (no prompt version change needed)", () => {
    expect(createHash("sha256").update(CUSTOMER_AGENT_SYSTEM).digest("hex")).toBe(CUSTOMER_AGENT_QUALITY_CONTINUITY_UPGRADE_V2.toPrompt);
  });
});
