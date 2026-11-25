import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Один ответ на одно сообщение (24.11.2026). Журнал прода: «Ассистент CRM: срыв (stream_interrupted)
 * после находок — отдан частичный ответ», сотрудник получил частичный ответ, а через 27 секунд полный.
 * Механизм: поллер Telegram не подтверждает апдейт, пока ход не закончен (telegram/poller.ts), а при
 * перезапуске/сбое отметка «в работе» сбрасывается — тот же апдейт приходит снова, и ход идёт заново
 * поверх уже отправленного ответа. Записи от повтора защищены (lib/assistantTurnWrites.ts), ответ — нет.
 * Правило: ход, на который ответ уже ушёл, второй раз не идёт — ни полный, ни частичный.
 */
const { sendMessage, sendHtmlMessage, runner, claimCap } = vi.hoisted(() => ({
  sendMessage: vi.fn(async (_chatId: string, _text: string, _reply?: number) => ({})),
  sendHtmlMessage: vi.fn(async (_chatId: string, _text: string, _reply?: number, _buttons?: unknown) => ({})),
  runner: vi.fn(),
  claimCap: vi.fn(async () => ({ allowed: true })),
}));

vi.mock("../src/telegram/api.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/telegram/api.js")>()),
  sendMessage,
  sendHtmlMessage,
  sendChatAction: vi.fn(async () => {}),
  setMessageReaction: vi.fn(async () => {}),
  getBotUsername: async () => "rh_test_bot",
}));
vi.mock("../src/telegram/assistantVoice.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/telegram/assistantVoice.js")>()),
  sendAssistantVoiceReply: vi.fn(async () => false),
}));
vi.mock("../src/ai/assistant.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/ai/assistant.js")>()),
  isAiAssistantEnabled: async () => true,
  runAssistantDetailed: runner,
}));
vi.mock("../src/lib/agentAiActionCap.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/lib/agentAiActionCap.js")>()),
  claimAgentAiAction: claimCap,
}));

delete process.env.TELEGRAM_BOT_TOKEN;

const { prisma } = await import("../src/db.js");
const { handleAssistantPrivate } = await import("../src/telegram/assistantBot.js");
const { createTestAgent } = await import("./helpers/ownAgent.js");
const { deleteAgentsWithTraces } = await import("./helpers/cleanupAgents.js");

const runId = String(Date.now()).slice(-7);
const CHAT = 800_000_000 + Number(runId);
let agent = "";
const sentTexts = () => [...sendMessage.mock.calls, ...sendHtmlMessage.mock.calls].map((c) => String(c[1]));
const message = (id: number) => ({
  message_id: id,
  date: Math.floor(Date.now() / 1000),
  chat: { id: CHAT, type: "private" as const },
  from: { id: CHAT, is_bot: false, first_name: "Тест" },
  text: "найди небольшую квартиру от цирка до автоцентра",
});

beforeAll(async () => {
  agent = await createTestAgent(`Агент повтора ${runId}`);
});
afterAll(async () => {
  await prisma.processedMessage.deleteMany({ where: { messageId: { startsWith: `tg:${CHAT}:` } } });
  await deleteAgentsWithTraces([agent]);
  await prisma.$disconnect();
});
beforeEach(() => {
  sendMessage.mockClear();
  sendHtmlMessage.mockClear();
  runner.mockReset();
});

describe("повторная доставка того же сообщения помощнице", () => {
  it("частичный ответ ушёл — повтор хода не даёт второго ответа", async () => {
    runner
      .mockResolvedValueOnce({ ok: true, reply: "Нашла несколько вариантов (частично). Уточните вопрос." })
      .mockResolvedValueOnce({ ok: true, reply: "Полный ответ про квартиры от цирка до автоцентра." });
    const msg = message(9001);
    await handleAssistantPrivate(msg as never, { id: agent, fullName: "Тест" });
    await handleAssistantPrivate({ ...msg } as never, { id: agent, fullName: "Тест" });
    expect(runner).toHaveBeenCalledTimes(1);
    const texts = sentTexts().filter((t) => /вариант|квартир/u.test(t));
    expect(texts).toHaveLength(1);
  });

  it("другое сообщение того же человека — отдельный ход, как и раньше", async () => {
    runner.mockResolvedValue({ ok: true, reply: "Ответ." });
    await handleAssistantPrivate(message(9002) as never, { id: agent, fullName: "Тест" });
    await handleAssistantPrivate(message(9003) as never, { id: agent, fullName: "Тест" });
    expect(runner).toHaveBeenCalledTimes(2);
  });

  it("ответ не ушёл (ход упал) — повтор доставки отвечает заново", async () => {
    runner
      .mockResolvedValueOnce({ ok: false, code: "internal", retryable: true })
      .mockResolvedValueOnce({ ok: true, reply: "Теперь отвечаю." });
    await handleAssistantPrivate(message(9004) as never, { id: agent, fullName: "Тест" });
    await handleAssistantPrivate(message(9004) as never, { id: agent, fullName: "Тест" });
    expect(runner).toHaveBeenCalledTimes(2);
    expect(sentTexts().some((t) => t.includes("Теперь отвечаю"))).toBe(true);
  });
});
