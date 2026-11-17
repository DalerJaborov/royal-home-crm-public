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
const { channelOwnWords, channelCoreTurns, runChannelCoreTurn, channelCoreRetryable, CHANNEL_CORE_RETRY_REASONS } = await import("../src/lib/customerChannelCore.js");
const { wrapUntrusted } = await import("../src/ai/untrustedContent.js");
const { customerIntakeLocationEnabled } = await import("../src/lib/customerAgentFeaturePolicy.js");
const { readCustomerAgentBrand, customerAgentBrandNameEnabled, customerAgentBrandVoiceEnabled } = await import("../src/lib/customerAgentBrandRead.js");
const { telegramDirectBotReplyEnabled, customerAgentChannelMode, customerAgentLegacyChannelKey, customerAgentShadowChannels } = await import("../src/lib/customerAgentChannelSwitch.js");
const { NEUTRAL_REPLIES, verifiedCoreReply } = await import("../src/messengers/replyChain.js");
const { readFileSync, readdirSync, statSync } = await import("node:fs");
const { join } = await import("node:path");
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

describe("N3 (re-review #223): a transient failure is repeated, the core's own refusal goes to a person at once", () => {
  it("REAL core: the model insists on `skip` in a DM (surface_decision_denied) → staff now, no retry ladder", async () => {
    f.modelTurn.mockResolvedValue({ text: JSON.stringify({ kind: "skip", reason: "no_reply_needed" }), calls: [], modelParts: [] });
    const outcome = await runChannelCoreTurn({ channel: "TELEGRAM", channelKey: "telegram", conversationId: "c-4", eventId: "4",
      history: [{ role: "user", content: "Сколько стоит двушка в Сино?" }], phoneKnown: false }, { mode: "live" });
    expect(outcome).toMatchObject({ status: "staff", reason: "core_refused", language: "ru" });
  });
  it("REAL core: the provider throws (network / 5xx / timeout) → unavailable, the channel's retry plays it again", async () => {
    f.modelTurn.mockRejectedValue(new Error("fetch failed"));
    const outcome = await runChannelCoreTurn({ channel: "WEBSITE", channelKey: "website", conversationId: "c-5", eventId: "5",
      history: [{ role: "user", content: "Сколько стоит двушка в Сино?" }], phoneKnown: false }, { mode: "live" });
    expect(outcome).toEqual({ status: "unavailable", reason: "turn_unavailable" });
  });
  it("only provider/runtime failures are repeated; every verdict of the core is a person; unknown = a person", () => {
    for (const reason of ["turn_unavailable", "turn_deadline", "operation_stopped", "runtime_unavailable", "channel_core_failed"]) {
      expect(channelCoreRetryable(reason)).toBe(true);
    }
    for (const reason of ["surface_decision_denied", "unsupported_decision_evidence", "facts_unavailable", "round_limit", "tool_limit",
      "output_limit", "invalid_model_decision", "invalid_model_turn", "input_limit", "effect_unknown", "some_reason_added_later"]) {
      expect(channelCoreRetryable(reason)).toBe(false);
    }
  });
  it("guard: every repeatable reason is really produced by the core or the adapter (no typo silently turns into «a person»)", () => {
    const code = readFileSync(new URL("../src/ai/customerAgentCore.ts", import.meta.url), "utf8") +
      readFileSync(new URL("../src/lib/customerChannelCore.ts", import.meta.url), "utf8").replace(/CHANNEL_CORE_RETRY_REASONS[\s\S]*?\];/, "");
    for (const reason of CHANNEL_CORE_RETRY_REASONS) expect(code, reason).toContain(`"${reason}"`);
  });
});

describe("N2 (re-review #223): Telegram channel direct messages have their own switch key", () => {
  it("TELEGRAM_DIRECT is `telegram_direct`; neither `telegram` nor `all` moves it — only its own name", () => {
    expect(customerAgentLegacyChannelKey("TELEGRAM_DIRECT", null)).toBe("telegram_direct");
    expect(customerAgentChannelMode("telegram_direct", { CUSTOMER_AGENT_CHANNEL_CORE: "telegram" })).toBe("legacy");
    expect(customerAgentChannelMode("telegram_direct", { CUSTOMER_AGENT_CHANNEL_CORE: "all" })).toBe("legacy");
    expect(customerAgentChannelMode("telegram_direct", { CUSTOMER_AGENT_CHANNEL_CORE: "telegram_direct" })).toBe("core");
    expect(customerAgentChannelMode("telegram_direct", { CUSTOMER_AGENT_CHANNEL_CORE: "all,telegram_direct" })).toBe("core");
    expect(customerAgentShadowChannels("all").has("telegram_direct")).toBe(false);
    expect(customerAgentChannelMode("telegram_direct", {})).toBe("legacy");
  });
  it("guard: every turn and staff alert of a TelegramDirectConversation says TELEGRAM_DIRECT (the id is from that table)", () => {
    for (const file of ["../src/messengers/telegramDirectMessages.ts", "../src/jobs/telegramDirectReplyRetry.ts"]) {
      const code = readFileSync(new URL(file, import.meta.url), "utf8");
      const calls = [...code.matchAll(/\b(?:runLegacyQualifyTurn|alertChannelStaff)\(/g)];
      expect(calls.length, file).toBeGreaterThan(0);
      for (const call of calls) {
        const channel = code.slice(call.index!, call.index! + 1500).match(/\bchannel:\s*"([A-Z_]+)"/)?.[1];
        expect(channel, `${file}@${call.index}`).toBe("TELEGRAM_DIRECT");
      }
    }
  });
});

describe("N4 (re-review #223): after the core's text the channel never adds its own phone ask", () => {
  it("verifiedCoreReply forbids the channel's second phone message", async () => {
    expect((await verifiedCoreReply("Ташаккур, дархости шумо қабул шуд.")).stopAskingPhone).toBe(true);
  });
});

describe("N5 (re-review #223): one silence watchdog for every chat, Telegram included", () => {
  it("cron runs `runClientSilenceSweep`, which reads both Telegram tables; no second Telegram silence sweep exists", () => {
    const cron = readFileSync(new URL("../src/cron.ts", import.meta.url), "utf8");
    expect(cron).toMatch(/scheduleTracked\("client-silence-sweep"[\s\S]{0,200}runClientSilenceSweep\(/);
    const door = readFileSync(new URL("../src/lib/clientWaitingAlert.ts", import.meta.url), "utf8");
    expect(door).toContain('FROM "TelegramConversation"');
    expect(door).toContain('FROM "TelegramDirectConversation"');
    const src = new URL("../src", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1");
    const sweeps: string[] = [];
    const walk = (dir: string) => { for (const name of readdirSync(dir)) {
      const path = join(dir, name);
      if (statSync(path).isDirectory()) { if (name !== "generated") walk(path); continue; }
      if (!path.endsWith(".ts")) continue;
      for (const m of readFileSync(path, "utf8").matchAll(/export\s+async\s+function\s+(run\w*Silence\w*Sweep)\s*\(/g)) sweeps.push(m[1]);
    } };
    walk(src);
    expect(sweeps).toEqual(["runClientSilenceSweep"]);
  });
});
