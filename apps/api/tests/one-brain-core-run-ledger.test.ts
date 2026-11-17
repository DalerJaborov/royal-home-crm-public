import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Review #223 R1-2 (17.11.2026, money): at most 3 core runs per customer message, wherever the repeat comes from (a run is
 * one provider operation: up to 4 paid calls, so up to 12 per message — review 0e463b02 N3).
 *
 * The chain the review found on the website (`core` mode): the third run hands the chat to a person; the silence watchdog had
 * already claimed the episode, so the alert said `skipped` and the customer got NOTHING — the chat stayed «unanswered», and
 * the stuck-chat cron (`health-automation`, every 30 minutes) queued a NEW `ai-reply-retry` whose attempt count started
 * from 1 again: 2 core runs per cron entry, up to ~94 a day on one chat.
 *
 * Here the REAL pieces run against the database: the `ai-reply-retry` job (its own «still unanswered?» guard is the cron's
 * condition), the one door to the core (`runLegacyQualifyTurn` → `runChannelCoreTurn` with its per-message run count in
 * ProcessedMessage), the staff alert (`alertChannelStaff` → `alertClientWaiting` with the episode mark). Faked: the
 * provider runtime (the model is down: HTTP 503), the revision lookup, and `retryStuckConversation` — replaced by a stand-in
 * with the website's contract (play the stored turn through the door, write the bot's reply into the history); the real
 * one drags in all of messengers/conversation.ts (see ai-reply-retry-job.test.ts) and is covered by its own tests.
 */
const f = vi.hoisted(() => ({ queryRaw: vi.fn(), real: { queryRaw: null as null | ((...args: unknown[]) => unknown) }, opened: vi.fn(),
  modelTurn: vi.fn(), log: vi.fn(async () => {}), push: vi.fn(async () => 1), persist: { enabled: true } }));
vi.mock("../src/db.js", async importOriginal => {
  const original = await importOriginal<typeof import("../src/db.js")>();
  f.real.queryRaw = (...args: unknown[]) => (original.prisma.$queryRaw as unknown as (...a: unknown[]) => unknown)(...args);
  return { ...original, prisma: new Proxy(original.prisma, { get: (target, key) => key === "$queryRaw" ? f.queryRaw : Reflect.get(target, key) }) };
});
vi.mock("../src/lib/customerAgentRuntime.js", async importOriginal => ({ ...(await importOriginal<typeof import("../src/lib/customerAgentRuntime.js")>()),
  openPinnedCustomerAgentRuntime: f.opened }));
const hash = "a".repeat(64);
const revision = { id: hash, coreHash: hash, modelSchemaHash: hash, toolSchemaHash: hash, rendererHash: hash, knowledgeSchemaHash: hash,
  knowledgeSourceHash: hash, providerProfileHash: hash, providerPolicyHash: hash, promptHash: hash,
  limits: { maxRounds: 3, maxToolCalls: 4, maxInputChars: 40_000, maxOutputChars: 2000, maxModelOutputTokens: 1024, deadlineMs: 30_000 } };
vi.mock("../src/lib/customerAgentRevision.js", async importOriginal => ({ ...(await importOriginal<typeof import("../src/lib/customerAgentRevision.js")>()),
  decodeCustomerAgentRevision: () => revision }));
vi.mock("../src/lib/systemError.js", async importOriginal => ({ ...(await importOriginal<typeof import("../src/lib/systemError.js")>()),
  logSystemError: f.log }));
vi.mock("../src/push.js", async importOriginal => ({ ...(await importOriginal<typeof import("../src/push.js")>()),
  sendPushToAgent: f.push, sendPushToAgents: f.push }));
vi.mock("../src/lib/stuckConversations.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/lib/stuckConversations.js")>()),
  /** The website's contract of the real retryStuckConversation: the stored turn through the one door, the reply into the history. */
  retryStuckConversation: async (row: { id: string }, _source: string, attempt?: number) => {
    const { prisma } = await import("../src/db.js");
    const { runLegacyQualifyTurn } = await import("../src/ai/legacyQualifyDoor.js");
    const stored = await prisma.botConversation.findUniqueOrThrow({ where: { id: row.id }, select: { messages: true } });
    const history = stored.messages as unknown as Array<{ role: "user" | "assistant"; content: string }>;
    const result = await runLegacyQualifyTurn(history as never, { stage: "chatting" }, { conversationId: row.id, channel: "WEBSITE" } as never,
      { channel: "WEBSITE", repeat: "retry", ...(attempt ? { attempt } : {}) });
    if (!result) return "ai-down";
    const text = result.reply.find(item => typeof item === "string" && item.trim());
    if (!text) return "no-reply";
    if (f.persist.enabled) {
      await prisma.botConversation.update({ where: { id: row.id }, data: { lastMessageAt: new Date(),
        messages: [...history, { role: "assistant", content: text, at: new Date().toISOString(), by: { kind: "bot" } }] as never } });
    }
    return "sent";
  },
}));

const { prisma } = await import("../src/db.js");
const { aiReplyRetryJob } = await import("../src/jobs/aiReplyRetry.js");
const { runLegacyQualifyTurn } = await import("../src/ai/legacyQualifyDoor.js");
const { createProviderOperation } = await import("../src/ai/providerContract.js");
const { customerAgentHandoverLine } = await import("../src/ai/customerAgentRenderer.js");
const { CHANNEL_CORE_MAX_ATTEMPTS, channelCoreMessageKey } = await import("../src/lib/customerChannelCore.js");

const SUBSCRIBER = `r1-ledger-${Date.now().toString(36)}`;
const HANDOVER_RU = customerAgentHandoverLine("ru");
const created: string[] = [];

/** A website chat whose customer message waits 40 minutes; the silence watchdog already told a person (episode claimed). */
async function waitingWebsiteChat(suffix: string): Promise<string> {
  const at = new Date(Date.now() - 40 * 60_000);
  const row = await prisma.botConversation.create({ data: { channel: "WEBSITE", subscriberId: `${SUBSCRIBER}-${suffix}`, lastMessageAt: at,
    silenceAlertFor: at, messages: [{ role: "user", content: "Сколько стоит двушка в Сино?", at: at.toISOString() }] as never } as never });
  created.push(row.id);
  return row.id;
}
/** One stuck-chat cron entry: a NEW `ai-reply-retry` job (its attempt count starts again), run `runs` times by the queue. */
async function cronEntry(conversationId: string, runs = 1): Promise<void> {
  for (let attempt = 1; attempt <= runs; attempt++) {
    await aiReplyRetryJob.run({ conversationId }, { attempt }).catch(() => { /* «ИИ всё ещё недоступен»: the queue's next step */ });
  }
}
const assistantLines = async (id: string) => ((await prisma.botConversation.findUniqueOrThrow({ where: { id }, select: { messages: true } }))
  .messages as Array<{ role: string; content: string }>).filter(item => item.role === "assistant").map(item => item.content);

beforeEach(() => {
  vi.stubEnv("BOT_TURN_TRACE_ENABLED", "0");
  vi.stubEnv("CUSTOMER_AGENT_CHANNEL_CORE", "website");
  vi.stubEnv("CUSTOMER_AGENT_CHANNEL_SHADOW", "");
  f.persist.enabled = true;
  f.log.mockReset();
  f.push.mockReset().mockResolvedValue(1);
  f.queryRaw.mockReset().mockImplementation(async (strings: TemplateStringsArray, ...values: unknown[]) => {
    const sql = strings.join("?");
    if (sql.includes("\"CustomerRuntimePolicy\"")) return [{ activeAgentRevisionId: hash }];
    if (sql.includes("\"CustomerAgentRevision\"")) return [{ id: hash, manifestJson: {} }];
    return f.real.queryRaw!(strings, ...values);
  });
  f.modelTurn.mockReset().mockRejectedValue(Object.assign(new Error("Gemini HTTP 503: managed_provider_http_error"), { status: 503 }));
  f.opened.mockReset().mockImplementation(async () => {
    const controller = new AbortController();
    const operation = createProviderOperation({ managed: true, deadlineAt: Date.now() + 30_000, maxAttempts: 8, signal: controller.signal,
      accountant: { reserve: async () => true, settle: async () => {} }, supports: () => true });
    return { status: "ready", runtime: { operation, modelTurn: f.modelTurn, stop: () => controller.abort("cancelled"), close: async () => {} } };
  });
});
afterEach(() => { vi.unstubAllEnvs(); });
afterAll(async () => {
  for (const id of created) {
    await prisma.processedMessage.deleteMany({ where: { channel: "channel-core-run", messageId: { startsWith: `WEBSITE:${id}:` } } });
  }
  await prisma.botConversation.deleteMany({ where: { id: { in: created } } });
});

describe("R1-2: the stuck-chat cron cannot start the count again", () => {
  it("live turn + 5 cron entries (each a new job) → 3 core runs, ONE handover line, the chat is no longer waiting", async () => {
    const id = await waitingWebsiteChat("a");
    const stored = await prisma.botConversation.findUniqueOrThrow({ where: { id }, select: { messages: true } });
    // the live turn: the model is down → null, the channel queues its retry
    expect(await runLegacyQualifyTurn(stored.messages as never, { stage: "chatting" }, { conversationId: id, channel: "WEBSITE" } as never,
      { channel: "WEBSITE" })).toBeNull();
    for (let entry = 0; entry < 5; entry++) await cronEntry(id);
    expect(f.modelTurn).toHaveBeenCalledTimes(CHANNEL_CORE_MAX_ATTEMPTS);
    expect(await assistantLines(id)).toEqual([HANDOVER_RU]);
    // the watchdog had told a person already: no second push, and «already» is not an error
    expect(f.push).not.toHaveBeenCalled();
    expect(f.log).not.toHaveBeenCalledWith("ai", expect.stringContaining("сигнал сотруднику не ушёл"), expect.anything());
  });

  it("even when the reply never lands (the chat stays «unanswered»): 5 entries × 2 job runs → still 3 core runs per message", async () => {
    const id = await waitingWebsiteChat("b");
    f.persist.enabled = false;
    for (let entry = 0; entry < 5; entry++) await cronEntry(id, 2);
    expect(f.modelTurn).toHaveBeenCalledTimes(CHANNEL_CORE_MAX_ATTEMPTS);
    const runs = await prisma.processedMessage.count({ where: { channel: "channel-core-run", messageId: { startsWith: `WEBSITE:${id}:` } } });
    expect(runs).toBe(CHANNEL_CORE_MAX_ATTEMPTS);
  });

  it("a NEW customer message is a new count (3 more runs for it, not for the old one)", async () => {
    const id = await waitingWebsiteChat("c");
    f.persist.enabled = false;
    for (let entry = 0; entry < 4; entry++) await cronEntry(id);
    expect(f.modelTurn).toHaveBeenCalledTimes(3);
    const stored = await prisma.botConversation.findUniqueOrThrow({ where: { id }, select: { messages: true } });
    await prisma.botConversation.update({ where: { id }, data: { messages: [...(stored.messages as unknown[]),
      { role: "user", content: "Алло?", at: new Date(Date.now() - 6 * 60_000).toISOString() }] as never } });
    for (let entry = 0; entry < 4; entry++) await cronEntry(id);
    expect(f.modelTurn).toHaveBeenCalledTimes(6);
  });
});

describe("review 0e463b02 N2: the count belongs to the message the run answers, not to the job", () => {
  it("a job queued for M1 plays M2 after the customer wrote again: M2 gets its own 3 runs, the job's number spends none", async () => {
    const id = await waitingWebsiteChat("n2");
    const stored = await prisma.botConversation.findUniqueOrThrow({ where: { id }, select: { messages: true } });
    expect(await runLegacyQualifyTurn(stored.messages as never, { stage: "chatting" }, { conversationId: id, channel: "WEBSITE" } as never,
      { channel: "WEBSITE" })).toBeNull();                          // M1, the live turn: run 1
    const job = (attempt: number) => aiReplyRetryJob.run({ conversationId: id }, { attempt }).catch(() => {});
    await job(1);                                                  // M1: run 2
    expect(f.modelTurn).toHaveBeenCalledTimes(2);
    // The customer writes again. The retry job is one per chat (dedupeKey), so it now plays M2's turn.
    await prisma.botConversation.update({ where: { id }, data: { messages: [...(stored.messages as unknown[]),
      { role: "user", content: "Алло, вы тут?", at: new Date(Date.now() - 60_000).toISOString() }] as never } });
    await job(2);                                                  // before: run max(3, 1) = 3 → handover after ONE run of M2
    expect(await assistantLines(id)).toEqual([]);
    await job(3);                                                  // before: number 4 → handover with no run at all
    expect(await assistantLines(id)).toEqual([]);
    await job(4);                                                  // M2: run 3 → a person, the handover line
    expect(f.modelTurn).toHaveBeenCalledTimes(5);
    expect(await assistantLines(id)).toEqual([HANDOVER_RU]);
    expect(await prisma.processedMessage.count({ where: { channel: "channel-core-run", messageId: { startsWith: `WEBSITE:${id}:` } } })).toBe(5);
  });
});

describe("review 0e463b02 N5: an opted-out chat reaches the core turn", () => {
  // Reachable: messengers/conversation.ts sets optedOutAt and still answers a direct message (the turn below it). Opting out
  // means «the bot does not write first»: a customer who writes and needs a person is still handed over and staff are told.
  it("on `staff` the customer hears the handover line and a person is signalled; no false «сигнал не ушёл» log", async () => {
    const id = await waitingWebsiteChat("n5");
    await prisma.botConversation.update({ where: { id }, data: { optedOutAt: new Date() } });
    const stored = await prisma.botConversation.findUniqueOrThrow({ where: { id }, select: { messages: true } });
    const turn = (attempt?: number) => runLegacyQualifyTurn(stored.messages as never, { stage: "chatting" },
      { conversationId: id, channel: "WEBSITE" } as never, { channel: "WEBSITE", ...(attempt ? { repeat: "retry" as const, attempt } : {}) });
    expect(await turn()).toBeNull();
    expect(await turn(2)).toBeNull();
    const third = await turn(3);                                   // the third run: the core hands the chat to a person
    expect(third?.reply).toHaveLength(1);
    expect(f.modelTurn).toHaveBeenCalledTimes(3);
    expect(f.log).not.toHaveBeenCalledWith("ai", expect.stringContaining("сигнал сотруднику не ушёл"), expect.anything());
  });
});

describe("the message key", () => {
  it("is the last customer message's time + words; a later bot reply does not change it; no customer message → none", () => {
    const user = { role: "user", content: "Салом", at: "2026-11-17T05:00:00.000Z" };
    const key = channelCoreMessageKey([user]);
    expect(key).toMatch(/^a2026-11-17T05:00:00\.000Z:[0-9a-f]{16}$/);
    expect(channelCoreMessageKey([user, { role: "assistant", content: "x", deliveryStatus: "failed" }])).toBe(key);
    expect(channelCoreMessageKey([user, { ...user, content: "Салом!" }])).not.toBe(key);
    expect(channelCoreMessageKey([{ role: "user", content: "старое без времени" }])).toMatch(/^i0:/);
    expect(channelCoreMessageKey([{ role: "assistant", content: "x" }])).toBeNull();
    expect(channelCoreMessageKey(null)).toBeNull();
  });
});
