import * as participation from "../src/telegram/assistantGroupParticipation.js";
import { STAFF_TOOL_NAMES } from "../src/ai/assistant/tools/staffToolNames.js";
import * as publicListings from "../src/telegram/assistantGroupPublicListing.js";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import ts from "typescript";
import * as shared from "@royal-home/shared";
import { describe, expect, it, vi } from "vitest";

vi.mock("../src/db.js", () => ({ prisma: { $disconnect: async () => {} } }));

/** Actual handler with inert persistence/provider/action boundaries. No Telegram sends. */
function fixture(type: "group" | "supergroup" | "private" = "supergroup") {
  let now = 1000;
  let group: { chatId: string; createdAt: Date } | null = { chatId: "-100", createdAt: new Date(now) };
  let active = true;
  let enabled = true;
  const actions = [{ id: "test-action", agentId: "test-author", createdAt: new Date(2000),
    status: "PENDING", expiresAt: new Date(Date.now() + 10 * 60_000) }];
  const answer = vi.fn(async () => {});
  const edit = vi.fn(async () => {});
  const confirm = vi.fn(async () => ({ action: { preview: { title: "Fixture action" } }, replay: false }));
  const cancel = vi.fn(async () => {});
  const groupRead = vi.fn(async () => group);
  const groupCreate = vi.fn(async (input: { skipDuplicates: boolean }) => {
    expect(input.skipDuplicates).toBe(true);
    const count = group ? 0 : 1;
    if (!group) group = { chatId: "-100", createdAt: new Date(now) };
    return { count };
  });
  const db = {
    settings: { findUnique: async () => ({ telegramDiscussionGroupId: null }) },
    assistantTelegramGroup: { findUnique: groupRead, createMany: groupCreate, deleteMany: async () => { group = null; return { count: 1 }; } },
    assistantAction: { findMany: async () => actions, count: async () => 0 },
  };
  const noop = async () => {};
  class ActionError extends Error {}
  const dependencies: Record<string, unknown> = {
    "../db.js": { prisma: db },
    // Сотрудники и права (10.11.2026): список имён — настоящий, код Google Authenticator — инертная заглушка.
    "../ai/assistant/tools/staffToolNames.js": { STAFF_TOOL_NAMES },
    "./assistantStepUp.js": { bundleNeedsStepUp: () => false, cancelStepUpForBundle: async () => {} },
    "./api.js": { getBotUsername: async () => "fixture_bot", sendMessage: noop, editMessageText: noop, answerCallbackQuery: answer },
    // Константы модуля (потолок очереди помощницы) читаются при загрузке — общий пакет целиком.
    "@royal-home/shared": { ...shared, isReadOnlyRole: (role: string) => role === "SHAREHOLDER" },
    "../auth/middleware.js": { loadAgentAccess: async (id: string) => ({ isActive: active, role: id === "test-director" ? "DIRECTOR" : "AGENT", permissions: new Set() }) },
    "../lib/telegramAgentLink.js": { findAgentByTelegramUserId: async (id: string) => ({ id: id === "10" ? "test-director" : id === "1" ? "test-author" : "test-other", fullName: "Fixture" }) },
    "../ai/assistant.js": { isAiAssistantEnabled: async () => enabled },
    "./assistantPropertyDraft.js": { handleTelegramPropertyDraftCallback: async () => false },
    "../lib/telegramModeration.js": { claimCallback: async () => true },
    "../lib/assistantActions.js": { AssistantActionError: ActionError, confirmAssistantAction: confirm, discardPendingAssistantAction: cancel },
    "./assistantReply.js": { sanitizeAssistantReply: (text: string) => text },
    "./assistantDelivery.js": { sendAssistantReply: async () => true },
    "./assistantConfirmationPhotos.js": { editTelegramConfirmationMessage: edit },
    "./assistantGroupParticipation.js": participation,
    "./assistantGroupPublicListing.js": publicListings,
    "./assistantPropertyPages.js": { propertyPageRequest: () => null },
    "./assistantGroupPhrases.js": { ASSISTANT_GROUP_GREETING: { ru: "Fixture greeting" } },
    "../ai/assistant/languageRouting.js": { assistantLanguage: () => "unknown" },
    "../lib/systemError.js": { logSystemError: noop },
    "../lib/describeError.js": { describeError: () => "fixture database failure" },
  };
  const source = readFileSync(new URL("../src/telegram/assistantBot.ts", import.meta.url), "utf8");
  const exports: Record<string, any> = {};
  runInNewContext(ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022,
    module: ts.ModuleKind.CommonJS } }).outputText, { exports, require: (name: string) => dependencies[name] ?? {}, Date, Map, Set, Promise, console });
  const query = (verb = "ok", userId = 1) => ({ id: "test-callback", data: `as:${verb}:11111111-1111-4111-8111-111111111111`,
    from: { id: userId }, message: { chat: { id: type === "private" ? 1 : -100, type }, message_id: 50 } });
  const toggle = async (on: boolean) => exports.handleAssistantGroupMessage({
    chat: { id: -100, type: "supergroup" }, from: { id: 10 }, message_id: 51,
    text: `/assistant_${on ? "on" : "off"}@fixture_bot`,
  });
  return { confirm, cancel, answer, edit, groupRead, groupCreate, actions, ActionError,
    press: (verb = "ok", userId = 1) => exports.handleAssistantCallback(query(verb, userId)), toggle,
    setNow: (time: number) => { now = time; }, setActive: (value: boolean) => { active = value; },
    setEnabled: (value: boolean) => { enabled = value; }, group: () => group };
}

describe("assistant Telegram group callback registration gate", () => {
  it("keeps the confirmation and following actions available after a retryable database failure", async () => {
    const f = fixture("private");
    f.actions.push({ ...f.actions[0], id: "following-action" });
    const failure = Object.assign(new f.ActionError("Нажмите ещё раз"), { code: "CONFIRM_RETRY" });
    f.confirm.mockRejectedValueOnce(failure);
    await f.press();
    expect(f.answer).toHaveBeenLastCalledWith("test-callback", failure.message);
    expect(f.confirm).toHaveBeenCalledTimes(1);
    expect(f.cancel).not.toHaveBeenCalled();
    expect(f.edit).not.toHaveBeenCalled();

    await f.press();
    expect(f.confirm).toHaveBeenCalledTimes(3);
    expect(f.answer).toHaveBeenLastCalledWith("test-callback", "Готово");
    expect(f.edit).toHaveBeenCalledOnce();
  });

  it.each(["group", "supergroup"] as const)("%s off blocks both confirm and cancel before broker", async type => {
    const f = fixture(type);
    await f.toggle(false);
    await f.press();
    await f.press("no");
    expect(f.confirm).not.toHaveBeenCalled();
    expect(f.cancel).not.toHaveBeenCalled();
    expect(f.answer).toHaveBeenLastCalledWith("test-callback", expect.stringContaining("отключён"));
  });

  it("private callbacks do not require or read a group registration", async () => {
    const f = fixture("private");
    f.groupRead.mockRejectedValue(new Error("must not query group for private chat"));
    await f.press();
    expect(f.confirm).toHaveBeenCalledOnce();
    expect(f.groupRead).not.toHaveBeenCalled();
  });

  it("a database read error fails closed before confirm/cancel", async () => {
    const f = fixture();
    f.groupRead.mockRejectedValue(new Error("fixture database failure"));
    await f.press();
    await f.press("no");
    expect(f.confirm).not.toHaveBeenCalled();
    expect(f.cancel).not.toHaveBeenCalled();
  });

  it("off then on rejects old cards and allows a newly created one", async () => {
    const f = fixture();
    await f.toggle(false);
    f.setNow(3000);
    await f.toggle(true);
    await f.press();
    expect(f.confirm).not.toHaveBeenCalled();
    expect(f.answer).toHaveBeenLastCalledWith("test-callback", expect.stringContaining("заново"));
    f.actions[0]!.createdAt = new Date(4000);
    await f.press();
    expect(f.confirm).toHaveBeenCalledOnce();
  });

  it("same-timestamp cards fail closed across a registration boundary", async () => {
    const f = fixture();
    f.actions[0]!.createdAt = new Date(1000);
    await f.press();
    expect(f.confirm).not.toHaveBeenCalled();
  });

  it("the same request reusing an old pending row reports its remaining expiry after re-enable", async () => {
    const f = fixture();
    await f.toggle(false);
    f.setNow(3000);
    await f.toggle(true);
    // The broker's idempotency window can return the same row for a new card.
    f.actions[0]!.expiresAt = new Date(Date.now() + 125_000);
    await f.press();
    expect(f.confirm).not.toHaveBeenCalled();
    expect(f.cancel).not.toHaveBeenCalled();
    expect(f.answer).toHaveBeenLastCalledWith("test-callback", expect.stringContaining("через 3 мин."));
    f.actions[0]!.createdAt = new Date(4000); // A genuinely fresh row is allowed.
    await f.press();
    expect(f.confirm).toHaveBeenCalledOnce();
  });

  it("an expired old row tells the author to retry without an unnecessary wait", async () => {
    const f = fixture();
    f.actions[0]!.createdAt = new Date(500);
    f.actions[0]!.expiresAt = new Date(Date.now() - 1000);
    await f.press();
    expect(f.confirm).not.toHaveBeenCalled();
    expect(f.answer).toHaveBeenLastCalledWith("test-callback", "Группа подключена заново — повторите просьбу");
  });

  it("repeating on while enabled preserves the registration and valid cards", async () => {
    const f = fixture();
    f.setNow(5000);
    await f.toggle(true);
    expect(f.group()!.createdAt.getTime()).toBe(1000);
    await f.press();
    expect(f.confirm).toHaveBeenCalledOnce();
  });

  it("foreign author, inactive author and global disabled still cannot execute", async () => {
    const f = fixture();
    await f.press("ok", 2);
    f.setActive(false);
    await f.press();
    f.setActive(true);
    f.setEnabled(false);
    await f.press();
    expect(f.confirm).not.toHaveBeenCalled();
    expect(f.groupRead).not.toHaveBeenCalled();
  });

  it.each(["ok", "no"])("a queued %s click rechecks registration after waiting for the running broker", async verb => {
    const f = fixture();
    let release!: () => void;
    const held = new Promise<void>(resolve => { release = resolve; });
    f.confirm.mockImplementationOnce(async () => {
      await held;
      return { action: { preview: { title: "Fixture action" } }, replay: false };
    });
    const running = f.press();
    await vi.waitFor(() => expect(f.confirm).toHaveBeenCalledOnce());
    const queued = f.press(verb);
    // Drain asynchronous author/access lookups until the second click is queued.
    for (let i = 0; i < 20; i++) await Promise.resolve();
    await f.toggle(false);
    release();
    await Promise.all([running, queued]);
    expect(f.confirm).toHaveBeenCalledOnce(); // Already running operation may finish.
    expect(f.cancel).not.toHaveBeenCalled();
    expect(f.answer).toHaveBeenLastCalledWith("test-callback", expect.stringContaining("отключён"));
  });
});
