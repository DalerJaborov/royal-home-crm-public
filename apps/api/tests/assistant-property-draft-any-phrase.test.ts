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
const { isPropertyDraftStartText, handleTelegramPropertyDraft, draftPhraseForTests } = await import("../src/telegram/assistantPropertyDraft.js");
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
  await prisma.property.deleteMany({ where: { OR: [{ createdById: { in: ids } }, { title: { contains: runId } }] } });
  await prisma.district.deleteMany({ where: { name: { contains: runId } } });
  await prisma.agent.deleteMany({ where: { id: { in: ids } } });
});

let messageId = 1;
const say = (key: string, text: string) => {
  const a = agents[key];
  return handleTelegramPropertyDraft({ message_id: messageId++, chat: { id: a.chatId!, type: "private" }, from: { id: a.chatId! }, text } as never,
    { id: a.id, fullName: `Любая-фраза-${key} ${runId}` }, async () => ({ error: "нет голоса" }));
};
const allText = () => [...sendMessage.mock.calls, ...sendMessageWithButtons.mock.calls].map(c => String(c[1])).join("\n---\n");
const fillDraft = async (key: string, districtName: string, address: string) => {
  const district = await prisma.district.create({ data: { name: `${districtName} ${runId}` } });
  const draft = await prisma.propertyDraft.findUniqueOrThrow({ where: { agentId: agents[key].id } });
  await prisma.propertyDraft.update({ where: { id: draft.id }, data: { values: {
    type: "APARTMENT", condition: "GOOD", marketType: "SECONDARY", price: "650000", currency: "TJS", rooms: "2", areaSqm: "71",
    floor: "3", totalFloors: "9", windowCount: "3", districtId: district.id, address,
    lat: 38.5521, lng: 68.7621, sellerName: "Хозяин", sellerPhone: "+992935551299",
  } } });
  return district;
};

describe("«готово / создавай / отправляй» словами — объект создаётся без кнопки", () => {
  beforeAll(async () => {
    await mk("creator", 4, "AGENT");
  });

  it.each(["готово", "Готово!", "создавай", "всё, отправляй", "сохрани пожалуйста", "тайёр", "фиристед"])("«%s» — создать", (text) => {
    expect(draftPhraseForTests(text)).toBe("submit");
  });

  it("не хватает данных — объект не создаётся, карточка с подсказкой", async () => {
    await say("creator", "Шабнам, добавь объект");
    sendMessage.mockClear(); sendMessageWithButtons.mockClear();
    await say("creator", "готово");
    expect(await prisma.property.count({ where: { createdById: agents.creator.id } })).toBe(0);
    expect(allText()).toContain("Проверьте карточку");
  });

  it("«готово» к черновику, чью готовую карточку человек не видел, объект НЕ создаёт", async () => {
    await fillDraft("creator", "Район не видел", `Улица не видел ${runId}`);
    sendMessage.mockClear(); sendMessageWithButtons.mockClear();
    await say("creator", "готово");
    expect(await prisma.property.count({ where: { createdById: agents.creator.id } })).toBe(0);
    expect(allText()).toContain("Проверьте карточку");
  });

  it("готовая карточка показана — «готово» создаёт объект тем же путём, что кнопка «Создать»", async () => {
    // Карточка из прошлого шага уже показана готовой (с кнопкой «Создать»).
    sendMessage.mockClear(); sendMessageWithButtons.mockClear();
    await say("creator", "всё, создавай");
    expect(await prisma.property.count({ where: { createdById: agents.creator.id } })).toBe(1);
    // Черновик закрыт, разговор мастера в Telegram снят — как после кнопки «Создать».
    expect((await prisma.propertyDraft.findUnique({ where: { agentId: agents.creator.id } }))?.closedAt).toBeTruthy();
    expect(await prisma.telegramDialogState.count({ where: { agentId: agents.creator.id, kind: "property-draft" } })).toBe(0);
  });

  it("есть похожий объект — словами не создаёт, просит нажать «Всё равно создать»", async () => {
    await say("creator", "добавь объект");
    const district = await fillDraft("creator", "Район дубль", `Улица дубль ${runId}`);
    await prisma.property.create({ data: {
      type: "APARTMENT", areaSqm: 71, price: 600000, currency: "TJS", districtId: district.id, address: `Дом ${runId}`,
      title: `Двойник ${runId}`, condition: "GOOD", status: "AVAILABLE", lat: 38.5521, lng: 68.7621,
    } });
    await say("creator", "покажи черновик"); // готовая карточка с похожим объектом
    sendMessage.mockClear(); sendMessageWithButtons.mockClear();
    await say("creator", "готово");
    expect(await prisma.property.count({ where: { createdById: agents.creator.id } })).toBe(1);
    expect(allText()).toContain("Всё равно создать");
  });

  it("карточку показали, потом спросили о другом — следующее «готово» объект не создаёт", async () => {
    await prisma.property.deleteMany({ where: { title: `Двойник ${runId}` } });
    await say("creator", "добавь объект");
    await fillDraft("creator", "Район другое", `Улица другое ${runId}`);
    await say("creator", "покажи черновик"); // готовая карточка показана
    expect(await say("creator", "найди клиента Азиза")).toBe(false); // ушло помощнице
    sendMessage.mockClear(); sendMessageWithButtons.mockClear();
    await say("creator", "готово");
    expect(await prisma.property.count({ where: { createdById: agents.creator.id } })).toBe(1);
    expect(allText()).toContain("Проверьте карточку");
  });
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
