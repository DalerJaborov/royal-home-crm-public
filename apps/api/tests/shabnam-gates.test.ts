import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import bcrypt from "bcrypt";

/**
 * ШАБНАМ: РЕШАЕТ МОДЕЛЬ (МАРКЕРОМ ИЛИ АРГУМЕНТОМ), КОД ПРОВЕРЯЕТ (аудит 14.11.2026).
 *
 * С базой: промт не учит ложным отказам и называет канал; «не присылай мне
 * оплаты» любыми словами — инструмент set_notification_pref через брокер
 * подтверждений и одну дверь отключений; открытый черновик объекта отпускает
 * «отмени» и вопросы о другом, а не раскладывает их по полям. Модель подменена,
 * в сеть к Google не ходим.
 */

const { sendMessage, sendMessageWithButtons, sendHtmlMessage, answerCallbackQuery, editMessageText, callGeminiTools } = vi.hoisted(() => ({
  sendHtmlMessage: vi.fn(async (_c: string, _h: string, _r?: number, _b?: unknown) => ({})),
  sendMessage: vi.fn(async (_chatId: string, _text: string) => ({})),
  sendMessageWithButtons: vi.fn(async (_c: string, _t: string, _b: unknown) => ({ message_id: 601 })),
  answerCallbackQuery: vi.fn(async (_id: string, _text?: string) => ({})),
  editMessageText: vi.fn(async (_c: string, _m: number, _t: string, _b?: unknown) => {}),
  callGeminiTools: vi.fn(),
}));

vi.mock("../src/telegram/api.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/telegram/api.js")>()),
  sendMessage, sendMessageWithButtons, sendHtmlMessage, answerCallbackQuery, editMessageText,
}));
vi.mock("../src/ai/geminiClient.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/ai/geminiClient.js")>()),
  callGeminiTools,
}));
vi.mock("../src/ai/geminiSettings.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/ai/geminiSettings.js")>()),
  resolveGeminiRuntime: async () => ({
    keys: ["fake-gemini-key"], model: "gemini-test", fallbackModels: [], transcribeModels: [], imageModel: "unused", liteModel: "", explicitCaching: false,
  }),
}));
vi.mock("../src/ai/assistant.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/ai/assistant.js")>()),
  isAiAssistantEnabled: async () => true,
}));

const { prisma } = await import("../src/db.js");
const { runAssistantDetailed } = await import("../src/ai/assistant.js");
const { assistantActorFor } = await import("../src/telegram/assistantBot.js");
const { handleTelegramPropertyDraft } = await import("../src/telegram/assistantPropertyDraft.js");
const broker = await import("../src/lib/assistantActions.js");
const { resolvePermissions } = await import("@royal-home/shared");
const { cleanupAssistantActionAgents } = await import("./helpers/assistantActionFixture.js");

const runId = String(Date.now()).slice(-7);
let directorId = "";
let chatId = 0;
let messageId = 1;

const modelSays = (text: string) => ({ text, calls: [], modelParts: [{ text }], tokens: 1 });
const extraction = (args: Record<string, unknown>) => ({
  text: "", calls: [{ name: "extract_property_fields", args }], modelParts: [], tokens: 1,
});

beforeAll(async () => {
  chatId = 810_000_000 + Number(runId) % 10_000_000;
  const director = await prisma.agent.create({ data: {
    fullName: `Шабнам-ворота ${runId}`, phone: `+992${Math.floor(Math.random() * 900_000_000) + 100_000_000}`, role: "DIRECTOR",
    passwordHash: await bcrypt.hash("testpass123", 4), telegramUserId: String(chatId), telegramChatId: String(chatId),
  } });
  directorId = director.id;
});

beforeEach(() => {
  for (const m of [sendMessage, sendMessageWithButtons, sendHtmlMessage, answerCallbackQuery, editMessageText, callGeminiTools]) m.mockReset();
  sendMessageWithButtons.mockResolvedValue({ message_id: 601 });
});

afterAll(async () => {
  await prisma.telegramDialogState.deleteMany({ where: { agentId: directorId } });
  await prisma.propertyDraft.deleteMany({ where: { agentId: directorId } });
  await cleanupAssistantActionAgents([directorId]);
});

const access = () => ({ role: "DIRECTOR", permissions: resolvePermissions("DIRECTOR") });

async function declared(scope: "private" | "group") {
  callGeminiTools.mockResolvedValue(modelSays("Готово."));
  const outcome = await runAssistantDetailed([{ role: "user", content: "Сколько мы потратили в ноябре?" }],
    assistantActorFor(directorId, access(), scope), { confirmUi: scope === "private", channel: "telegram" });
  expect(outcome.ok).toBe(true);
  const params = callGeminiTools.mock.calls[0][0] as { system: string; tools: Array<{ name: string }> };
  return { system: params.system, tools: params.tools.map((t) => t.name) };
}

describe("промт: умения — из списка инструментов, канал назван", () => {
  it("в группе директору не говорят «нет права на Финансы», а зовут в личку", async () => {
    const { system, tools } = await declared("group");
    expect(tools).not.toContain("list_expenses");
    expect(tools).not.toContain("set_notification_pref");
    expect(system).not.toContain("Нет у тебя инструментов расходов");
    expect(system).not.toMatch(/Удаление, деньги, права, настройки/);
    expect(system).toMatch(/КАНАЛ: общая группа Telegram/);
    expect(system).toMatch(/Напишите мне в личку/);
    expect(system).not.toContain("{{CHANNEL}}");
  });

  it("в личке объявлены удаление, сотрудники и уведомления; запрет обещать без инструмента — в промте", async () => {
    const { system, tools } = await declared("private");
    expect(tools).toEqual(expect.arrayContaining(["delete_property", "create_staff", "set_staff_permissions", "set_notification_pref", "add_expenses"]));
    expect(system).toMatch(/КАНАЛ: личный чат Telegram/);
    expect(system).toMatch(/ЧТО ТЫ УМЕЕШЬ — РЕШАЕТ СПИСОК ТВОИХ ИНСТРУМЕНТОВ/);
    expect(system).toMatch(/НЕ обещай того, чего не сделала инструментом/);
    expect(system).toMatch(/«нет доступа», «нет права»/);
  });
});

describe("set_notification_pref: модель решает вид, код пишет через одну дверь", () => {
  const privateActor = () => ({ agentId: directorId, channel: "telegram" as const, telegramPrivate: true, can: () => true });

  it("карточка → «Подтвердить» выключает оплаты, «Отменить» включает обратно", async () => {
    await prisma.agent.update({ where: { id: directorId }, data: { pushMuted: [] } });
    const card = await broker.createPendingAssistantAction(privateActor(), "set_notification_pref", { kind: "payment", muted: true });
    expect(card.preview.title).toContain("Оплаты подписок");
    expect((await prisma.agent.findUniqueOrThrow({ where: { id: directorId } })).pushMuted).not.toContain("payment");
    await broker.confirmAssistantAction(card.id, privateActor());
    expect((await prisma.agent.findUniqueOrThrow({ where: { id: directorId } })).pushMuted).toContain("payment");
    await broker.undoAssistantAction(card.id, privateActor());
    expect((await prisma.agent.findUniqueOrThrow({ where: { id: directorId } })).pushMuted).not.toContain("payment");
  });

  it("безопасность не выключается — честный отказ до карточки", async () => {
    await expect(broker.createPendingAssistantAction(privateActor(), "set_notification_pref", { kind: "security", muted: true }))
      .rejects.toMatchObject({ code: "ALWAYS_ON" });
  });

  it("в общей группе — отказ брокера, даже если модель позвала", async () => {
    await expect(broker.createPendingAssistantAction({ ...privateActor(), telegramPrivate: false }, "set_notification_pref", { kind: "task", muted: true }))
      .rejects.toBeInstanceOf(broker.AssistantActionError);
  });
});

describe("открытый черновик объекта отпускает «отмени» и вопросы о другом", () => {
  const send = (text: string, transcript?: string) => handleTelegramPropertyDraft({
    message_id: messageId++, chat: { id: chatId, type: "private" }, from: { id: chatId },
    ...(transcript ? { voice: { file_id: "v", duration: 2 } } : { text }),
  } as never, { id: directorId, fullName: "Директор" }, async () => (transcript ? { text: transcript } : { error: "нет голоса" }));
  const draftState = () => prisma.telegramDialogState.findFirst({ where: { agentId: directorId, kind: "property-draft" } });
  const draftValues = async () => (await prisma.propertyDraft.findUniqueOrThrow({ where: { agentId: directorId } })).values as Record<string, unknown>;

  it("«хочу внести квартиру» открывает, «отмени» закрывает без модели", async () => {
    expect(await send("хочу внести квартиру")).toBe(true);
    expect(await draftState()).not.toBeNull();
    expect(await send("отмени")).toBe(true);
    expect(await draftState()).toBeNull();
    expect(callGeminiTools).not.toHaveBeenCalled();
  });

  it("«найди клиента Азиза» и «снизь цену ОБ-123» уходят помощнице без разбора полей", async () => {
    expect(await send("новая квартира")).toBe(true);
    expect(await send("найди клиента Азиза")).toBe(false);
    expect(await send("снизь цену ОБ-123 до 50000")).toBe(false);
    expect(callGeminiTools).not.toHaveBeenCalled();
    expect(await draftState()).not.toBeNull();
  });

  it("модель сказала other_question — сообщение помощнице, поля не тронуты", async () => {
    const before = await draftValues();
    callGeminiTools.mockResolvedValueOnce(extraction({ intent: "other_question", price: "999" }));
    expect(await send("а у Азиза какой бюджет был?")).toBe(false);
    expect(await draftValues()).toEqual(before);
    expect(await draftState()).not.toBeNull();
  });

  it("голосом о другом — тоже помощнице; голосом «давай потом» — выход", async () => {
    callGeminiTools.mockResolvedValueOnce(extraction({ intent: "other_question" }));
    expect(await send("", "сколько у меня задач на завтра")).toBe(false);
    expect(await send("", "давай потом")).toBe(true);
    expect(await draftState()).toBeNull();
  });

  it("модель сказала cancel — выход; field_update — поле записано", async () => {
    expect(await send("хонаи нав илова кунам")).toBe(true);
    callGeminiTools.mockResolvedValueOnce(extraction({ intent: "field_update", price: "50000", currency: "USD" }));
    expect(await send("просят пятьдесят тысяч долларов")).toBe(true);
    expect((await draftValues()).price).toBe("50000");
    callGeminiTools.mockResolvedValueOnce(extraction({ intent: "cancel" }));
    expect(await send("ладно, сейчас не до этого")).toBe(true);
    expect(await draftState()).toBeNull();
  });
});
