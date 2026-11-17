import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Review #223 R1 (17.11.2026): on the core, a turn that failed is repeated only for a TRANSIENT failure and at most three runs.
 *
 * Before: `runCustomerAgentTurn` turned EVERY exception of a turn into `turn_unavailable`, and that reason went to the channels'
 * AI-retry ladder — up to 46 paid repeats over ~13 hours, while the core's own limits (`tool_limit`, `unavailable_tool`,
 * `call_id_reused`…) would fail the same way each time; a person learnt about it from the 30-minute silence watchdog, at night
 * in the morning. The old test checked `channelCoreRetryable("tool_limit")`, a string the core never returns.
 *
 * Here the REAL chain runs: runLegacyQualifyTurn (`core` mode) → runChannelCoreTurn → runCustomerAgentTurn → its catch →
 * the cause → the channel. Faked: the provider runtime (the model throws or calls tools), the revision lookup, public reads,
 * the staff alert (the existing door, asserted) and the old bot (must not run in `core`, must run in `legacy`).
 */
const f = vi.hoisted(() => ({ queryRaw: vi.fn(), opened: vi.fn(), modelTurn: vi.fn(), read: vi.fn(), alert: vi.fn(async () => "sent"),
  qualify: vi.fn(), shadow: vi.fn(), log: vi.fn(async () => {}), transport: vi.fn() }));
vi.mock("../src/lib/systemError.js", async importOriginal => ({ ...(await importOriginal<typeof import("../src/lib/systemError.js")>()),
  logSystemError: f.log }));
vi.mock("../src/db.js", async importOriginal => {
  const original = await importOriginal<typeof import("../src/db.js")>();
  return { ...original, prisma: new Proxy(original.prisma, { get: (target, key) => key === "$queryRaw" ? f.queryRaw : Reflect.get(target, key) }) };
});
vi.mock("../src/lib/customerAgentRuntime.js", async importOriginal => ({ ...(await importOriginal<typeof import("../src/lib/customerAgentRuntime.js")>()),
  openPinnedCustomerAgentRuntime: f.opened }));
vi.mock("../src/lib/customerAgentPublicReads.js", async importOriginal => ({ ...(await importOriginal<typeof import("../src/lib/customerAgentPublicReads.js")>()),
  readCustomerAgentPublicData: f.read }));
vi.mock("../src/lib/channelStaffAlert.js", async importOriginal => ({ ...(await importOriginal<typeof import("../src/lib/channelStaffAlert.js")>()),
  alertChannelStaff: f.alert }));
vi.mock("../src/ai/leadQualifier.js", async importOriginal => ({ ...(await importOriginal<typeof import("../src/ai/leadQualifier.js")>()),
  runQualifyTurn: f.qualify }));
vi.mock("../src/lib/customerAgentLegacyShadow.js", async importOriginal => ({ ...(await importOriginal<typeof import("../src/lib/customerAgentLegacyShadow.js")>()),
  scheduleLegacyCoreShadow: f.shadow }));
const hash = "a".repeat(64);
const revision = { id: hash, coreHash: hash, modelSchemaHash: hash, toolSchemaHash: hash, rendererHash: hash, knowledgeSchemaHash: hash,
  knowledgeSourceHash: hash, providerProfileHash: hash, providerPolicyHash: hash, promptHash: hash,
  limits: { maxRounds: 3, maxToolCalls: 4, maxInputChars: 40_000, maxOutputChars: 2000, maxModelOutputTokens: 1024, deadlineMs: 30_000 } };
vi.mock("../src/lib/customerAgentRevision.js", async importOriginal => ({ ...(await importOriginal<typeof import("../src/lib/customerAgentRevision.js")>()),
  decodeCustomerAgentRevision: () => revision }));

const { runLegacyQualifyTurn } = await import("../src/ai/legacyQualifyDoor.js");
const { runChannelCoreTurn, channelCoreRetryable, CHANNEL_CORE_MAX_ATTEMPTS } = await import("../src/lib/customerChannelCore.js");
const { CUSTOMER_CORE_THROWN_CODES, customerCoreFailureTransient, safeCauseCode } = await import("../src/ai/customerAgentCore.js");
const { decideYoutubeCommentWithCore } = await import("../src/messengers/youtubeCoreComment.js");
const { customerAgentHandoverLine } = await import("../src/ai/customerAgentRenderer.js");
const { createProviderOperation, ProviderOperationError } = await import("../src/ai/providerContract.js");
const { readFileSync } = await import("node:fs");

const httpError = (status: number) => Object.assign(new Error(`Gemini HTTP ${status}: managed_provider_http_error`), { status });
const coded = (code: string) => new Error(code); // exactly how customerAgentCore.ts throws its own codes
const callTool = (name: string, id: string) => ({ text: "", calls: [{ name, args: {}, id }], modelParts: [{ functionCall: { name, args: {}, id } }] });
const user = (content: string) => ({ role: "user" as const, content });
const QUESTION = [user("Сколько стоит двушка в Сино?")];
const HANDOVER_RU = customerAgentHandoverLine("ru");

/** One customer turn on Telegram in `core` mode; `attempt` is what a retry job passes (undefined = the live turn). */
const telegramTurn = (attempt?: number) => runLegacyQualifyTurn(QUESTION as never, { stage: "chatting" }, { conversationId: "tg-r1" } as never,
  { channel: "TELEGRAM", ...(attempt ? { repeat: "retry" as const, attempt } : {}) });

beforeEach(() => {
  vi.stubEnv("BOT_TURN_TRACE_ENABLED", "0");
  vi.stubEnv("CUSTOMER_AGENT_CHANNEL_CORE", "telegram,website,youtube");
  vi.stubEnv("CUSTOMER_AGENT_CHANNEL_SHADOW", "");
  f.queryRaw.mockReset().mockImplementation(async (strings: TemplateStringsArray) =>
    strings.join("?").includes("CustomerRuntimePolicy") ? [{ activeAgentRevisionId: hash }] : [{ id: hash, manifestJson: {} }]);
  f.modelTurn.mockReset();
  f.read.mockReset();
  f.alert.mockReset().mockResolvedValue("sent");
  f.qualify.mockReset().mockResolvedValue({ reply: ["old bot"], ready: false, lead: null });
  f.shadow.mockReset();
  f.log.mockReset();
  f.transport.mockReset();
  f.opened.mockReset().mockImplementation(async () => {
    const controller = new AbortController();
    const operation = createProviderOperation({ managed: true, deadlineAt: Date.now() + 30_000, maxAttempts: 8, signal: controller.signal,
      accountant: { reserve: async () => true, settle: async () => {} }, supports: () => true });
    return { status: "ready", runtime: { operation, modelTurn: f.modelTurn, stop: () => controller.abort("cancelled"), close: async () => {} } };
  });
});
afterEach(() => { vi.unstubAllEnvs(); });

describe("R1: the core's own refusals and limits — a person at once, no repeat, the customer hears the handover line", () => {
  it.each([
    // thrown by the core's own code paths (customerAgentCore.ts), reached through real tool rounds
    ["effect_unknown (a read came back «unknown»)", () => {
      f.modelTurn.mockResolvedValueOnce(callTool("get_company_information", "a"));
      f.read.mockResolvedValueOnce({ status: "unknown", reason: "lost" });
    }],
    ["invalid_server_observation (a read returned the wrong thing)", () => {
      f.modelTurn.mockResolvedValueOnce(callTool("get_company_information", "a"));
      f.read.mockResolvedValueOnce({ status: "observed", observation: { kind: "agency_contact",
        contact: { phone: "+992000000000", digits: "992000000000", channel: "telephone" } } });
    }],
    // the core's limit codes, thrown into the turn exactly as `throw new Error("<code>")` does
    ["tool_limit", () => f.modelTurn.mockRejectedValueOnce(coded("tool_limit"))],
    ["unavailable_tool", () => f.modelTurn.mockRejectedValueOnce(coded("unavailable_tool"))],
    ["call_id_reused", () => f.modelTurn.mockRejectedValueOnce(coded("call_id_reused"))],
    ["public_write_denied", () => f.modelTurn.mockRejectedValueOnce(coded("public_write_denied"))],
    // the model's own stop and a provider verdict that a repeat reproduces
    ["model_output_blocked (ManagedToolTurnStopError)", () =>
      f.modelTurn.mockRejectedValueOnce(Object.assign(new Error("model_output_blocked"), { name: "ManagedToolTurnStopError" }))],
    ["provider HTTP 400", () => f.modelTurn.mockRejectedValueOnce(httpError(400))],
  ])("%s → staff (core_refused) on the FIRST run", async (_label, arrange) => {
    arrange();
    const result = await telegramTurn();
    expect(result).toMatchObject({ reply: [HANDOVER_RU], verified: true });
    expect(f.alert).toHaveBeenCalledTimes(1);
    expect(f.alert).toHaveBeenCalledWith(expect.objectContaining({ channel: "TELEGRAM", conversationId: "tg-r1", why: "core_refused" }));
    expect(f.qualify).not.toHaveBeenCalled();
  });

  it("the adapter outcome itself is `staff`, never `unavailable` (nothing for a retry job to repeat)", async () => {
    f.modelTurn.mockRejectedValueOnce(coded("tool_limit"));
    const outcome = await runChannelCoreTurn({ channel: "TELEGRAM", channelKey: "telegram", conversationId: "tg-r1", history: QUESTION,
      phoneKnown: false }, { mode: "live" });
    expect(outcome).toMatchObject({ status: "staff", reason: "core_refused", language: "ru" });
    expect(f.modelTurn).toHaveBeenCalledTimes(1);
  });
});

describe("R1-1: the provider's own refusal stops the REAL provider operation — still a person at once, with the true reason", () => {
  // The real ProviderOperation (providerContract.ts); only the transport behind it is replaced: the stand-in model turn
  // begins an attempt exactly as the Gemini client does (operation.begin) and would then call the network (f.transport).
  const spec = { provider: "google", api: "generateContent", adapter: "tools", model: "gemini-test", profileRevision: "p",
    endpoint: "https://example.invalid", maxOutputTokens: 1024 } as const;
  let operation: ReturnType<typeof createProviderOperation> | null = null;
  const realOperation = (accountant: { reserve: () => Promise<boolean> }, supports: () => boolean = () => true) => {
    f.opened.mockImplementation(async () => {
      const controller = new AbortController();
      operation = createProviderOperation({ managed: true, deadlineAt: Date.now() + 30_000, maxAttempts: 8, signal: controller.signal,
        accountant: { ...accountant, settle: async () => {} }, supports });
      const current = operation;
      f.modelTurn.mockImplementation(async () => { await current.begin(spec, 5_000); return f.transport(); });
      return { status: "ready", runtime: { operation: current, modelTurn: f.modelTurn, stop: () => controller.abort("cancelled"), close: async () => {} } };
    });
  };
  it.each([
    ["budget_denied (the money accountant refuses the attempt)", () => realOperation({ reserve: async () => false })],
    ["unsupported (the operation does not support this call)", () => realOperation({ reserve: async () => true }, () => false)],
  ])("%s → operation stopped → staff `core_refused` on the FIRST run, no network call", async (_label, arrange) => {
    arrange();
    const outcome = await runChannelCoreTurn({ channel: "TELEGRAM", channelKey: "telegram", conversationId: "tg-r1", history: QUESTION,
      phoneKnown: false }, { mode: "live" });
    expect(operation?.stopped).toBe(true); // the path the review found: `operation_stopped`, not `turn_unavailable`
    expect(outcome).toMatchObject({ status: "staff", reason: "core_refused", language: "ru" });
    expect(f.transport).not.toHaveBeenCalled();
    expect(f.modelTurn).toHaveBeenCalledTimes(1);
    // through the door: one alert with the true reason («не смог ответить по существу»), the handover line, no retry
    const result = await telegramTurn();
    expect(result).toMatchObject({ reply: [HANDOVER_RU], verified: true });
    expect(f.alert).toHaveBeenCalledTimes(1);
    expect(f.alert).toHaveBeenCalledWith(expect.objectContaining({ why: "core_refused" }));
  });
  it("contrast: the accountant is unreachable (accounting_unavailable) — transient, the channel repeats", async () => {
    realOperation({ reserve: async () => { throw new Error("db down"); } });
    expect(await telegramTurn()).toBeNull();
    expect(operation?.stopped).toBe(true);
    expect(f.alert).not.toHaveBeenCalled();
  });
  it("`operation_stopped`: the cause decides, as for `turn_unavailable`", () => {
    expect(channelCoreRetryable("operation_stopped", "provider_budget_denied")).toBe(false);
    expect(channelCoreRetryable("operation_stopped", "provider_unsupported")).toBe(false);
    expect(channelCoreRetryable("operation_stopped", "tool_limit")).toBe(false);
    for (const c of ["provider_deadline", "provider_cancelled", "provider_accounting_unavailable", "turn_deadline", "AbortError", undefined]) {
      expect(channelCoreRetryable("operation_stopped", c), String(c)).toBe(true);
    }
  });
});

describe("R1: a transient failure is repeated, but one customer turn gets at most 3 runs — then a person", () => {
  it.each([
    ["network (fetch failed)", () => new TypeError("fetch failed")],
    ["provider HTTP 503", () => httpError(503)],
    ["provider HTTP 429", () => httpError(429)],
    ["provider deadline", () => new ProviderOperationError("deadline")],
    ["an exception of our own read code (unknown → bounded)", () => new Error("Cannot read properties of undefined")],
  ])("%s: run 1 and 2 → retry (null); run 3 → staff `core_unavailable` + handover line; run 4 → no model call", async (_label, error) => {
    f.modelTurn.mockImplementation(async () => { throw error(); });
    expect(CHANNEL_CORE_MAX_ATTEMPTS).toBe(3);
    expect(await telegramTurn()).toBeNull();           // the live turn: the channel queues its AI-retry job
    expect(await telegramTurn(2)).toBeNull();          // the job's first run
    expect(f.alert).not.toHaveBeenCalled();
    const third = await telegramTurn(3);               // the job's second run: the last paid one
    expect(third).toMatchObject({ reply: [HANDOVER_RU], verified: true });
    expect(f.alert).toHaveBeenCalledWith(expect.objectContaining({ channel: "TELEGRAM", conversationId: "tg-r1", why: "core_unavailable" }));
    expect(f.modelTurn).toHaveBeenCalledTimes(3);
    f.queryRaw.mockClear();
    const late = await telegramTurn(4);                // e.g. the job failed after the core: never a 4th paid call
    expect(late).toMatchObject({ reply: [HANDOVER_RU], verified: true });
    expect(f.modelTurn).toHaveBeenCalledTimes(3);
    expect(f.queryRaw).not.toHaveBeenCalled();
    expect(f.qualify).not.toHaveBeenCalled();
  });

  it("the cap covers the adapter's own transient reasons too (runtime not up / revision being published)", async () => {
    f.opened.mockResolvedValue({ status: "held", reason: "pinned_runtime_unavailable" });
    expect(await telegramTurn(2)).toBeNull();
    expect(await telegramTurn(3)).toMatchObject({ reply: [HANDOVER_RU] });
    f.opened.mockReset();
    f.queryRaw.mockReset().mockResolvedValue([{ activeAgentRevisionId: null }]);
    expect(await telegramTurn(3)).toMatchObject({ reply: [HANDOVER_RU] });
    expect(f.alert).toHaveBeenLastCalledWith(expect.objectContaining({ why: "core_unavailable" }));
  });

  it("R1-4: nobody could be told at the cap — the customer still hears the handover line, the director sees it in the error log", async () => {
    f.modelTurn.mockRejectedValue(httpError(503));
    f.alert.mockResolvedValueOnce("skipped");
    const result = await telegramTurn(3);
    expect(result).toMatchObject({ reply: [HANDOVER_RU], verified: true });
    expect(result?.silent).toBeUndefined();
    expect(f.log).toHaveBeenCalledTimes(1);
    expect(f.log).toHaveBeenCalledWith("ai", expect.stringContaining("сигнал сотруднику не ушёл"),
      expect.objectContaining({ dedupKey: expect.stringMatching(/^channel-core-staff-unalerted:TELEGRAM:.+/) }));
  });
  it("R1-2: «already told» (the watchdog claimed the episode) is the handover line too, and nothing is logged", async () => {
    f.modelTurn.mockRejectedValueOnce(coded("tool_limit"));
    f.alert.mockResolvedValueOnce("already");
    expect(await telegramTurn()).toMatchObject({ reply: [HANDOVER_RU], verified: true });
    expect(f.log).not.toHaveBeenCalled();
  });

  it("website: the same door and the same cap", async () => {
    f.modelTurn.mockRejectedValue(httpError(502));
    const turn = (attempt?: number) => runLegacyQualifyTurn(QUESTION as never, { stage: "chatting" }, { conversationId: "web-r1", channel: "WEBSITE" } as never,
      { channel: "WEBSITE", ...(attempt ? { repeat: "retry" as const, attempt } : {}) });
    expect(await turn()).toBeNull();
    expect(await turn(3)).toMatchObject({ reply: [HANDOVER_RU], verified: true });
    expect(f.alert).toHaveBeenCalledWith(expect.objectContaining({ channel: "WEBSITE", why: "core_unavailable" }));
  });

  it("YouTube: the comment row's attempt counts the same way (third run → escalate, no endless AI-down ladder)", async () => {
    f.modelTurn.mockRejectedValue(httpError(503));
    const row = { id: "yt-row", commentId: "yt-1", text: "Нархаш чанд?" };
    expect(await decideYoutubeCommentWithCore({ ...row, attempts: 0 })).toBeNull();
    expect(await decideYoutubeCommentWithCore({ ...row, attempts: 2 })).toMatchObject({ action: "escalate" });
    expect(await decideYoutubeCommentWithCore({ ...row, attempts: 7 })).toMatchObject({ action: "escalate" });
    expect(f.modelTurn).toHaveBeenCalledTimes(2);
  });

  it("the shadow never counts and never turns into a person (it answers nobody)", async () => {
    f.modelTurn.mockRejectedValue(httpError(503));
    const outcome = await runChannelCoreTurn({ channel: "TELEGRAM", channelKey: "telegram", conversationId: "tg-r1", history: QUESTION,
      phoneKnown: false, attempt: 9 }, { mode: "shadow" });
    expect(outcome).toEqual({ status: "unavailable", reason: "turn_unavailable" });
  });
});

describe("R1: empty env changes nothing — the old bot keeps its own ladder", () => {
  it("`legacy`: a retry with any attempt number runs the old bot, never the core, and returns its answer as before", async () => {
    vi.stubEnv("CUSTOMER_AGENT_CHANNEL_CORE", "");
    for (const attempt of [undefined, 2, 3, 40]) {
      const result = await telegramTurn(attempt);
      expect(result).toMatchObject({ reply: ["old bot"] });
    }
    f.qualify.mockResolvedValueOnce(null);
    expect(await telegramTurn(5)).toBeNull(); // the old bot is down: null → the job keeps its 46-step ladder, untouched
    expect(f.qualify).toHaveBeenCalledTimes(5);
    expect(f.modelTurn).not.toHaveBeenCalled();
    expect(f.queryRaw).not.toHaveBeenCalled();
    expect(f.alert).not.toHaveBeenCalled();
  });
});

describe("R1 guards: every code the core throws is classified; transient vs refusal by cause", () => {
  it("each `throw new Error(\"<code>\")` / `port_<reason>` in customerAgentCore.ts is listed in CUSTOMER_CORE_THROWN_CODES", () => {
    const code = readFileSync(new URL("../src/ai/customerAgentCore.ts", import.meta.url), "utf8");
    const thrown = new Set([...code.matchAll(/throw new Error\("([a-z_]+)"\)/g)].map(m => m[1]));
    if (/new Error\(`port_\$\{reason\}`\)/.test(code)) { thrown.add("port_deadline"); thrown.add("port_cancelled"); }
    expect(thrown.size).toBeGreaterThan(8);
    const listed = new Set<string>([...CUSTOMER_CORE_THROWN_CODES.transient, ...CUSTOMER_CORE_THROWN_CODES.refusal]);
    for (const c of thrown) expect(listed.has(c), `${c} is thrown by the core but not classified`).toBe(true);
    // no other template-built code may appear unnoticed
    expect([...code.matchAll(/new Error\(`/g)].length).toBe(1);
  });
  it("refusals are never repeated; the clock, provider 408/429/5xx and uncoded exceptions are (bounded by the cap)", () => {
    for (const c of CUSTOMER_CORE_THROWN_CODES.refusal) {
      expect(customerCoreFailureTransient(c), c).toBe(false);
      expect(channelCoreRetryable("turn_unavailable", c), c).toBe(false);
    }
    for (const c of CUSTOMER_CORE_THROWN_CODES.transient) expect(channelCoreRetryable("turn_unavailable", c), c).toBe(true);
    for (const c of ["provider_http_503", "provider_http_429", "provider_http_408", "provider_deadline", "provider_attempt_budget",
      "provider_accounting_unavailable", "Error", "TypeError", "TimeoutError", "unknown_error", undefined]) {
      expect(channelCoreRetryable("turn_unavailable", c), String(c)).toBe(true);
    }
    for (const c of ["provider_http_400", "provider_http_401", "provider_http_403", "provider_budget_denied", "provider_unsupported",
      "model_output_blocked", "model_output_incomplete", "some_code_added_later"]) {
      expect(channelCoreRetryable("turn_unavailable", c), c).toBe(false);
    }
    // a non-retry reason stays a person whatever the cause
    expect(channelCoreRetryable("surface_decision_denied", "TypeError")).toBe(false);
  });
  it("safeCauseCode names provider stops and HTTP statuses by code (no provider text passes)", () => {
    expect(safeCauseCode(new ProviderOperationError("budget_denied"))).toBe("provider_budget_denied");
    expect(safeCauseCode(httpError(503))).toBe("provider_http_503");
    expect(safeCauseCode(new TypeError("fetch failed: secret body"))).toBe("TypeError");
    expect(safeCauseCode(coded("tool_limit"))).toBe("tool_limit");
  });
  it("every retry job passes its attempt to the one door (no path repeats the core uncounted)", () => {
    const read = (p: string) => readFileSync(new URL(p, import.meta.url), "utf8");
    for (const file of ["../src/jobs/telegramReplyRetry.ts", "../src/jobs/telegramDirectReplyRetry.ts"]) {
      expect(read(file), file).toMatch(/repeat: "retry"[\s\S]{0,400}attempt: context\.attempt \+ 1/);
    }
    expect(read("../src/jobs/aiReplyRetry.ts")).toMatch(/"ai_retry", context \? context\.attempt \+ 1/);
    expect(read("../src/lib/stuckConversations.ts")).toMatch(/retryAttempt: attempt/);
    expect(read("../src/messengers/conversation.ts")).toMatch(/repeat: "retry" as const, \.\.\.\(input\.retryAttempt \? \{ attempt: input\.retryAttempt \}/);
    expect(read("../src/jobs/runner.ts")).toMatch(/handler\.run\(payload, \{ attempt: job\.attempts \+ 1 \}\)/);
    expect(read("../src/messengers/youtubeCoreComment.ts")).toMatch(/attempt: \(row\.attempts \?\? 0\) \+ 1/);
  });
});
