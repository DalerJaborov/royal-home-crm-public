import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Review of #223 (17.11.2026): the fixes, each with the breakage it exists for.
 *  H1 — country words in listings are not a foreign property, and a seller is never refused a card;
 *  H2 — a voice-only turn is read by the core (transcript kept), a file/photo-only turn goes to a person, never silence;
 *  M1 — every new behaviour of the live core is behind a switch (default off = before);
 *  M4 — the core's verified text is not edited by the old reply guards, and their fallback has no banned words;
 *  the REAL core runs here (`runCustomerAgentTurn`, renderer, verifier); only the provider runtime is faked.
 */
const f = vi.hoisted(() => ({ queryRaw: vi.fn(), opened: vi.fn(), modelTurn: vi.fn() }));
vi.mock("../src/db.js", async importOriginal => {
  const original = await importOriginal<typeof import("../src/db.js")>();
  return { ...original, prisma: new Proxy(original.prisma, { get: (target, key) => key === "$queryRaw" ? f.queryRaw : Reflect.get(target, key) }) };
});
vi.mock("../src/lib/customerAgentRuntime.js", async importOriginal => ({ ...(await importOriginal<typeof import("../src/lib/customerAgentRuntime.js")>()),
  openPinnedCustomerAgentRuntime: f.opened }));

const { detectForeignPlace } = await import("../src/ai/coverageGuard.js");
const { customerIntakeLocation } = await import("../src/ai/customerAgentIntake.js");
const { channelOwnWords, channelCoreTurns, runChannelCoreTurn } = await import("../src/lib/customerChannelCore.js");
const { wrapUntrusted } = await import("../src/ai/untrustedContent.js");
const { customerIntakeLocationEnabled } = await import("../src/lib/customerAgentFeaturePolicy.js");
const { readCustomerAgentBrand, customerAgentBrandNameEnabled, customerAgentBrandVoiceEnabled } = await import("../src/lib/customerAgentBrandRead.js");
const { telegramDirectBotReplyEnabled } = await import("../src/lib/customerAgentChannelSwitch.js");
const { NEUTRAL_REPLIES, verifiedCoreReply } = await import("../src/messengers/replyChain.js");
const { unansweredTail } = await import("../src/lib/channelStaffAlert.js");
const { createProviderOperation } = await import("../src/ai/providerContract.js");
const { customerAgentRevisionSchema } = await import("@royal-home/shared");

const hash = "a".repeat(64);
const revision = { id: hash, coreHash: hash, modelSchemaHash: hash, toolSchemaHash: hash, rendererHash: hash, knowledgeSchemaHash: hash,
  knowledgeSourceHash: hash, providerProfileHash: hash, providerPolicyHash: hash, promptHash: hash,
  limits: { maxRounds: 3, maxToolCalls: 4, maxInputChars: 40_000, maxOutputChars: 2000, maxModelOutputTokens: 1024, deadlineMs: 30_000 } };
vi.mock("../src/lib/customerAgentRevision.js", async importOriginal => ({ ...(await importOriginal<typeof import("../src/lib/customerAgentRevision.js")>()),
  decodeCustomerAgentRevision: () => revision }));

beforeEach(() => {
  vi.stubEnv("BOT_TURN_TRACE_ENABLED", "0");
  f.queryRaw.mockReset().mockResolvedValueOnce([{ activeAgentRevisionId: hash }]).mockResolvedValueOnce([{ id: hash, manifestJson: {} }]);
  f.modelTurn.mockReset();
  f.opened.mockReset().mockImplementation(async () => {
    const controller = new AbortController();
    const operation = createProviderOperation({ managed: true, deadlineAt: Date.now() + 30_000, maxAttempts: 8, signal: controller.signal,
      accountant: { reserve: async () => true, settle: async () => {} }, supports: () => true });
    return { status: "ready", runtime: { operation, modelTurn: f.modelTurn, stop: () => controller.abort("cancelled"), close: async () => {} } };
  });
});
afterEach(() => { vi.unstubAllEnvs(); });

describe("H1: country words are not a foreign property; a seller always gets a card", () => {
  it.each([
    "Живу в Москве, продаю 2-комнатную в Сино",
    "Ман дар Маскав кор мекунам, хонаамро дар Фирдавсӣ мефурӯшам",
    "Продаю квартиру, кухня американского типа",
    "Продаю двушку с европейским ремонтом",
    "Продаю, окна Германия, ремонт евро",
    "Нахожусь в России, продаю дом в Шохмансуре",
    "Живу в Москве, продаю квартиру",
    "Продаю квартиру. Сам сейчас в Москве",
  ])("not abroad: %s", text => {
    expect(detectForeignPlace(text)).toBeNull();
  });
  it.each(["Продаю квартиру в Москве", "Хонаамро дар Маскав мефурӯшам", "Продам дом в Казахстане, в Алматы"])("abroad: %s", text => {
    expect(detectForeignPlace(text)).not.toBeNull();
  });
  it("a buyer who lives abroad is never «abroad»", () => {
    expect(customerIntakeLocation(["Живу в Москве, ищу квартиру в Душанбе"], "buyer")).toEqual({});
    expect(customerIntakeLocation(["Продаю квартиру в Москве"], "buyer")).toEqual({});
  });
  it("the core's lead routing by place is switched off by default", () => {
    expect(customerIntakeLocationEnabled({})).toBe(false);
    expect(customerIntakeLocationEnabled({ CUSTOMER_AGENT_INTAKE_LOCATION: "on" })).toBe(true);
  });
});

describe("H2: voice is the customer's own words; a file or photo alone goes to a person", () => {
  const voice = wrapUntrusted("voice", "Салом, дуҳуҷрагӣ дар Сино мехоҳам");
  it("own words keep the voice transcript, drop a document's text and the attachment markers", () => {
    expect(channelOwnWords(voice)).toBe("Салом, дуҳуҷрагӣ дар Сино мехоҳам");
    expect(channelOwnWords(`Вот договор ${wrapUntrusted("document", "Договор купли-продажи, цена 500000")}`)).toBe("Вот договор");
    expect(channelOwnWords("[📷]")).toBe("");
    expect(channelOwnWords("[🎤 не расслышал]")).toBe("");
    expect(channelCoreTurns([{ role: "user", content: voice }]).inputText).toBe("Салом, дуҳуҷрагӣ дар Сино мехоҳам");
  });
  it("REAL core: a voice-only turn reaches the model and comes back as the server's verified text", async () => {
    f.modelTurn.mockResolvedValue({ text: JSON.stringify({ kind: "clarify", refs: [], question: "budget", social: "none" }), calls: [], modelParts: [] });
    const outcome = await runChannelCoreTurn({ channel: "TELEGRAM", channelKey: "telegram", conversationId: "c-1", eventId: "1",
      history: [{ role: "user", content: voice }], phoneKnown: false }, { mode: "live" });
    expect(outcome.status).toBe("reply");
    if (outcome.status !== "reply") return;
    expect(outcome.text.trim().length).toBeGreaterThan(5);
    const sent = JSON.stringify(f.modelTurn.mock.calls[0][0].contents);
    expect(sent).toContain("дуҳуҷрагӣ дар Сино");
    expect(customerAgentRevisionSchema.safeParse(revision).success).toBe(true);
  });
  it("REAL core: a photo or file without words is never silence — a person, no model call", async () => {
    const outcome = await runChannelCoreTurn({ channel: "WEBSITE", channelKey: "website", conversationId: "c-2", eventId: "2",
      history: [{ role: "assistant", content: "Здравствуйте!" }, { role: "user", content: "[📷]" }], phoneKnown: false }, { mode: "live" });
    expect(outcome).toMatchObject({ status: "staff", reason: "unreadable_input" });
    expect(f.modelTurn).not.toHaveBeenCalled();
  });
  it("REAL core: escalation is a person with the customer's language", async () => {
    f.modelTurn.mockResolvedValue({ text: JSON.stringify({ kind: "escalate", reason: "needs_staff" }), calls: [], modelParts: [] });
    const outcome = await runChannelCoreTurn({ channel: "TELEGRAM", channelKey: "telegram", conversationId: "c-3", eventId: "3",
      history: [{ role: "user", content: "Бо мутахассис гап задан мехоҳам, занг занед" }], phoneKnown: false }, { mode: "live" });
    expect(outcome).toMatchObject({ status: "staff", reason: "escalate", language: "tg" });
  });
});

describe("M1: default env changes nothing in the live core", () => {
  it("brand name and voice are off by default; Telegram direct messages keep their reply by default", async () => {
    expect(customerAgentBrandNameEnabled({})).toBe(false);
    expect(customerAgentBrandVoiceEnabled({})).toBe(false);
    expect(await readCustomerAgentBrand("any-account", {})).toBeUndefined();
    expect(telegramDirectBotReplyEnabled({})).toBe(true);
    expect(telegramDirectBotReplyEnabled({ TELEGRAM_DIRECT_BOT_REPLY: "off" })).toBe(false);
  });
});

describe("M4: the core's verified text is delivered as is", () => {
  it("no guard edits it; only the repeat shield can stop it", async () => {
    const text = "Какой у вас бюджет? Напишите сумму и валюту.";
    expect((await verifiedCoreReply(text)).bubbles).toEqual([text]);
    expect((await verifiedCoreReply(text, async bubbles => bubbles)).bubbles).toEqual([]);
  });
  it("the old guards' neutral fallback has no word from the core's banned list", () => {
    const all = Object.values(NEUTRAL_REPLIES).flatMap(value => [value.ru, value.tg]).join(" ");
    expect(all).not.toMatch(/лутфан|муфассал|безаҳмат|мутахассис|хоҳиш мекунем/iu);
  });
});

describe("Telegram silence watchdog: what counts as «the customer is waiting»", () => {
  it("only a chat that ends with the customer's words; the episode starts at the first unanswered message", () => {
    expect(unansweredTail([{ role: "user", content: "a" }, { role: "assistant", content: "b" }])).toBeNull();
    expect(unansweredTail([{ role: "assistant", content: "b" }, { role: "user", content: "c" }, { role: "user", content: "d" }]))
      .toMatchObject({ text: "c\nd", index: 1 });
    expect(unansweredTail([])).toBeNull();
  });
});
