import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import ts from "typescript";
import { describe, expect, it, vi } from "vitest";
import * as shared from "@royal-home/shared";
import * as replies from "../src/telegram/assistantReply.js";
import { maskAssistantContacts } from "../src/lib/assistantContacts.js";
import * as participation from "../src/telegram/assistantGroupParticipation.js";
import { matchPublicShellRequest } from "../src/telegram/assistantPublicShellSearch.js";
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
  let mutedUntil: Date | null = null, lastProactive: Date | null = null, lastWelcome: Date | null = null, contextEnabledAt: Date | null = null, groupLinked = true, discussionGroupId: string | null = null;
  const findProperty = vi.fn(async () => ({ kind: "shortId", properties: [{ id: "fixture-property", shortId: 123, price: 630000, currency: "TJS", status: "AVAILABLE" }] }));
  const plain = vi.fn(async () => ({})), html = vi.fn(async (..._args: unknown[]) => ({}));
  const voice = vi.fn(async () => true);
  const run = vi.fn(async (_history: unknown, _actor: unknown, _options: unknown) => ({ ok: true, reply: "Готово." }));
  const media = vi.fn(async () => ({ extraction: { transcript: "Проверь, пожалуйста." } }));
  const context = vi.fn(async () => [{ occurredAt: new Date(0), text: "Просили обновить цену." }]);
  const retainTranscript = vi.fn(async (_message: TelegramIncomingMessage, _updateId: number, _agentId: string, _text: string) => {});
  const fast = vi.fn(async () => null as unknown);
  const card = vi.fn(async () => true);
  const publicCatalog = vi.fn(async () => [{ id: 801, crmShortId: 123, price: 630000 }] as
    { id: number; crmShortId: number | null; price: number }[] | null);
  const publicShellReply = vi.fn(async (_request: unknown, _lang: string) => "Квартира меҷӯед ё ҳавлӣ?");
  const create = vi.fn(async (input: { skipDuplicates: boolean }) => {
    expect(input.skipDuplicates).toBe(true);
    // Atomic winner, including overlapping async handler invocations.
    const count = registered ? 0 : 1;
    if (count) { registeredAt = now; mutedUntil = null; lastProactive = null; lastWelcome = null; }
    registered = true;
    return { count };
  });
  const dependencies: Record<string, unknown> = {
    "@royal-home/shared": shared,
    "./assistantReply.js": replies,
    "./assistantGroupParticipation.js": participation,
    "./assistantPublicShellSearch.js": {
      matchPublicShellRequest,
      replyPublicShellRequest: publicShellReply, readAssistantPublicSiteCatalog: publicCatalog,
    },
    "./assistantGroupContext.js": { loadAssistantTelegramContext: context, retainAssistantTelegramTranscript: retainTranscript },
    "../lib/propertyRefLookup.js": { findPropertiesByRef: findProperty },
    "./assistantVoice.js": { sendAssistantVoiceReply: voice },
    "./api.js": { getBotUsername: async () => "fixture_bot", sendMessage: plain, sendHtmlMessage: html,
      sendMessageWithButtons: plain, sendChatAction: async () => {}, setMessageReaction: async () => {} },
    "../db.js": { prisma: { settings: { findUnique: async () => ({ telegramDiscussionGroupId: discussionGroupId }) },
      assistantTelegramGroup: { createMany: create, upsert: async () => { registered = true; },
        findUnique: async ({ where }: { where: { chatId: string } }) => registered && where.chatId === "-100" ? { chatId: "-100", createdAt: new Date(registeredAt), proactiveMutedUntil: mutedUntil, lastProactiveReplyAt: lastProactive, lastJoinWelcomeAt: lastWelcome, contextEnabledAt } : null,
        updateMany: async ({ where, data }: any) => {
          if (!registered || where.createdAt.getTime() !== registeredAt) return { count: 0 };
          if ("lastProactiveReplyAt" in data) {
            if (mutedUntil && mutedUntil.getTime() > now || lastProactive && lastProactive.getTime() > now - participation.PROACTIVE_GROUP_INTERVAL_MS) return { count: 0 };
            lastProactive = data.lastProactiveReplyAt;
          } else if ("lastJoinWelcomeAt" in data) {
            if (mutedUntil && mutedUntil.getTime() > now || lastWelcome && lastWelcome.getTime() > now - participation.GROUP_WELCOME_INTERVAL_MS) return { count: 0 };
            lastWelcome = data.lastJoinWelcomeAt;
          } else mutedUntil = data.proactiveMutedUntil;
          return { count: 1 };
        },
        deleteMany: async () => { registered = false; return { count: 1 }; } } } },
    "../lib/telegramAgentLink.js": { findAgentByTelegramUserId: async (id: string) => groupLinked ? { id: `test-${id}`, fullName: "Fixture" } : null },
    "../auth/middleware.js": { loadAgentAccess: async () => ({ isActive: active, role, permissions: new Set() }) },
    "../ai/assistant.js": { isAiAssistantEnabled: async () => enabled, runAssistantDetailed: run },
    "../ai/assistant/actor.js": { actorFromAccess: (id: string) => ({ id }) },
    "../ai/assistant/tools/index.js": { listAssistantToolPlugins: () => [
      { level: "C", name: "change_property_price" }, { level: "C", name: "send_to_remake" }, { level: "B", name: "add_client_note" },
    ] },
    "../ai/assistant/languageRouting.js": { assistantLanguage },
    "../ai/assistant/moneyBudget.js": { createAssistantMoneyWallet: () => ({}) },
    "../ai/assistantFastPath.js": { parseFastPathIntent: (text: string) => /ОБ-/i.test(text) ? { kind: "property-code" } : null,
      tryAssistantFastPath: fast },
    "../ai/untrustedContent.js": { wrapUntrusted: (_kind: string, text: string) => `<untrusted>${text}</untrusted>` },
    "../lib/assistantContacts.js": { maskAssistantContacts },
    "../lib/agentAiActionCap.js": { claimAgentAiAction: async () => ({ allowed: true }) },
    "../lib/aiAssistantAudit.js": { logAssistantToolCall: async () => {} },
    "./assistantReadResults.js": { sendTelegramPropertyCard: card },
    "./assistantMedia.js": { handleAssistantMedia: media },
    "../lib/systemError.js": { logSystemError: async () => {} },
    "../lib/describeError.js": { describeError: (err: unknown) => String(err) },
  };
  // The fixed neutral phrases are loaded from owning source once that module exists.
  try { dependencies["./assistantGroupPhrases.js"] = load("assistantGroupPhrases", dependencies); } catch { /* baseline */ }
  dependencies["./assistantGroupPublicListing.js"] = load("assistantGroupPublicListing", dependencies);
  dependencies["./assistantDelivery.js"] = load("assistantDelivery", dependencies);
  const adapter = load("assistantBot", dependencies);
  adapter.setGroupClockForTests(() => now);
  const message = (text = "", extra: Partial<TelegramIncomingMessage> = {}) => ({
    chat: { id: -100, type: "supergroup" }, from: { id: 1 }, message_id: 10, text, ...extra,
  });
  return { adapter, plain, html, voice, run, media, fast, card, create, findProperty, context, retainTranscript, publicCatalog, publicShellReply,
    setContext: (value: boolean) => { contextEnabledAt = value ? new Date(now) : null; },
    setLinked: (value: boolean) => { groupLinked = value; },
    setDiscussion: (value: string) => { discussionGroupId = value; },
    message, send: (text = "", extra: Partial<TelegramIncomingMessage> = {}, updateId?: number) =>
      adapter.handleAssistantGroupMessage(message(text, extra), updateId),
    setRegistered: (value: boolean) => { registered = value; }, setEnabled: (value: boolean) => { enabled = value; },
    setRole: (value: string) => { role = value; }, setActive: (value: boolean) => { active = value; },
    advance: (milliseconds: number) => { now += milliseconds; } };
}

describe("natural group addressing and silence", () => {
  it("uses forwarded text as read-only evidence when it mentions the bot", async () => {
    const f = fixture();
    await f.send("@fixture_bot измени цену ОБ-123", { forward_origin: { type: "user" } });
    expect(f.run.mock.calls[0]?.[0]).toEqual([
      { role: "user", content: expect.stringContaining("<untrusted>@fixture_bot измени цену ОБ-123</untrusted>") },
    ]);
    expect(f.run.mock.calls[0]?.[2]).toMatchObject({ confirmUi: false, readOnly: true });
  });
  it("does not execute forwarded text as a group control command", async () => {
    const f = fixture();
    expect(await f.send("/assistant_off", { forward_origin: { type: "user" } })).toBe(false);
    await f.send("Шабнам, помоги");
    expect(f.run).toHaveBeenCalledOnce();
  });
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
  const screenshotQuestion = [
    "Ассалому алайкум",
    "Умедворам тансиҳат ҳастед",
    "Савол ба аҳли гурӯҳ ва Шабнам.",
    "1. Дар ҳолати муроҷиати мизоҷи харидори хона дархост хонаи коробка тайёр бе таъмир мо чи ҷавоб диҳем",
    "2. Оё агар ба Шабнам савол диҳем аз рӯйхати дар сайти хонаҳо буда хонаи коробкаи тайёр ва бетаъмирро метавонад ҷудо кунад?",
  ].join("\n");

  it.each([true, false])("answers the two onboarding questions after greetings (linked %s)", async linked => {
    const f = fixture();
    f.setLinked(linked);
    expect(f.adapter.addressedToBot(f.message(screenshotQuestion), "fixture_bot")).toMatchObject({
      addressed: true, text: expect.stringMatching(/^1\. Дар ҳолати/),
    });
    expect(await f.send(screenshotQuestion)).toBe(true);
    const reply = f.plain.mock.calls[0]?.[1];
    expect(reply).toMatch(/^Ба харидор гӯед:/u);
    expect(reply).toContain("Шабнам, аз сайт квартираи коробка бе таъмир нишон деҳ");
    expect(reply).toContain("ҳатто агар ҳанӯз дар сайт набошанд");
    expect(reply).not.toContain("Квартира меҷӯед ё ҳавлӣ?");
    expect(f.publicShellReply).not.toHaveBeenCalled();
    expect(f.publicCatalog).not.toHaveBeenCalled();
    expect(f.run).not.toHaveBeenCalled();

    expect(await f.send("Вай автомати худш да срм хаст ку", { from: { id: 3 }, message_thread_id: 31 })).toBe(false);
    expect(await f.send("Каробка ё хонаи таёр", { from: { id: 3 }, message_thread_id: 31 })).toBe(false);
    expect(f.plain).toHaveBeenCalledOnce();
    expect(f.run).not.toHaveBeenCalled();

    const guidanceMessage = f.message(reply, {
      from: { id: 2, is_bot: true, username: "fixture_bot" }, message_thread_id: 31,
    });
    await f.send("Квартира", { from: { id: 3 }, message_thread_id: 31, reply_to_message: guidanceMessage });
    expect(f.publicShellReply).not.toHaveBeenCalled();
    expect(f.publicCatalog).not.toHaveBeenCalled();
  });

  it.each([
    ["Шабнам, чӣ тавр аз сайт хонаи коробка бе таъмир пурсам?", "Барои ҷустуҷӯ нависед:"],
    ["Шабнам, как попросить найти квартиру в коробке без ремонта?", "Для поиска напишите:"],
    ["Шабнам, умеешь ли ты отбирать квартиры в коробке без ремонта?", "Для поиска напишите:"],
  ])("gives an example for a single how-to question: %s", async (question, expected) => {
    const f = fixture();
    f.setLinked(false);
    expect(await f.send(question)).toBe(true);
    expect(f.plain.mock.calls[0]?.[1]).toContain(expected);
    expect(f.publicShellReply).not.toHaveBeenCalled();
    expect(f.run).not.toHaveBeenCalled();
  });

  it("clarifies an actual ambiguous search and accepts the illustrated command", async () => {
    const f = fixture();
    f.setLinked(false);
    expect(await f.send("Шабнам, аз сайт хонаи коробка бе таъмир нишон деҳ")).toBe(true);
    expect(f.publicShellReply).toHaveBeenLastCalledWith({ type: null }, "tg");
    expect(f.plain).toHaveBeenLastCalledWith("-100", "Квартира меҷӯед ё ҳавлӣ?", 10);
    expect(await f.send("Шабнам, аз сайт квартираи коробка бе таъмир нишон деҳ")).toBe(true);
    expect(f.publicShellReply).toHaveBeenLastCalledWith({ type: "APARTMENT" }, "tg");
  });

  it("uses CRM for a linked employee's shell search unless they ask for the website", async () => {
    const f = fixture();
    await f.send("Шабнам, найди квартиру в коробке без отделки");
    expect(f.run).toHaveBeenCalledOnce();
    await f.send("Шабнам, найди в CRM квартиру в коробке без отделки, не только на сайте");
    expect(f.run).toHaveBeenCalledTimes(2);
    expect(f.publicShellReply).not.toHaveBeenCalled();
    await f.send("Шабнам, найди на сайте квартиру в коробке без отделки");
    expect(f.publicShellReply).toHaveBeenCalledWith({ type: "APARTMENT" }, "ru");
    expect(f.run).toHaveBeenCalledTimes(2);
  });

  it("uses an explicit apartment answer only in reply to the bot's question in the same topic", async () => {
    const f = fixture();
    f.setLinked(false);
    const reply_to_message = f.message("Квартира меҷӯед ё ҳавлӣ?", {
      from: { id: 2, is_bot: true, username: "fixture_bot" }, message_thread_id: 31,
    });
    await f.send("Квартира", { message_thread_id: 32, reply_to_message });
    expect(f.publicShellReply).not.toHaveBeenCalled();
    await f.send("Квартира", { message_thread_id: 31, reply_to_message });
    expect(f.publicShellReply).toHaveBeenCalledWith({ type: "APARTMENT" }, "tg");
    expect(f.run).not.toHaveBeenCalled();
  });

  it("delivers a public selection as linked labels without a separate plain URL message", async () => {
    const f = fixture();
    f.setLinked(false);
    const result = 'Сино · 2 ҳуҷра\n<a href="https://royalhome.tj/tg/khona/27">Дар сайт бинед</a>';
    f.publicShellReply.mockResolvedValueOnce(result);
    await f.send("Салом, Шабнам, квартираи коробка бе таъмир");
    expect(f.html).toHaveBeenCalledWith("-100", result, 10);
    expect(f.plain).not.toHaveBeenCalled();
  });

  it("gives a guest exact public site facts without a CRM actor or private lookup", async () => {
    const f = fixture();
    f.setLinked(false);
    expect(await f.send("Какая цена у ОБ-123?")).toBe(true);
    expect(f.plain.mock.calls[0]?.[1]).toMatch(/ОБ-000123.*630\s000 сомони/);
    await f.send("Салом, Шабнам, ОБ-801, нархаш чанд?");
    expect(f.plain.mock.calls[1]?.[1]).toContain("наёфтам");
    expect(f.findProperty).not.toHaveBeenCalled();
    expect(f.run).not.toHaveBeenCalled();
    expect(f.context).not.toHaveBeenCalled();
  });

  it("does not answer unregistered groups, channel discussions, forwards or ambient guest questions during quiet time", async () => {
    const f = fixture();
    await f.send("Шабнам, помолчи");
    f.plain.mockClear();
    f.setLinked(false);
    expect(await f.send("Какая цена у ОБ-123?")).toBe(false);
    expect(await f.send(screenshotQuestion, { chat: { id: -200, type: "supergroup" } })).toBe(false);
    expect(await f.send("Какая цена у ОБ-123?", { forward_origin: { type: "user" } })).toBe(false);
    f.setDiscussion("-100");
    expect(await f.send(screenshotQuestion)).toBe(false);
    expect(f.plain).not.toHaveBeenCalled();
    expect(f.publicCatalog).not.toHaveBeenCalled();
    expect(f.publicShellReply).not.toHaveBeenCalled();
    expect(f.run).not.toHaveBeenCalled();
  });

  it("does not expose archives, private listings or writes to unlinked participants", async () => {
    const f = fixture();
    f.setContext(true);
    f.setLinked(false);
    expect(await f.send("Поставь цену ОБ-123 на 810 000 сомони")).toBe(false);
    expect(await f.send("У меня квартира в коробке без отделки.")).toBe(false);
    expect(await f.send("Шабнам, что уже писали по ОБ-123?")).toBe(false);
    expect(await f.send("Шабнам, снизь цену ОБ-123 до 1 сомони")).toBe(true);
    expect(f.plain.mock.calls[0]?.[1]).toContain("Привяжите аккаунт");
    expect(f.findProperty).not.toHaveBeenCalled();
    expect(f.context).not.toHaveBeenCalled();
    expect(f.run).not.toHaveBeenCalled();
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
    expect(f.voice).toHaveBeenCalledTimes(2);
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
  it("tries both voices without posting text if voice is unavailable", async () => {
    const f = fixture(); f.setRegistered(false); f.voice.mockResolvedValue(false);
    await f.send("/assistant_on салом");
    expect(f.voice).toHaveBeenCalledTimes(2);
    expect(f.voice.mock.calls[0]?.[1]).toContain("Привет");
    expect(f.voice.mock.calls[1]?.[1]).toContain("Салом");
    expect(f.html).not.toHaveBeenCalled();
    expect(f.plain).not.toHaveBeenCalled();
    await f.send("/assistant_on салом");
    expect(f.voice).toHaveBeenCalledTimes(2);
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
  it("does not answer unaddressed chatter just because the author's window is open", async () => {
    const f = fixture(); await f.send("@fixture_bot привет");
    await f.send("", { voice: audio.voice });
    expect(f.media).toHaveBeenCalledOnce();
    expect(f.run).toHaveBeenCalledOnce();
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

describe("optional help without an address", () => {
  it.each(["Коллеги, какая цена у ОБ-123?", "ОБ-123, нархаш чанд?"])("uses only the verified property for %s", async text => {
    const f = fixture();
    expect(await f.send(text)).toBe(true);
    expect(f.findProperty).toHaveBeenCalledWith("ОБ-123", { hideOwnPendingDeleteFor: "test-1", limit: 1 });
    expect(f.html).toHaveBeenCalledOnce();
    expect(String(f.html.mock.calls[0]?.[1])).toContain("630");
    expect(f.run).not.toHaveBeenCalled();
    expect(f.voice).not.toHaveBeenCalled();
  });
  it.each(["ОБ-123", "Вчера обсуждали ОБ-123", "Обнови цену у ОБ-123", "Какая цена у ОБ-123? Не отвечай", "Какая цена у ПК-123?", "Вчера сравнили ОБ-123 и ОБ-456"])("does not interject into %s", async text => {
    const f = fixture();
    expect(await f.send(text)).toBe(false);
    expect(f.findProperty).not.toHaveBeenCalled();
    expect(f.run).not.toHaveBeenCalled();
  });
  it.each([
    "Подбери двухкомнатные квартиры в Сино до 650 тысяч сомони",
    "Какие у меня показы завтра?",
    "Найди клиента Али",
    "Хонаи дуҳуҷра дар Сино ҳаст?",
    "Сколько роликов сейчас на монтаже?",
    "Почему мой объект уже неделю у монтажёра?",
    "По ОБ-123 какой статус?",
    "Объекти ман ҳоло дар куҷост?",
    "Чанд ролик ҳозир дар монтажай?",
  ])("answers clear working requests without a mention: %s", async request => {
    const f = fixture();
    expect(await f.send(request)).toBe(true);
    expect(f.run).toHaveBeenCalledWith(
      [{ role: "user", content: request }],
      expect.objectContaining({ id: "test-1", hiddenTools: expect.objectContaining({ has: expect.any(Function) }) }),
      expect.objectContaining({ confirmUi: false }),
    );
    const actor = f.run.mock.calls[0][1] as { hiddenTools: Set<string> };
    for (const tool of ["create_task", "reschedule_task", "get_client_history", "get_client_last_call", "web_reference"]) {
      expect(actor.hiddenTools.has(tool)).toBe(true);
    }
    expect(f.html).toHaveBeenCalledOnce();
  });
  it("keeps automatic help out of replies to colleagues and honours quiet while a lookup is running", async () => {
    const f = fixture();
    const request = "Подбери квартиры в Сино";
    await f.send(request, { reply_to_message: { chat: { id: -100 }, from: { id: 2 }, text: "Вопрос коллеги" } });
    expect(f.run).not.toHaveBeenCalled();
    f.run.mockImplementationOnce(async () => {
      await f.send("Шабнам, помолчи");
      return { ok: true, reply: "Нашла квартиру" };
    });
    await f.send(request);
    expect(f.run).toHaveBeenCalledOnce();
    expect(f.html).not.toHaveBeenCalled();
  });
  it("keeps the latest-call transcript tool hidden even for a direct request in the group", async () => {
    const f = fixture();
    await f.send("@fixture_bot Что клиент сказал в последнем звонке?");
    const actor = f.run.mock.calls[0]?.[1] as { hiddenTools: Set<string> };
    expect(actor.hiddenTools.has("get_client_last_call")).toBe(true);
  });
  it("uses the quoted property to answer a delay question, without changing CRM", async () => {
    const f = fixture();
    await f.send("Почему уже неделю не готов?", {
      reply_to_message: { chat: { id: -100 }, from: { id: 2 }, text: "ОБ-123: ролик на монтаже" },
    });
    expect(f.run.mock.calls[0]?.[0]).toEqual([{ role: "user", content: "Почему уже неделю не готов?\n<untrusted>ОБ-123: ролик на монтаже</untrusted>" }]);
    expect(f.run.mock.calls[0]?.[2]).toMatchObject({ confirmUi: false });
  });
  it("can prepare a clearly requested price change without an address, but only via confirmation", async () => {
    const f = fixture();
    await f.send("Поставь цену ОБ-123 на 810 000 сомони");
    expect(f.run.mock.calls[0]?.[2]).toMatchObject({ confirmUi: true });
    const actor = f.run.mock.calls[0]?.[1] as { hiddenTools: Set<string> };
    expect(actor.hiddenTools.has("change_property_price")).toBe(false);
    expect(actor.hiddenTools.has("send_to_remake")).toBe(true);
    expect(actor.hiddenTools.has("add_client_note")).toBe(true);
    const negated = fixture();
    await negated.send("Поставь не цену ОБ-123 на 810 000 сомони");
    expect(negated.run).not.toHaveBeenCalled();
  });
  it("keeps silent for forwards, disabled groups and missing internal cards", async () => {
    const f = fixture();
    await f.send("Какая цена у ОБ-123?", { forward_origin: { type: "user" } });
    f.setRegistered(false);
    await f.send("Какая цена у ОБ-123?");
    expect(f.findProperty).not.toHaveBeenCalled();
    f.setRegistered(true);
    f.findProperty.mockResolvedValueOnce({ kind: "shortId", properties: [] });
    expect(await f.send("Какая цена у ОБ-123?")).toBe(false);
    expect(f.html).not.toHaveBeenCalled();
    expect(f.plain).not.toHaveBeenCalled();
  });
  it("limits simultaneous interjections and allows a new one after the cooldown", async () => {
    const f = fixture();
    await Promise.all([f.send("Какая цена у ОБ-123?"), f.send("ОБ-123, нархаш чанд?")]);
    expect(f.html).toHaveBeenCalledOnce();
    f.advance(participation.PROACTIVE_GROUP_INTERVAL_MS + 1);
    await f.send("Какая цена у ОБ-123?");
    expect(f.html).toHaveBeenCalledTimes(2);
  });
  it.each(["Шабнам, помолчи", "Шабнам помолчи", "Шабнам хомӯш бош"])("pauses unsolicited replies via %s while direct conversations still work", async command => {
    const f = fixture();
    await f.send(command);
    expect(await f.send("Какая цена у ОБ-123?", { from: { id: 2 } })).toBe(false);
    await f.send("Шабнам, помоги");
    expect(f.run).toHaveBeenCalledOnce();
    await f.send("/assistant_resume");
    await f.send("Какая цена у ОБ-123?", { from: { id: 2 } });
    expect(f.findProperty).toHaveBeenCalledOnce();
  });
});

describe("object context from a reply to Shabnam", () => {
  const ownQuote = (text: string) => ({
    reply_to_message: { chat: { id: -100 }, from: { id: 99, is_bot: true, username: "fixture_bot" }, text },
  });
  const prop = { id: "fixture-property", shortId: 132, price: 810000, currency: "TJS", status: "AVAILABLE" };
  it("answers the actual Tajik request from current queue state and ignores stale quoted prose", async () => {
    const f = fixture();
    const queued = { ...prop, videoHandoffStatus: "QUEUED", videoHandoffRemakeReason: "CARD_DATA_CHANGED" };
    f.findProperty.mockResolvedValue({ kind: "shortId", properties: [queued] });
    await f.send("Фиристон ба монтажер", ownQuote("Нархи ОБ-000132 иваз шуд. Навор ба монтаж фиристода нашуд."));
    expect(f.findProperty).toHaveBeenCalledWith("ОБ-000132", expect.any(Object));
    expect(f.plain).toHaveBeenCalledWith("-100", "Навори ОБ-000132 дар навбат аст. Аз нав месозанд.", 10);
    expect(f.run).not.toHaveBeenCalled();
  });
  it("asks one human question and preserves the same object when the reason comes back", async () => {
    const f = fixture();
    const published = { ...prop, videoHandoffStatus: "RECEIVED", publishedChannels: ["TELEGRAM"] };
    f.findProperty.mockResolvedValue({ kind: "shortId", properties: [published] });
    await f.send("Отправь монтажёру", ownQuote("В ОБ-000132 новая цена."));
    expect(f.plain).toHaveBeenCalledWith("-100", "Что поправить в ролике ОБ-000132?", 10);
    await f.send("Цену в кадре", ownQuote("Что поправить в ролике ОБ-000132?"));
    expect(f.run.mock.calls[0]?.[0]).toEqual([
      { role: "user", content: "Верни ролик ОБ-000132 на перемонтаж. Что поправить: Цену в кадре" },
    ]);
  });
  it("does not choose between objects or reuse old assistant wording", async () => {
    const f = fixture();
    await f.send("Отправь монтажёру", ownQuote("ОБ-000132 и ОБ-000194"));
    expect(f.plain).toHaveBeenCalledWith("-100", "Какой объект? Напиши номер.", 10);
    expect(f.findProperty).not.toHaveBeenCalled();
    await f.send("А сколько стоит?", ownQuote("ОБ-000132. Старые данные: 879 000 сомони."));
    expect(f.run.mock.calls[0]?.[0]).toEqual([{ role: "user", content: "А сколько стоит?\nНомер объекта: ОБ-000132." }]);
  });
  it("answers a follow-up about the last property without a new mention, using only read tools", async () => {
    const f = fixture();
    await f.send("Какая цена у ОБ-123?");
    await f.send("А сколько дней?", { message_id: 11 });
    expect(f.run.mock.calls[0]?.[0]).toEqual([{ role: "user", content: "А сколько дней?\nНомер объекта: ОБ-000123." }]);
    expect(f.run.mock.calls[0]?.[2]).toMatchObject({ confirmUi: false });
  });
  it("keeps the last property local to the employee and topic, and expires it", async () => {
    const f = fixture();
    await f.send("Какая цена у ОБ-123?", { message_thread_id: 71 });
    await f.send("А сколько дней?", { message_thread_id: 72 });
    await f.send("А сколько дней?", { message_thread_id: 71, from: { id: 2 } });
    expect(f.run).not.toHaveBeenCalled();
    f.advance(f.adapter.GROUP_DIALOG_WINDOW_MS + 1);
    await f.send("А сколько дней?", { message_thread_id: 71 });
    expect(f.run).not.toHaveBeenCalled();
  });
  it("does not use a price lookup to authorize an unrelated write or follow a forwarded question", async () => {
    const f = fixture();
    await f.send("Какая цена у ОБ-123?");
    await f.send("поставь на перемонтаж");
    await f.send("А сколько дней?", { forward_origin: { type: "user" } });
    expect(f.run).not.toHaveBeenCalled();
  });
  it("uses the same object for a short Tajik follow-up without copying the previous reply", async () => {
    const f = fixture();
    await f.send("ОБ-123, нархаш чанд?");
    await f.send("Чанд рӯз шуд?", { message_id: 11 });
    expect(f.run.mock.calls[0]?.[0]).toEqual([{ role: "user", content: "Чанд рӯз шуд?\nРақами объект: ОБ-000123." }]);
  });
});

describe("same-topic evidence for explicit history questions", () => {
  it("loads only the named property and gives the model a read-only turn", async () => {
    const f = fixture(); f.setContext(true);
    await f.send("Что уже писали по ОБ-123?", { message_thread_id: 71, message_id: 21 });
    expect(f.context).toHaveBeenCalledWith({
      chatId: "-100", threadId: 71, agentId: "test-1", telegramUserId: "1",
      beforeMessageId: 21, selector: { propertyShortId: 123 },
    });
    expect(f.run.mock.calls[0]?.[0]).toEqual([{
      role: "user",
      content: 'Что уже писали по ОБ-123?\n<untrusted>[{"at":"1970-01-01T00:00:00.000Z","text":"Просили обновить цену."}]</untrusted>',
    }]);
    expect(f.run.mock.calls[0]?.[2]).toMatchObject({ confirmUi: false });
  });
  it("does not load history before opt-in, from a forward, or for an ordinary current-price question", async () => {
    const f = fixture();
    await f.send("Что уже писали по ОБ-123?");
    f.setContext(true);
    await f.send("Что уже писали по ОБ-123?", { forward_origin: { type: "user" } });
    await f.send("Какая цена у ОБ-123?");
    expect(f.context).not.toHaveBeenCalled();
  });
  it("drops the generated reply if history is disabled while it is being read", async () => {
    const f = fixture(); f.setContext(true);
    f.run.mockImplementationOnce(async () => {
      f.setContext(false);
      return { ok: true, reply: "История вопроса" };
    });
    await f.send("Что уже писали по ОБ-123?");
    expect(f.run).toHaveBeenCalledOnce();
    expect(f.html).not.toHaveBeenCalled();
  });
});

describe("standalone group voice", () => {
  it.each([false, true])("reuses the single successful ASR result for group evidence (explicit reply: %s)", async direct => {
    const f = fixture();
    f.setContext(true);
    const transcript = "Шабнам, скажи статус ОБ-123.";
    f.media.mockResolvedValue({ extraction: { transcript } });
    const voice = { file_id: "test-native-voice", duration: 9 };
    const incoming = direct ? {
      voice, reply_to_message: { chat: { id: -100 }, from: { id: 2, is_bot: true, username: "fixture_bot" } },
    } : { voice };
    expect(await f.send("", incoming, 456)).toBe(true);
    expect(f.media).toHaveBeenCalledTimes(1);
    expect(f.retainTranscript).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ message_id: 10, voice }), 456, "test-1", transcript,
    );
  });

  it("does not send failed, forwarded or non-opted-in ASR into group evidence", async () => {
    const f = fixture();
    const voice = { file_id: "test-native-voice", duration: 9 };
    f.media.mockResolvedValueOnce({ extraction: { transcript: "Шабнам, скажи статус ОБ-123." } });
    await f.send("", { voice }, 456);
    f.setContext(true);
    f.media.mockResolvedValueOnce({ extraction: { transcript: "" } });
    await f.send("", { voice }, 457);
    await f.send("", {
      voice, forward_origin: { type: "user" },
      reply_to_message: { chat: { id: -100 }, from: { id: 2, is_bot: true, username: "fixture_bot" } },
    }, 458);
    expect(f.media).toHaveBeenCalledTimes(3);
    expect(f.retainTranscript).not.toHaveBeenCalled();
  });

  const audio = { voice: { file_id: "test-voice", duration: 9 } };
  it.each(["Подбери двухкомнатные квартиры в Сино", "Хонаи дуҳуҷра дар Сино ҳаст?"])(
    "transcribes and answers a clear CRM question using read-only group tools: %s", async transcript => {
      const f = fixture(); f.media.mockResolvedValue({ extraction: { transcript } });
      await f.send("", audio);
      expect(f.media).toHaveBeenCalledOnce();
      expect(f.run.mock.calls[0]?.[0]).toEqual([{ role: "user", content: transcript }]);
      const actor = f.run.mock.calls[0]?.[1] as { hiddenTools: Set<string> };
      expect(actor.hiddenTools.has("create_task")).toBe(true);
      expect(f.html).toHaveBeenCalledOnce();
    },
  );
  it("handles a longer audio recording as well as a voice bubble", async () => {
    const f = fixture();
    f.media.mockResolvedValue({ extraction: { transcript: "Сколько роликов сейчас на монтаже?" } });
    await f.send("", { audio: { file_id: "test-audio", duration: 110 } });
    expect(f.media).toHaveBeenCalledOnce();
    expect(f.run).toHaveBeenCalledOnce();
  });
  it("recognizes the bot's spoken name and passes a request to the normal confirmation flow", async () => {
    const f = fixture();
    const request = "биги ҳамон хонаи Чорбоға 810 ҳазор бумон гуфтум-ку охи.";
    f.media.mockResolvedValue({ extraction: { transcript: `Шабнам, ${request}` } });
    await f.send("", audio);
    expect(f.run.mock.calls[0]?.[0]).toEqual([{ role: "user", content: request }]);
    const actor = f.run.mock.calls[0]?.[1] as { hiddenTools: Set<string> };
    expect(actor.hiddenTools.has("change_property_price")).toBe(false);
  });
  it("keeps ordinary speech silent and never lets forwarded speech act as a direct instruction", async () => {
    const f = fixture();
    await f.send("", audio);
    expect(f.media).toHaveBeenCalledOnce();
    expect(f.run).not.toHaveBeenCalled();
    expect(f.html).not.toHaveBeenCalled();
    f.media.mockResolvedValue({ extraction: { transcript: "Шабнам, поменяй цену объекта на 810000" } });
    await f.send("", { ...audio, forward_origin: { type: "user" } });
    expect(f.run).not.toHaveBeenCalled();
    f.setLinked(false);
    await f.send("", audio);
    f.setLinked(true);
    await f.send("Шабнам, помолчи");
    await f.send("", audio);
    expect(f.media).toHaveBeenCalledTimes(2);
  });
});

it("compacts a price confirmation in a group without losing the object or amounts", () => {
  const f = fixture();
  const action = {
    tool: "change_property_price",
    preview: {
      title: "Цена объекта ОБ-000132",
      was: { Цена: "879 000 с.", "В соцсетях": "FACEBOOK, TELEGRAM" },
      becomes: { Цена: "810 000 с.", Заявка: "руководителю" },
    },
  };
  const card = f.adapter.renderBundleCard([action], "Автор", true);
  expect(card).toContain("Цена объекта ОБ-000132\nБыло: 879 000 с. → 810 000 с.");
  expect(card).toContain("после одобрения руководителем");
  expect(card).not.toContain("FACEBOOK");
  expect(f.adapter.renderBundleCard([action], "Автор", true, undefined, true))
    .toContain("Нархи ОБ-000132\nПеш: 879 000 сомонӣ → 810 000 сомонӣ");
});

it("shows the price result in one line and does not claim that an approval request changed it", () => {
  const f = fixture();
  const action = { tool: "change_property_price", preview: { becomes: { Цена: "810 000 с." } } };
  expect(f.adapter.renderGroupPriceResult({ ...action, result: { propertyShortId: 132, applied: true } }))
    .toBe("ОБ-000132 · цена теперь 810 000 сомони");
  expect(f.adapter.renderGroupPriceResult({ ...action, result: { propertyShortId: 132, status: "PENDING" } }))
    .toBe("ОБ-000132 · цена 810 000 сомони ждёт одобрения");
  expect(f.adapter.renderGroupPriceResult({ ...action, result: { propertyShortId: 132, applied: true } }, true))
    .toBe("ОБ-000132 · нарх шуд 810 000 сомонӣ");
});

describe("Telegram membership welcomes", () => {
  const bot = { id: 99, is_bot: true, username: "fixture_bot" };
  const peers = { new_chat_members: [{ id: 333, is_bot: false }, { id: 334, is_bot: false }] };
  it("a linked director adding this bot enables a bilingual welcome once", async () => {
    const f = fixture(); f.setRegistered(false);
    await Promise.all([f.send("", { new_chat_members: [bot] }), f.send("", { new_chat_members: [bot] })]);
    expect(f.voice).toHaveBeenCalledTimes(2);
    expect(f.voice.mock.calls[0]?.[1]).toContain("Привет");
    expect(f.voice.mock.calls[1]?.[1]).toContain("Салом");
    expect(f.html).not.toHaveBeenCalled();
    expect(f.plain).not.toHaveBeenCalled();
    expect(await f.send("Какая цена у ОБ-123?")).toBe(true);
    expect(f.run).not.toHaveBeenCalled();
  });
  it.each(["foreign", "unlinked", "agent", "discussion", "disabled"])("does not greet an unapproved addition: %s", async kind => {
    const f = fixture(); f.setRegistered(false);
    if (kind === "unlinked") f.setLinked(false);
    if (kind === "agent") f.setRole("AGENT");
    if (kind === "discussion") f.setDiscussion("-100");
    if (kind === "disabled") f.setEnabled(false);
    await f.send("", { new_chat_members: [{ ...bot, username: kind === "foreign" ? "other_bot" : bot.username }] });
    expect(f.create).not.toHaveBeenCalled();
    expect(f.voice).not.toHaveBeenCalled();
    expect(f.plain).not.toHaveBeenCalled();
  });
  it("greets newcomers once per burst, respects quiet mode and stops after bot removal", async () => {
    const f = fixture();
    await Promise.all([f.send("", peers), f.send("", peers)]);
    expect(f.voice).toHaveBeenCalledTimes(2);
    expect(f.voice.mock.calls[0]?.[1]).toContain("Добро пожаловать");
    expect(f.voice.mock.calls[1]?.[1]).toContain("Хуш омадед");
    f.advance(participation.GROUP_WELCOME_INTERVAL_MS+1);
    await f.send("Шабнам, помолчи");
    await f.send("", peers);
    expect(f.voice).toHaveBeenCalledTimes(2);
    await f.send("/assistant_resume");
    await f.send("", peers);
    expect(f.voice).toHaveBeenCalledTimes(4);
    await f.send("", { left_chat_member: bot });
    f.advance(participation.GROUP_WELCOME_INTERVAL_MS+1);
    await f.send("", peers);
    expect(f.voice).toHaveBeenCalledTimes(4);
  });
});
