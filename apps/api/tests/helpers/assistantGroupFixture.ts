import { existsSync, readFileSync } from "node:fs";
import { STAFF_TOOL_NAMES } from "../../src/ai/assistant/tools/staffToolNames.js";
import { runInNewContext } from "node:vm";
import ts from "typescript";
import { z } from "zod";
import { expect, vi } from "vitest";
import * as shared from "@royal-home/shared";
import * as replies from "../../src/telegram/assistantReply.js";
import { maskAssistantContacts } from "../../src/lib/assistantContacts.js";
import * as participation from "../../src/telegram/assistantGroupParticipation.js";
import { matchPublicShellRequest } from "../../src/telegram/assistantPublicShellSearch.js";
import { assistantLanguage } from "../../src/ai/assistant/languageRouting.js";
import type { TelegramIncomingMessage } from "../../src/telegram/api.js";

// Execute the actual adapter and delivery module; all external effects are inert.
const compiled = new Map<string, string>();
function load(name: string, dependencies: Record<string, unknown>) {
  if (!compiled.has(name)) compiled.set(name, ts.transpileModule(
    readFileSync(new URL(`../../src/telegram/${name}.ts`, import.meta.url), "utf8"),
    { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } },
  ).outputText);
  const exports: Record<string, any> = {};
  runInNewContext(compiled.get(name)!, { exports, require: (key: string) => dependencies[key] ?? {},
    Date, Map, Set, Promise, console, setInterval, clearInterval, setTimeout, clearTimeout });
  return exports;
}

export function assistantGroupFixture() {
  let registered = true, enabled = true, active = true, role = "DIRECTOR", now = 1000, registeredAt = 0;
  let mutedUntil: Date | null = null, lastProactive: Date | null = null, lastWelcome: Date | null = null, contextEnabledAt: Date | null = null, groupLinked = true, discussionGroupId: string | null = null;
  const findProperty = vi.fn(async () => ({ kind: "shortId", properties: [{ id: "fixture-property", shortId: 123, price: 630000, currency: "TJS", status: "AVAILABLE", instagramUrl: null as string | null }] }));
  const plain = vi.fn(async (..._args: unknown[]) => ({})), html = vi.fn(async (..._args: unknown[]) => ({}));
  const buttons = vi.fn((...args: unknown[]) => plain(...args));
  const confirm = vi.fn(async () => { throw new Error("Confirmation execution is outside this fixture"); });
  const voice = vi.fn(async (..._args: unknown[]) => true);
  const reaction = vi.fn(async (..._args: unknown[]) => "sent" as "sent" | "unavailable" | "uncertain");
  const indicator = vi.fn(async (..._args: unknown[]) => {});
  const run = vi.fn(async (_history: unknown, _actor: unknown, _options: unknown) => ({ ok: true, reply: "Готово." }));
  const media = vi.fn(async () => ({ extraction: { transcript: "Проверь, пожалуйста." } }));
  const context = vi.fn(async () => [{ occurredAt: new Date(0), text: "Просили обновить цену.", authorLabel: "Умед Примеров" }]);
  const retainTranscript = vi.fn(async (_message: TelegramIncomingMessage, _updateId: number, _agentId: string, _text: string) => {});
  const fast = vi.fn(async () => null as unknown);
  const workQueue = vi.fn(async (_actor: unknown, _scope: "queue") => ({
    scope: "COMPANY_QUEUE", total: 5, withEditor: 2, waitingForEditor: 1,
    items: [132, 194, 201, 210, 215].map(id => ({ code: shared.formatPropertyCode(id) })),
  }));
  const card = vi.fn(async () => true);
  const trashNote = vi.fn(async (_ref: string, _actor: unknown, _language: "ru" | "tg") => null as string | null);
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
    zod: { z },
    "./assistantReply.js": replies,
    "./assistantGroupParticipation.js": participation,
    "./assistantPublicShellSearch.js": {
      matchPublicShellRequest,
      replyPublicShellRequest: publicShellReply, readAssistantPublicSiteCatalog: publicCatalog,
    },
    "./assistantGroupContext.js": { loadAssistantTelegramContext: context, retainAssistantTelegramTranscript: retainTranscript },
    "../lib/propertyRefLookup.js": { findPropertiesByRef: findProperty },
    "../ai/assistant/tools/getPropertyWorkStatus.js": { getPropertyWorkList: workQueue },
    "./assistantVoice.js": { sendAssistantVoiceReply: voice },
    // Сотрудники и права (10.11.2026): список имён — настоящий, код Google Authenticator — инертная заглушка.
    "../ai/assistant/tools/staffToolNames.js": { STAFF_TOOL_NAMES },
    "./assistantStepUp.js": { bundleNeedsStepUp: () => false, cancelStepUpForBundle: async () => {} },
    "./api.js": { getBotUsername: async () => "fixture_bot", sendMessage: plain, sendHtmlMessage: html,
      sendMessageWithButtons: buttons, sendChatAction: indicator, setMessageReaction: reaction },
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
    "../ai/assistant.js": { isAiAssistantEnabled: async () => enabled, runAssistantDetailed: run, assistantErrorMessage: (code: string) => code },
    "../ai/assistant/tools/propertyPresenter.js": { trashedPropertyNoteFor: trashNote },
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
    "../lib/assistantActions.js": { confirmAssistantAction: confirm },
    "../lib/aiAssistantAudit.js": {
      logAssistantToolCall: async () => {},
      logAssistantTurn: async () => {},
      logAssistantFastPathTurn: async () => {},
    },
    "./assistantReadResults.js": { sendTelegramPropertyCard: card },
    "./assistantMedia.js": { handleAssistantMedia: media },
    "../lib/systemError.js": { logSystemError: async () => {} },
    "../lib/describeError.js": { describeError: (err: unknown) => String(err) },
    "../lib/shutdownState.js": { trackBackgroundTask: <T>(promise: Promise<T>) => promise },
  };
  // This module is absent from the older comparison revision.
  if (existsSync(new URL("../../src/telegram/assistantGroupPhrases.ts", import.meta.url))) {
    dependencies["./assistantGroupPhrases.js"] = load("assistantGroupPhrases", dependencies);
  }
  dependencies["./assistantGroupPublicListing.js"] = load("assistantGroupPublicListing", dependencies);
  dependencies["./assistantDelivery.js"] = load("assistantDelivery", dependencies);
  dependencies["./assistantPropertyPages.js"] = load("assistantPropertyPages", dependencies);
  const adapter = load("assistantBot", dependencies);
  // Долгий ход помощницы уходит из очереди группы (runInAssistantLane); тест ждёт и его ответ.
  const sendAndWait = async (msg: Record<string, unknown>, updateId?: number) => {
    const handled = await adapter.handleAssistantGroupMessage(msg, updateId);
    await adapter.takeDeferredAssistantReply?.(msg);
    return handled;
  };
  adapter.setGroupClockForTests(() => now);
  const message = (text = "", extra: Partial<TelegramIncomingMessage> = {}) => ({
    chat: { id: -100, type: "supergroup" }, from: { id: 1 }, message_id: 10, text, ...extra,
  });
  return { adapter, plain, html, voice, reaction, indicator, buttons, confirm, run, media, fast, workQueue, card, trashNote, create, findProperty, context, retainTranscript, publicCatalog, publicShellReply,
    setContext: (value: boolean) => { contextEnabledAt = value ? new Date(now) : null; },
    setLinked: (value: boolean) => { groupLinked = value; },
    setDiscussion: (value: string) => { discussionGroupId = value; },
    message, send: (text = "", extra: Partial<TelegramIncomingMessage> = {}, updateId?: number) =>
      sendAndWait(message(text, extra), updateId),
    setRegistered: (value: boolean) => { registered = value; }, setEnabled: (value: boolean) => { enabled = value; },
    setRole: (value: string) => { role = value; }, setActive: (value: boolean) => { active = value; },
    advance: (milliseconds: number) => { now += milliseconds; } };
}
