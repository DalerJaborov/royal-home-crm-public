import { readFileSync } from "node:fs";
import { STAFF_TOOL_NAMES } from "../src/ai/assistant/tools/staffToolNames.js";
import { runInNewContext } from "node:vm";
import ts from "typescript";
import * as shared from "@royal-home/shared";
import * as zod from "zod";
import { expect, it, vi } from "vitest";
import * as reply from "../src/telegram/assistantReply.js";

const source = readFileSync(new URL("../src/telegram/assistantReadResults.ts", import.meta.url), "utf8");
const compiled = ts.transpileModule(source, {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
}).outputText;

function fixture(failOnCall = 0) {
  const spoken: string[] = [];
  const voice = vi.fn(async (
    _chatId: string, part: string, _replyTo?: number, language?: reply.AssistantSpeechLanguage,
  ) => {
    const plan = reply.prepareAssistantReply(part, false, language);
    if (voice.mock.calls.length === failOnCall || plan.language === "text-only" || plan.speech.length < 3) return false;
    spoken.push(plan.speech);
    return true;
  });
  const delivery = {} as typeof import("../src/telegram/assistantReadResults.js");
  const dependencies: Record<string, unknown> = {
    zod,
    "./assistantReply.js": reply,
    "./assistantVoice.js": { sendAssistantVoiceReply: voice },
  };
  runInNewContext(compiled, { exports: delivery, require: (name: string) => dependencies[name] ?? {} });
  return { delivery, spoken, voice, replay: (text: string) => delivery.replayTelegramAssistantVoice("test-chat", text, 23) };
}

it.each([
  ["Хорошо, давайте обсудим план.", "Последний пункт тоже важен."],
  ["Хуб, биёед имрӯз ҳамаро оромона бинем.", "Гапи охир ҳам муҳим аст."],
])("reads the end of a long single paragraph in short clips: %s", async (sentence, last) => {
  const f = fixture();
  const input = [...Array(12).fill(sentence), last].join(" ");
  expect(input.length).toBeGreaterThan(reply.VOICE_MAX_CHARS);
  expect(await f.replay(input)).toBe(true);
  expect(f.voice.mock.calls.length).toBeGreaterThan(1);
  expect(f.spoken.join(" ")).toBe(input);
  expect(f.voice.mock.calls[0]?.[2]).toBe(23);
  expect(f.voice.mock.calls.slice(1).every(call => call[2] === undefined)).toBe(true);
});

it("keeps all written parts in order, skipping blank chunks", async () => {
  const f = fixture();
  expect(await f.replay("  Готово.  |||  \n\n   Нашла.  \n\n Сначала " + " ".repeat(500) + "проверь карточку.  ")).toBe(true);
  expect(f.spoken).toEqual(["Готово.", "Нашла.", "Сначала проверь карточку."]);
});

it.each(["  \r\n   ||| ", "Only unreadable words.", "Где вы, шумо дар кор?"])(
  "leaves unavailable or ambiguous speech in text: %j", async input => {
    const f = fixture();
    expect(await f.replay(input)).toBe(false);
    expect(f.voice).not.toHaveBeenCalled();
  },
);

it("does not retry the delivered first clip or read later clips after a failure", async () => {
  const f = fixture(2);
  expect(await f.replay("Готово. ||| Нашла. ||| Проверила.")).toBe(false);
  expect(f.voice).toHaveBeenCalledTimes(2);
  expect(f.spoken).toEqual(["Готово."]);
});

it("honors the four-clip limit without calling a partial replay complete", async () => {
  const f = fixture();
  expect(await f.replay("Готово. ||| Нашла. ||| Проверила. ||| Записала. ||| Сделано.")).toBe(false);
  expect(f.spoken).toEqual(["Готово.", "Нашла.", "Проверила.", "Записала."]);
});

it("rejects an overlong unsplittable word without spending voice budget", async () => {
  const f = fixture();
  expect(await f.replay("Хорошо. " + "а".repeat(500))).toBe(false);
  expect(f.spoken).toEqual(["Хорошо."]);
  expect(f.voice).toHaveBeenCalledOnce();
});

it("keeps Markdown labels and leaves links out of the spoken chunks", async () => {
  const f = fixture();
  const intro = "Хорошо, давайте обсудим план. ".repeat(6);
  const label = "важные подробности по объекту";
  const link = "https://test.invalid/properties/" + "a".repeat(200);
  expect(await f.replay(intro + "Проверьте [" + label + "](" + link + ").")).toBe(true);
  expect(f.spoken.join(" ")).toContain("Проверьте " + label + ".");
  expect(f.spoken.join(" ")).not.toContain("test.invalid");
});

it("keeps a grouped amount together at a voice split boundary", async () => {
  const f = fixture();
  const beforeAmount = "Хорошо, обсудим условия ".padEnd(176, "а");
  const input = beforeAmount + " 810 000 сомони за объект.";
  expect(await f.replay(input)).toBe(true);
  expect(f.spoken).toEqual([input]);
});

it("leaves a numeric paragraph written if Tajik number expansion makes it too long", async () => {
  const f = fixture();
  const input = "Нархаш 123456789 сомонӣ. ".repeat(7).trim();
  expect(reply.prepareAssistantReply(input).truncated).toBe(true);
  expect(await f.replay(input)).toBe(false);
  expect(f.voice).not.toHaveBeenCalled();
});

it("reports incomplete private replay without claiming a voice-only answer is already written", async () => {
  const f = fixture(2);
  const send = vi.fn(async () => ({}));
  const run = vi.fn();
  const error = vi.fn();
  const adapter = {} as typeof import("../src/telegram/assistantBot.js");
  const source = readFileSync(new URL("../src/telegram/assistantBot.ts", import.meta.url), "utf8");
  const code = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  const dependencies: Record<string, unknown> = {
    "./assistantReply.js": reply,
    "@royal-home/shared": shared,
    "./assistantPropertyDraft.js": { handleTelegramPropertyDraft: async () => false },
    // «Править текст» озвучки (11.11.2026): ожидания нет — сообщение идёт дальше обычным путём.
    "./assistantNarration.js": { handleNarrationTextReply: async () => false },
    // Ролик от сотрудника (12.11.2026): ожидания «к какому объекту» нет, видео нет.
    "./staffClip.js": { handleStaffClipText: async () => false, handleStaffClipMessage: async () => false },
    "./assistantPropertyPages.js": { propertyPageRequest: () => null },
    "./assistantExpenseCard.js": { applyExpenseFixMessage: async () => false },
    "./assistantReadResults.js": f.delivery,
    // Сотрудники и права (10.11.2026): список имён — настоящий, код Google Authenticator — инертная заглушка.
    "../ai/assistant/tools/staffToolNames.js": { STAFF_TOOL_NAMES },
    "./assistantStepUp.js": { bundleNeedsStepUp: () => false, cancelStepUpForBundle: async () => {} },
    "./api.js": { sendMessage: send },
    "../ai/assistant/moneyBudget.js": { createAssistantMoneyWallet: () => ({}) },
    "../ai/assistant.js": { isAiAssistantEnabled: async () => true, runAssistantDetailed: run },
    "../auth/middleware.js": { loadAgentAccess: async () => ({ isActive: true }) },
    "../db.js": { prisma: { telegramDialogState: { findUnique: async () => ({
      kind: "assistant", agentId: "test-agent", expiresAt: new Date(Date.now() + 60_000),
      payload: { messages: [{ role: "assistant", content: "Готово. ||| Нашла." }] },
    }) } } },
    "../lib/systemError.js": { logSystemError: error },
  };
  runInNewContext(code, { exports: adapter, require: (name: string) => dependencies[name] ?? {} });
  await adapter.handleAssistantPrivate({
    chat: { id: 123, type: "private" }, message_id: 23, text: "озвучь ответ",
  }, { id: "test-agent", fullName: "Тест" });

  expect(f.spoken).toEqual(["Готово."]);
  expect(run).not.toHaveBeenCalled();
  expect(error).not.toHaveBeenCalled();
  expect(send).toHaveBeenCalledExactlyOnceWith("123", "Не получилось озвучить ответ целиком.");
});
