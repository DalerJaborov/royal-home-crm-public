import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * НОЧНАЯ ПРОВЕРКА 24.09.2026 (находка №116 / Г6, решение владельца — ДА,
 * распространить решение 18.09.2026 на все каналы): после приёма заявки бот
 * должен вести разговор дальше и молчать ТОЛЬКО когда агент реально включился
 * (написал/позвонил) — в каналах Meta это уже так (messengers/conversation.ts).
 * В Telegram (telegram/bot.ts) вместо этого на КАЖДОЕ сообщение уже принятого
 * клиента уходил один и тот же штамп «Ваша заявка уже принята...», а бот
 * дальше не отвечал вовсе — даже когда клиент задавал прямой вопрос.
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
const chatId = String(788000000 + (runId % 100000));

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
    message: { chat: { id: Number(chatId) }, from: { username: `postacc_${runId}` }, text },
  };
}

beforeAll(async () => {
  savedSettings = await prisma.settings.upsert({
    where: { id: "singleton" },
    update: {},
    create: { id: "singleton" },
    select: SELECT,
  });
  // Вне рабочих часов раздача лидов не идёт (ловушка из CLAUDE.md) — здесь заявка
  // уже принята заранее, но фиксируем окно на весь день, чтобы тест не зависел
  // от времени прогона.
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
    data: { fullName: `Агент ТГ принято ${runId}`, phone: `+992907${runId}`, role: "AGENT", passwordHash: "x" },
  });
  agentId = agent.id;

  const client = await prisma.client.create({
    data: {
      fullName: `Клиент ТГ принято ${runId}`,
      phone: `+992501${String(runId).slice(-6)}`,
      source: "TELEGRAM",
      assignedAgentId: agentId,
    },
  });
  clientId = client.id;

  // Диалог уже привязан к принятой карточке и стадия "done" — ровно то
  // состояние, в котором находка №116/Г6 ловила штамп на каждое сообщение.
  await prisma.telegramConversation.create({
    data: {
      chatId,
      username: `postacc_${runId}`,
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

describe("Telegram: после приёма заявки бот ведёт разговор, а не молчит штампом", () => {
  it("агент ещё не включился — бот отвечает по существу, не «заявка уже принята»", async () => {
    callAiText.mockResolvedValue({
      reply: ["Да, документы уже готовим, агент привезёт их на показ в четверг."],
      ready: false,
      intent: "buy",
      confident: true,
    });

    await handleTelegramUpdate(textUpdate("А когда привезут документы на квартиру?"));

    expect(sendMessage).toHaveBeenCalled();
    const sentTexts = sendMessage.mock.calls.map((call) => String(call[1]));
    expect(sentTexts.some((t) => t.includes("документы"))).toBe(true);
    expect(sentTexts.some((t) => t.includes("Ваша заявка уже принята"))).toBe(false);
  }, 15_000);

  it("агент реально включился (написал клиенту, pausedUntil) — бот молчит", async () => {
    await prisma.telegramConversation.update({
      where: { chatId },
      data: { pausedUntil: new Date(Date.now() + 60 * 60 * 1000), botPausedAt: new Date() },
    });
    callAiText.mockResolvedValue({
      reply: ["Этот ответ не должен уйти клиенту."],
      ready: false,
      intent: "buy",
      confident: true,
    });

    await handleTelegramUpdate(textUpdate("Ещё вопрос про паркинг"));

    expect(sendMessage).not.toHaveBeenCalled();
  }, 15_000);
});
