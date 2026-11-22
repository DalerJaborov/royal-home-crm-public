import { afterAll, beforeAll, expect, it, vi } from "vitest";
import bcrypt from "bcrypt";

/**
 * Справка о вопросах Шабнам по показам (22.11.2026) — только в запрос к модели (ревью 22.11):
 * в историю разговора она не ложится, хвост слов сотрудника не обрезается.
 */
const seen = vi.hoisted(() => ({ messages: [] as { role: string; content: string }[][] }));
vi.mock("../src/ai/assistant.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/ai/assistant.js")>()),
  isAiAssistantEnabled: async () => true,
  runAssistantDetailed: async (messages: { role: string; content: string }[]) => {
    seen.messages.push(messages.map((m) => ({ ...m })));
    return { ok: true, reply: "Хорошо." };
  },
}));
vi.mock("../src/telegram/api.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/telegram/api.js")>()),
  sendMessage: vi.fn(async () => ({ message_id: 1 })),
  sendHtmlMessage: vi.fn(async () => ({ message_id: 2 })),
  sendChatAction: vi.fn(async () => ({})),
  setMessageReaction: vi.fn(async () => "sent"),
}));

const { prisma } = await import("../src/db.js");
const { handleAssistantPrivate } = await import("../src/telegram/assistantBot.js");

const runId = String(Date.now()).slice(-7);
const chatId = 8_700_000_000 + Number(runId);
let agentId = "";
let clientId = "";

beforeAll(async () => {
  const agent = await prisma.agent.create({
    data: {
      fullName: `История Шабнам ${runId}`, phone: `+992${Math.floor(Math.random() * 900_000_000) + 100_000_000}`, role: "AGENT",
      passwordHash: await bcrypt.hash("testpass123", 4), telegramChatId: String(chatId), telegramUserId: String(chatId),
    },
  });
  agentId = agent.id;
  const client = await prisma.client.create({
    data: {
      fullName: `Покупатель истории ${runId}`, phone: `+992${Math.floor(Math.random() * 900_000_000) + 100_000_000}`,
      source: "PHONE_CALL", kind: "BUYER", assignedAgentId: agentId, acceptedAt: new Date(),
    },
  });
  clientId = client.id;
  await prisma.showingQuestion.create({
    data: {
      kind: "AGREEMENT", dedupKey: `agreement:CALL:hist-${runId}`, agentId, clientId,
      askAt: new Date(Date.now() - 60_000), telegramSentAt: new Date(Date.now() - 30_000),
    },
  });
});

afterAll(async () => {
  await prisma.telegramDialogState.deleteMany({ where: { chatId: String(chatId) } });
  await prisma.showingQuestion.deleteMany({ where: { agentId } });
  await prisma.client.deleteMany({ where: { id: clientId } });
  await prisma.agent.deleteMany({ where: { id: agentId } }).catch(() => undefined);
});

it("справка идёт только в запрос к модели; в истории — слова сотрудника целиком, без справки", async () => {
  const text = `${"да договорились о показе ".repeat(150)}КОНЕЦ`;
  expect(text.length).toBeGreaterThan(3500);
  await handleAssistantPrivate(
    { message_id: 501, chat: { id: chatId, type: "private" }, from: { id: chatId }, text } as never,
    { id: agentId, fullName: "История" },
  );

  const toModel = seen.messages.at(-1)!;
  const lastToModel = toModel[toModel.length - 1]!.content;
  expect(lastToModel).toContain("[Справка CRM");
  expect(lastToModel.endsWith("КОНЕЦ")).toBe(true);

  const state = await prisma.telegramDialogState.findUnique({ where: { chatId: String(chatId) } });
  const saved = (state?.payload as { messages: { role: string; content: string }[] }).messages;
  const userSaved = saved.filter((m) => m.role === "user").at(-1)!.content;
  expect(userSaved).not.toContain("Справка CRM");
  expect(userSaved.endsWith("КОНЕЦ")).toBe(true);
});
