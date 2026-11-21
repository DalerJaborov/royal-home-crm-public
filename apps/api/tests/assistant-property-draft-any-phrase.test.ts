import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import bcrypt from "bcrypt";

/**
 * «ДОБАВЬ ОБЪЕКТ» ЛЮБЫМИ СЛОВАМИ (21.11.2026, владелец: «Бот мушовир Шабнам почему не может добавить
 * объект… Исправь, чтобы любые похожие все можно было использовать»).
 *
 * Мастер объекта открывала только регулярка по началу ТЕКСТА: голосовое, «Шабнам, добавь…», вопрос
 * «можешь добавить объект?» уходили в общий ответ без инструмента, и помощница говорила «не могу».
 * Здесь: фразы голосовых расшифровок, инструмент start_property_draft (тот же вход, что /new_property),
 * его отказ по правам и без привязанного Telegram. Telegram подменён; база настоящая.
 */

const { sendMessage, sendMessageWithButtons } = vi.hoisted(() => ({
  sendMessage: vi.fn(async (_chatId: string, _text: string) => ({})),
  sendMessageWithButtons: vi.fn(async (_c: string, _t: string, _b: unknown) => ({ message_id: 601 })),
}));

vi.mock("../src/telegram/api.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/telegram/api.js")>()),
  sendMessage, sendMessageWithButtons,
}));
vi.mock("../src/ai/assistant.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/ai/assistant.js")>()),
  isAiAssistantEnabled: async () => true,
}));

const { prisma } = await import("../src/db.js");
const { isPropertyDraftStartText } = await import("../src/telegram/assistantPropertyDraft.js");
const { startPropertyDraftTool } = await import("../src/ai/assistant/tools/startPropertyDraftTool.js");
const { listAssistantToolPlugins } = await import("../src/ai/assistant/tools/index.js");

const runId = String(Date.now()).slice(-7);
const agents: Record<string, { id: string; chatId: number | null }> = {};

async function mk(key: string, n: number, role: string, withTelegram = true) {
  const chatId = withTelegram ? 810_000_000 + Number(runId) * 10 + n : null;
  const agent = await prisma.agent.create({ data: {
    fullName: `Любая-фраза-${key} ${runId}`, phone: `+992${Math.floor(Math.random() * 900_000_000) + 100_000_000}`, role: role as "AGENT",
    passwordHash: await bcrypt.hash("testpass123", 4),
    ...(chatId ? { telegramUserId: String(chatId), telegramChatId: String(chatId) } : {}),
  } });
  agents[key] = { id: agent.id, chatId };
}

const runTool = (key: string, args: Record<string, unknown> = {}, surface: "telegram-private" | "telegram-group" | "crm-private" = "telegram-private") =>
  startPropertyDraftTool.run(args, { actor: { id: agents[key].id, surface } as never }) as Promise<Record<string, unknown>>;
const sentTo = () => [...sendMessage.mock.calls, ...sendMessageWithButtons.mock.calls].map(c => String(c[0]));

beforeAll(async () => {
  await mk("agent", 1, "AGENT");
  await mk("security", 2, "SECURITY");
  await mk("offline", 3, "AGENT", false);
});

beforeEach(() => {
  sendMessage.mockReset();
  sendMessageWithButtons.mockReset();
  sendMessageWithButtons.mockResolvedValue({ message_id: 601 });
});

afterAll(async () => {
  const ids = Object.values(agents).map(a => a.id);
  await prisma.telegramDialogState.deleteMany({ where: { agentId: { in: ids } } });
  await prisma.propertyDraft.deleteMany({ where: { agentId: { in: ids } } });
  await prisma.agent.deleteMany({ where: { id: { in: ids } } });
});

describe("голосовая расшифровка — тот же разбор фразы", () => {
  it.each([
    "Добавь объект.",
    "Шабнам, добавь, пожалуйста, объект.",
    "Добавь объект, пожалуйста.",
    "Шабнам, можешь добавить новую квартиру?",
    "Лутфан, объект илова кунед.",
  ])("«%s» — открыть мастер", (text) => {
    expect(isPropertyDraftStartText(text)).toBe(true);
  });

  it.each([
    "Шабнам, найди, пожалуйста, квартиру в Сино.",
    "Покажи объект ОБ-000123.",
    "Сколько стоит квартира на Рудаки?",
  ])("«%s» — не мастер", (text) => {
    expect(isPropertyDraftStartText(text)).toBe(false);
  });
});

describe("инструмент start_property_draft", () => {
  it("объявлен помощнице в личке Telegram, в группе и в CRM", () => {
    expect(listAssistantToolPlugins().some(p => p.name === "start_property_draft")).toBe(true);
  });

  it("открывает черновик в личке сотрудника и передаёт уже названные данные", async () => {
    const result = await runTool("agent", { details: "Цена: 750000" });
    expect(result).toMatchObject({ opened: true });
    expect(sentTo()).toContain(String(agents.agent.chatId));
    const draft = await prisma.propertyDraft.findUniqueOrThrow({ where: { agentId: agents.agent.id } });
    expect(draft.values as Record<string, unknown>).toMatchObject({ price: "750000" });
  });

  it("из группы карточка всё равно уходит в личку, а не в группу", async () => {
    const result = await runTool("agent", {}, "telegram-group");
    expect(result).toMatchObject({ opened: true });
    expect(new Set(sentTo())).toEqual(new Set([String(agents.agent.chatId)]));
  });

  it("служба безопасности объекты не заводит — отказ словами, черновика нет", async () => {
    const result = await runTool("security");
    expect(String(result.error)).toMatch(/Служба безопасности/u);
    expect(await prisma.propertyDraft.findUnique({ where: { agentId: agents.security.id } })).toBeNull();
    expect(sentTo()).toEqual([]);
  });

  it("Telegram не привязан — подсказывает путь в CRM, ничего не шлёт", async () => {
    const result = await runTool("offline");
    expect(String(result.error)).toMatch(/Объекты → Добавить объект/u);
    expect(sentTo()).toEqual([]);
  });
});
