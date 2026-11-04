import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import ts from "typescript";
import { describe, expect, it, vi } from "vitest";
import * as replies from "../src/telegram/assistantReply.js";
import { assistantLanguage } from "../src/ai/assistant/languageRouting.js";
import type { TelegramIncomingMessage } from "../src/telegram/api.js";

vi.mock("../src/db.js", () => ({ prisma: { $disconnect: async () => {} } }));

// Execute the actual adapter and delivery module; all external effects are inert.
const compiled = new Map<string, string>();
function load(name: string, dependencies: Record<string, unknown>) {
  if (!compiled.has(name)) compiled.set(name, ts.transpileModule(
    readFileSync(new URL(`../src/telegram/${name}.ts`, import.meta.url), "utf8"),
    { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } },
  ).outputText);
  const exports: Record<string, any> = {};
  runInNewContext(compiled.get(name)!, { exports, require: (key: string) => dependencies[key] ?? {},
    Date, Map, Set, Promise, console });
  return exports;
}

function fixture() {
  let registered = true, enabled = true, active = true, role = "DIRECTOR", now = 1000, registeredAt = 0;
  const plain = vi.fn(async () => ({})), html = vi.fn(async () => ({}));
  const voice = vi.fn(async () => true);
  const run = vi.fn(async (_history: unknown, _actor: unknown, _options: unknown) => ({ ok: true, reply: "Готово." }));
  const media = vi.fn(async () => ({ extraction: { transcript: "Проверь, пожалуйста." } }));
  const fast = vi.fn(async () => null as unknown);
  const card = vi.fn(async () => true);
  const create = vi.fn(async (input: { skipDuplicates: boolean }) => {
    expect(input.skipDuplicates).toBe(true);
    // Atomic winner, including overlapping async handler invocations.
    const count = registered ? 0 : 1;
    if (count) registeredAt = now;
    registered = true;
    return { count };
  });
  const dependencies: Record<string, unknown> = {
    "./assistantReply.js": replies,
    "./assistantVoice.js": { sendAssistantVoiceReply: voice },
    "./api.js": { getBotUsername: async () => "fixture_bot", sendMessage: plain, sendHtmlMessage: html,
      sendMessageWithButtons: plain, sendChatAction: async () => {}, setMessageReaction: async () => {} },
    "../db.js": { prisma: { settings: { findUnique: async () => ({ telegramDiscussionGroupId: null }) },
      assistantTelegramGroup: { createMany: create, upsert: async () => { registered = true; },
        findUnique: async () => registered ? { chatId: "-100", createdAt: new Date(registeredAt) } : null,
        deleteMany: async () => { registered = false; return { count: 1 }; } } } },
    "../lib/telegramAgentLink.js": { findAgentByTelegramUserId: async (id: string) => ({ id: `test-${id}`, fullName: "Fixture" }) },
    "../auth/middleware.js": { loadAgentAccess: async () => ({ isActive: active, role, permissions: new Set() }) },
    "../ai/assistant.js": { isAiAssistantEnabled: async () => enabled, runAssistantDetailed: run },
    "../ai/assistant/actor.js": { actorFromAccess: (id: string) => ({ id }) },
    "../ai/assistant/languageRouting.js": { assistantLanguage },
    "../ai/assistant/moneyBudget.js": { createAssistantMoneyWallet: () => ({}) },
    "../ai/assistantFastPath.js": { parseFastPathIntent: (text: string) => /ОБ-/i.test(text) ? { kind: "property-code" } : null,
      tryAssistantFastPath: fast },
    "../ai/untrustedContent.js": { wrapUntrusted: (_kind: string, text: string) => `<untrusted>${text}</untrusted>` },
    "../lib/agentAiActionCap.js": { claimAgentAiAction: async () => ({ allowed: true }) },
    "../lib/aiAssistantAudit.js": { logAssistantToolCall: async () => {} },
    "./assistantReadResults.js": { sendTelegramPropertyCard: card },
    "./assistantMedia.js": { handleAssistantMedia: media },
    "../lib/systemError.js": { logSystemError: async () => {} },
    "../lib/describeError.js": { describeError: (err: unknown) => String(err) },
  };
  // The fixed neutral phrases are loaded from owning source once that module exists.
  try { dependencies["./assistantGroupPhrases.js"] = load("assistantGroupPhrases", dependencies); } catch { /* baseline */ }
  dependencies["./assistantDelivery.js"] = load("assistantDelivery", dependencies);
  const adapter = load("assistantBot", dependencies);
  adapter.setGroupClockForTests(() => now);
  const message = (text = "", extra: Partial<TelegramIncomingMessage> = {}) => ({
    chat: { id: -100, type: "supergroup" }, from: { id: 1 }, message_id: 10, text, ...extra,
  });
  return { adapter, plain, html, voice, run, media, fast, card, create,
    message, send: (text = "", extra: Partial<TelegramIncomingMessage> = {}) => adapter.handleAssistantGroupMessage(message(text, extra)),
    setRegistered: (value: boolean) => { registered = value; }, setEnabled: (value: boolean) => { enabled = value; },
    setRole: (value: string) => { role = value; }, setActive: (value: boolean) => { active = value; },
    advance: (milliseconds: number) => { now += milliseconds; } };
}

describe("natural group addressing and silence", () => {
  it.each(["Шабнам, найди объект", "Мушовир: салом", "Шабнам, объектро нишон деҳ", "шабнам покажи объект", "Шабнам — привет", "Шабнам"])("accepts direct prefix %s", async text => {
    const f = fixture();
    expect(f.adapter.addressedToBot(f.message(text), "fixture_bot").addressed).toBe(true);
    await f.send(text);
    expect(f.run.mock.calls.length + f.plain.mock.calls.length).toBe(1);
  });
  it.each(["Шабнам завтра придёт", "А Шабнам завтра придёт?", "Наша Шабнам, найди документ", "Шабнамчик, привет", "Мадина, найди объект"])("ignores ordinary name reference %s", async text => {
    const f = fixture();
    expect(await f.send(text)).toBe(false);
    expect(f.run).not.toHaveBeenCalled();
    expect(f.voice).not.toHaveBeenCalled();
  });
  it.each(["поставь чайник", "у клиента день рождения", "Шабнам завтра придёт", "123456789", "123456789012"])("does not send window chatter to AI: %s", async text => {
    const f = fixture();
    await f.send("@fixture_bot привет");
    f.run.mockClear();
    expect(await f.send(text)).toBe(false);
    expect(f.run).not.toHaveBeenCalled();
  });
  it("reconnecting invalidates the old window; only a new direct address reopens it", async () => {
    const f = fixture();
    await f.send("Шабнам, помоги");
    await f.send("/assistant_off");
    await f.send("/assistant_on");
    f.run.mockClear();
    expect(await f.send("поставь на перемонтаж")).toBe(false);
    expect(f.run).not.toHaveBeenCalled();
    await f.send("Шабнам, помоги");
    await f.send("поставь на перемонтаж");
    expect(f.run).toHaveBeenCalledTimes(2);
  });
  it("a bare name opens a guarded window without calling AI", async () => {
    const f = fixture();
    await f.send("Шабнам");
    expect(f.run).not.toHaveBeenCalled();
    expect(f.plain).toHaveBeenCalledWith("-100", "Слушаю. Что нужно сделать?", 10);
    await f.send("поставь на перемонтаж");
    expect(f.run).toHaveBeenCalledOnce();
  });
  it.each(["disabled", "inactive"])("%s bare address does not open a window", async kind => {
    const f = fixture();
    if (kind === "disabled") f.setEnabled(false); else f.setActive(false);
    await f.send("Шабнам");
    f.setEnabled(true); f.setActive(true);
    expect(await f.send("123")).toBe(false);
    expect(f.run).not.toHaveBeenCalled();
  });
  it("keeps relevant continuation, author/chat isolation, stop and expiry", async () => {
    const f = fixture();
    await f.send("Шабнам, помоги");
    await f.send("поставь на перемонтаж");
    await f.send("123");
    expect(f.run).toHaveBeenCalledTimes(3);
    await f.send("поставь на перемонтаж", { from: { id: 2 } });
    await f.send("123", { chat: { id: -200, type: "supergroup" } });
    await f.send("стоп");
    await f.send("123");
    expect(f.run).toHaveBeenCalledTimes(3);
    await f.send("Шабнам, помоги");
    f.advance(f.adapter.GROUP_DIALOG_WINDOW_MS + 1);
    await f.send("123");
    expect(f.run).toHaveBeenCalledTimes(4);
  });
});

describe("one greeting per authorized registration", () => {
  it("only the atomic insertion winner greets during repeated/concurrent on", async () => {
    const f = fixture(); f.setRegistered(false);
    await Promise.all([f.send("/assistant_on"), f.send("/assistant_on")]);
    await f.send("/assistant_on");
    expect(f.create).toHaveBeenCalledTimes(3);
    expect(f.voice).toHaveBeenCalledOnce();
    expect(f.voice.mock.calls[0]?.[1]).toContain("Шабнам");
    expect(f.run).not.toHaveBeenCalled();
  });
  it.each(["AGENT", "SHAREHOLDER"])("%s cannot register or synthesize", async role => {
    const f = fixture(); f.setRegistered(false); f.setRole(role);
    await f.send("/assistant_on");
    expect(f.create).not.toHaveBeenCalled(); expect(f.voice).not.toHaveBeenCalled();
  });
  it("inactive director and global OFF never synthesize", async () => {
    const f = fixture(); f.setRegistered(false); f.setActive(false);
    await f.send("/assistant_on");
    expect(f.create).not.toHaveBeenCalled();
    f.setActive(true); f.setEnabled(false);
    await f.send("/assistant_on");
    expect(f.voice).not.toHaveBeenCalled(); expect(f.run).not.toHaveBeenCalled();
  });
  it("uses proven Tajik, and a failed greeting remains readable without repeated synthesis", async () => {
    const f = fixture(); f.setRegistered(false); f.voice.mockResolvedValue(false);
    await f.send("/assistant_on салом");
    expect(f.voice.mock.calls[0]?.[1]).toContain("Шабнам");
    expect(f.html.mock.calls[0]?.[1]).toContain("Салом");
    await f.send("/assistant_on салом");
    expect(f.voice).toHaveBeenCalledOnce();
  });
});

describe("explicitly addressed native group voice", () => {
  const audio = { voice: { file_id: "test-voice", duration: 3 },
    reply_to_message: { chat: { id: -100 }, from: { id: 99, is_bot: true, username: "fixture_bot" }, text: "Слушаю." } };
  it("answers a short addressed native voice with short voice", async () => {
    const f = fixture(); await f.send("", audio);
    expect(f.media).toHaveBeenCalledOnce(); expect(f.run).toHaveBeenCalledOnce();
    expect(f.voice).toHaveBeenCalledWith("-100", "Готово.", 10);
  });
  it("does not transcribe unaddressed group audio even in the author's window", async () => {
    const f = fixture(); await f.send("@fixture_bot привет");
    await f.send("", { voice: audio.voice });
    expect(f.media).not.toHaveBeenCalled();
  });
  it.each(["forward", "text", "structured", "long", "long-input"])("keeps %s response as text", async kind => {
    const f = fixture();
    if (kind === "text") f.media.mockResolvedValue({ extraction: { transcript: "Проверь, ответь текстом." } });
    if (kind === "structured") f.run.mockImplementation(async (_h, _a, options: any) => {
      options.onToolResult("search_properties"); return { ok: true, reply: "Ничего не нашла." };
    });
    if (kind === "long") f.run.mockResolvedValue({ ok: true, reply: "Подробный ответ. ".repeat(20) });
    await f.send("", { ...audio, ...(kind === "forward" ? { forward_origin: { type: "user" } } : {}),
      ...(kind === "long-input" ? { voice: { ...audio.voice, duration: 90 } } : {}) });
    expect(f.media).toHaveBeenCalledOnce(); expect(f.voice).not.toHaveBeenCalled();
    expect(f.html).toHaveBeenCalled();
  });
  it("never auto-voices a property card; explicit speech is masked at group boundary", async () => {
    const f = fixture();
    f.fast.mockResolvedValue({ reply: "Контакт @test_contact", cards: [{ kind: "property" }], tool: "find_property" });
    f.media.mockResolvedValue({ extraction: { transcript: "Покажи ОБ-123" } });
    await f.send("", audio);
    expect(f.card).toHaveBeenCalledOnce(); expect(f.voice).not.toHaveBeenCalled();
    await f.send("Шабнам, покажи ОБ-123, ответь голосом");
    expect(f.voice).toHaveBeenCalledOnce();
    expect(f.voice.mock.calls[0]?.[1]).not.toContain("@test_contact");
  });
});
