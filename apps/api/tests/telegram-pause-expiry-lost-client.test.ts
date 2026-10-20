import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * НОЧНАЯ ПРОВЕРКА 24.09.2026, находка №114 (Г4): в Telegram (telegram/bot.ts)
 * «бессрочная» пауза оператора (pausedUntil на 10 лет вперёд) не снималась
 * НИЧЕМ — ни статусом клиента LOST/ARCHIVED/workStatus INACTIVE, ни временем:
 * проверка была голым `pausedUntil > now()`. В каналах Meta (messengers/
 * conversation.ts) такая же пауза протухает: если она стоит достаточно давно
 * (botPausedAt старше недели) И карточка ушла в LOST/ARCHIVED/INACTIVE, бот
 * снова отвечает — предполагается, что агент клиента забросил, а не ведёт его
 * прямо сейчас. Формула вынесена в lib/conversationState.ts::isOperatorPauseActive
 * и теперь общая для обоих каналов — этот тест проверяет её со стороны Telegram.
 *
 * Транспорт и ИИ подменены — тест не ходит ни в Telegram, ни к модели.
 */

const { sendMessage, requestContact, removeKeyboard, callAiText } = vi.hoisted(() => ({
  sendMessage: vi.fn(async (_chatId: string, _text: string) => {}),
  requestContact: vi.fn(async (_chatId: string, _text: string) => {}),
  removeKeyboard: vi.fn(async (_chatId: string, _text: string) => {}),
  callAiText: vi.fn(),
}));

vi.mock("../src/telegram/api.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/telegram/api.js")>()),
  sendMessage,
  requestContact,
  removeKeyboard,
}));
vi.mock("../src/ai/client.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/ai/client.js")>()),
  callAiText,
}));

delete process.env.TELEGRAM_BOT_TOKEN;

const { prisma } = await import("../src/db.js");
const { handleTelegramUpdate } = await import("../src/telegram/bot.js");
const { deleteAgentsWithTraces } = await import("./helpers/cleanupAgents.js");

const runId = Date.now();
const chatId = String(789000000 + (runId % 100000));

type SettingsSnapshot = {
  botEnabled: boolean;
  botTelegramEnabled: boolean;
  telegramOwnerChatId: string | null;
  workHoursStart: string;
  workHoursEnd: string;
};
const SELECT = {
  botEnabled: true,
  botTelegramEnabled: true,
  telegramOwnerChatId: true,
  workHoursStart: true,
  workHoursEnd: true,
} as const;
let savedSettings: SettingsSnapshot;

let agentId = "";
let clientId = "";

let nextUpdateId = runId % 1_000_000_000;
function textUpdate(text: string) {
  return {
    update_id: nextUpdateId++,
    message: { chat: { id: Number(chatId) }, from: { username: `pauseexp_${runId}` }, text },
  };
}

const TEN_YEARS_MS = 10 * 365 * 24 * 60 * 60 * 1000;
const EIGHT_DAYS_MS = 8 * 24 * 60 * 60 * 1000;
const ONE_HOUR_MS = 60 * 60 * 1000;

beforeAll(async () => {
  savedSettings = await prisma.settings.upsert({
    where: { id: "singleton" },
    update: {},
    create: { id: "singleton" },
    select: SELECT,
  });
  // Вне рабочих часов раздача лидов не идёт (ловушка из CLAUDE.md) — фиксируем
  // окно на весь день, чтобы тест не зависел от времени прогона.
  await prisma.settings.update({
    where: { id: "singleton" },
    data: {
      botEnabled: true,
      botTelegramEnabled: true,
      telegramOwnerChatId: null,
      workHoursStart: "00:00",
      workHoursEnd: "24:00",
    },
  });

  const agent = await prisma.agent.create({
    data: { fullName: `Агент ТГ протух ${runId}`, phone: `+992908${runId}`, role: "AGENT", passwordHash: "x" },
  });
  agentId = agent.id;

  const client = await prisma.client.create({
    data: {
      fullName: `Клиент ТГ протух ${runId}`,
      phone: `+992502${String(runId).slice(-6)}`,
      source: "TELEGRAM",
      assignedAgentId: agentId,
      status: "LOST",
    },
  });
  clientId = client.id;

  await prisma.telegramConversation.create({
    data: {
      chatId,
      username: `pauseexp_${runId}`,
      clientId,
      leadDraft: { stage: "done" } as any,
      messages: [
        { role: "assistant", content: "Спасибо! Заявка принята. Наш агент свяжется с вами в ближайшее время." },
      ] as any,
    },
  });
});

afterAll(async () => {
  await prisma.settings.update({ where: { id: "singleton" }, data: savedSettings });
  await prisma.telegramConversation.deleteMany({ where: { chatId } });
  await prisma.interaction.deleteMany({ where: { clientId } });
  await prisma.client.deleteMany({ where: { id: clientId } });
  await deleteAgentsWithTraces([agentId]);
});

beforeEach(() => {
  sendMessage.mockReset();
  sendMessage.mockResolvedValue(undefined);
  requestContact.mockReset();
  requestContact.mockResolvedValue(undefined);
  removeKeyboard.mockReset();
  removeKeyboard.mockResolvedValue(undefined);
  callAiText.mockReset();
});

describe("Telegram: бессрочная пауза оператора протухает у брошенного клиента", () => {
  it("pausedUntil +10 лет, botPausedAt -8 дней, клиент LOST — бот отвечает", async () => {
    await prisma.telegramConversation.update({
      where: { chatId },
      data: {
        pausedUntil: new Date(Date.now() + TEN_YEARS_MS),
        botPausedAt: new Date(Date.now() - EIGHT_DAYS_MS),
      },
    });
    callAiText.mockResolvedValue({
      reply: ["Да, подскажите, пожалуйста, что вас сейчас интересует?"],
      ready: false,
      intent: "buy",
      confident: true,
    });

    await handleTelegramUpdate(textUpdate("Здравствуйте, ещё актуально?"));

    expect(sendMessage).toHaveBeenCalled();
  }, 15_000);

  it("та же пауза, но свежая (botPausedAt -1 час) — бот молчит", async () => {
    await prisma.telegramConversation.update({
      where: { chatId },
      data: {
        pausedUntil: new Date(Date.now() + TEN_YEARS_MS),
        botPausedAt: new Date(Date.now() - ONE_HOUR_MS),
      },
    });
    callAiText.mockResolvedValue({
      reply: ["Этот ответ не должен уйти клиенту."],
      ready: false,
      intent: "buy",
      confident: true,
    });

    await handleTelegramUpdate(textUpdate("Ещё вопрос"));

    expect(sendMessage).not.toHaveBeenCalled();
  }, 15_000);
});
