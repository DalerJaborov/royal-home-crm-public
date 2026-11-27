import { useTelegramClientBot } from "./helpers/telegramClientBot.js";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import bcrypt from "bcrypt";
// Клиентский путь Telegram — при выключенном «боте только для сотрудников» (27.11.2026).
useTelegramClientBot();

/**
 * 25.11.2026: озвучка своего текста из бота МОНТАЖЁРА. Жалоба владельца: монтажёр прислал «Озвучь вот этот текст "…"» и
 * получил «В работе у вас: объект №228 … Напишите «меню»» — весь его чат уходил в меню очереди, а разбор «озвучь»
 * жил только у помощницы, куда монтажёр не попадает. Здесь настоящий telegram/bot.ts, montajerBot и база стенда;
 * подменены Telegram и ElevenLabs: до выбора голоса ни одного платного вызова.
 *
 *  — его собственное сообщение → черновик текста (без «озвучь вот этот текст» и кавычек), кнопки «Озвучить как есть»;
 *  — короткое «мне нужна озвучка» → просьба прислать текст, следующее сообщение читается как текст;
 *  — пока ждём текст, короткая «очередь» остаётся командой, а длинный текст со слова «срок» читается как текст;
 *  — кнопка меню «🎙 Озвучить текст» работает, строка про озвучку есть в меню;
 *  — обычные слова по-прежнему дают статус очереди.
 */
const tg = vi.hoisted(() => ({
  sendMessage: vi.fn(async (_chatId: string, _text: string) => ({ message_id: 1 })),
  sendMessageWithButtons: vi.fn(async (_chatId: string, _text: string, _buttons: unknown) => ({ message_id: 2 })),
  answerCallbackQuery: vi.fn(async () => ({})),
  sendChatAction: vi.fn(async () => undefined),
}));
vi.mock("../src/telegram/api.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/telegram/api.js")>()),
  sendMessage: tg.sendMessage,
  sendMessageWithButtons: tg.sendMessageWithButtons,
  answerCallbackQuery: tg.answerCallbackQuery,
  sendChatAction: tg.sendChatAction,
  isTelegramEnabled: () => true,
}));
vi.mock("../src/ai/liveVoiceProvider.js", async (importOriginal) => ({ ...(await importOriginal<typeof import("../src/ai/liveVoiceProvider.js")>()), resolveElevenLabsKey: () => "test-key" }));
vi.mock("../src/push.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/push.js")>()),
  sendPushToAgent: vi.fn(async () => {}),
  sendPushToAgents: vi.fn(async () => 0),
}));

delete process.env.TELEGRAM_BOT_TOKEN;

const { prisma } = await import("../src/db.js");
const { handleTelegramUpdate } = await import("../src/telegram/bot.js");

const runId = Date.now();
const tail = String(runId).slice(-6);
const CHAT = 770_000_000 + (runId % 1_000_000);
let nextUpdateId = runId % 1_000_000_000;
let montajerId = "";
let savedSettings: { videoMontajerAgentId: string | null; propertyNarrationConfig: unknown } | null = null;

const voices = [{ id: `mv-${runId}`, name: "Анна", gender: "female" as const }];
const narrationConfig = { modelId: "eleven_v4", voices, defaultVoiceId: voices[0].id, dailyCharLimit: 1_000_000, dailyGenerationLimit: 1000, freeNarrationPerPersonDaily: 50, freeNarrationBudgetPercent: 100 };

const OWNER_TEXT = `Озвучь вот этот текст "Дар шаҳраки Сомониён, воқеъ дар ноҳияи Рӯдакӣ, дар наздикии Қасри фарҳанг ва маркази шаҳр, имконияти хуби хариди манзили нав фароҳам шудааст!

Ин маҷмааи истиқоматӣ дорои тамоми шароити зарурӣ мебошад:

Барқи шаҳрӣ, системаи мустақили канализатсия, панелҳои офтобӣ, ҳудуди пӯшида ва амн, инчунин дар ҳар блок се лифт пешбинӣ шудааст.

Нархи як метри мураббаъ аз 6 500 сомонӣ оғоз мешавад. Дар ин маҷмаа 160 манзил бо масоҳати аз 59 то 95 метри мураббаъ мавҷуд аст.

Шаҳраки Сомониён, кӯчаи Исмоили Сомонӣ, ноҳияи Рӯдакӣ!"`;

const text = (body: string) => handleTelegramUpdate({ update_id: nextUpdateId++, message: { chat: { id: CHAT, type: "private" }, from: { id: CHAT }, text: body } });
const press = (data: string) =>
  handleTelegramUpdate({ update_id: nextUpdateId++, callback_query: { id: `mfn-${runId}-${nextUpdateId}`, data, message: { chat: { id: CHAT, type: "private" }, message_id: 1 }, from: { id: CHAT } } });
const replies = () => [
  ...tg.sendMessage.mock.calls.map((c) => String(c[1])),
  ...tg.sendMessageWithButtons.mock.calls.map((c) => `${String(c[1])}\n${JSON.stringify(c[2])}`),
];

beforeAll(async () => {
  montajerId = (
    await prisma.agent.create({
      // Как в проде: назначенный монтажёр — не EDITOR, а MARKETING.
      data: { fullName: "Монтажёр озвучки", phone: `+99293${tail}0`, role: "MARKETING", passwordHash: await bcrypt.hash("testpass123", 4), telegramChatId: String(CHAT) },
    })
  ).id;
  savedSettings = await prisma.settings.upsert({
    where: { id: "singleton" },
    update: {},
    create: { id: "singleton" },
    select: { videoMontajerAgentId: true, propertyNarrationConfig: true },
  });
  await prisma.settings.update({ where: { id: "singleton" }, data: { videoMontajerAgentId: montajerId, propertyNarrationConfig: narrationConfig } });
});

beforeEach(async () => {
  vi.clearAllMocks();
  await prisma.freeNarration.deleteMany({ where: { agentId: montajerId } });
  await prisma.telegramDialogState.deleteMany({ where: { chatId: String(CHAT) } });
});

afterAll(async () => {
  await prisma.freeNarration.deleteMany({ where: { agentId: montajerId } });
  await prisma.telegramDialogState.deleteMany({ where: { chatId: String(CHAT) } });
  await prisma.telegramCallbackSeen.deleteMany({ where: { id: { startsWith: `mfn-${runId}` } } });
  if (savedSettings) {
    await prisma.settings.update({
      where: { id: "singleton" },
      data: { videoMontajerAgentId: savedSettings.videoMontajerAgentId, propertyNarrationConfig: (savedSettings.propertyNarrationConfig ?? {}) as object },
    });
  }
  await prisma.agent.deleteMany({ where: { id: montajerId } });
});

describe("озвучка текста в боте монтажёра", () => {
  it("сообщение владельца «Озвучь вот этот текст …» даёт черновик текста, а не статус очереди", async () => {
    const fetcher = vi.fn();
    vi.stubGlobal("fetch", fetcher);
    try {
      await text(OWNER_TEXT);
      expect(replies().some((r) => r.includes("В работе у вас") || r.includes("Сейчас монтаж ничего не ждёт"))).toBe(false);
      const draft = await prisma.freeNarration.findFirst({ where: { agentId: montajerId, status: "DRAFT" } });
      expect(draft).not.toBeNull();
      expect(draft!.script.startsWith("Дар шаҳраки Сомониён")).toBe(true);
      expect(draft!.script.endsWith("ноҳияи Рӯдакӣ!")).toBe(true);
      expect(draft!.script).not.toMatch(/Озвучь|вот этот текст/iu);
      expect(draft!.script).not.toContain('"');
      expect(replies().join("\n")).toMatch(/fnr:o:/u);
      // До выбора голоса деньги не тратятся.
      expect(fetcher).not.toHaveBeenCalled();
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("«мне нужна озвучка» просит текст, следующее сообщение читается как текст озвучки", async () => {
    await text("мне нужна озвучка");
    expect(replies().join("\n")).toMatch(/Пришлите текст/u);
    expect(await prisma.freeNarration.count({ where: { agentId: montajerId, status: "AWAITING_TEXT" } })).toBe(1);

    await text("Салом, ин матни озмоишӣ барои овозонӣ аст.");
    const row = await prisma.freeNarration.findFirst({ where: { agentId: montajerId, status: { not: "AWAITING_TEXT" } } });
    expect(row?.script).toBe("Салом, ин матни озмоишӣ барои овозонӣ аст.");
    expect(row?.status).toBe("AWAITING_VOICE");
  });

  it("пока ждём текст: «очередь» остаётся командой, а длинный текст со слова «срок» читается как текст", async () => {
    await text("мне нужна озвучка");
    tg.sendMessage.mockClear();
    tg.sendMessageWithButtons.mockClear();

    await text("очередь");
    expect(await prisma.freeNarration.count({ where: { agentId: montajerId, status: "AWAITING_TEXT" } })).toBe(1);
    expect(replies().join("\n")).toMatch(/Очередь|ничего не ждёт|В работе/u);

    const long = "Срок сдачи дома четвёртый квартал, оформление через банк и рассрочка на два года без переплаты.";
    await text(long);
    const row = await prisma.freeNarration.findFirst({ where: { agentId: montajerId, status: "AWAITING_VOICE" } });
    expect(row?.script).toBe(long);
  });

  it("кнопка меню «🎙 Озвучить текст» просит текст; в меню есть строка про озвучку", async () => {
    await text("меню");
    const menu = replies().join("\n");
    expect(menu).toMatch(/озвучь/iu);
    expect(menu).toContain("mj:nar");

    tg.sendMessage.mockClear();
    tg.sendMessageWithButtons.mockClear();
    await press("mj:nar");
    expect(replies().join("\n")).toMatch(/Пришлите текст/u);
    expect(await prisma.freeNarration.count({ where: { agentId: montajerId, status: "AWAITING_TEXT" } })).toBe(1);
  });

  it("обычные слова монтажёра по-прежнему дают статус очереди и подсказку про озвучку", async () => {
    await text("привет");
    const all = replies().join("\n");
    expect(all).toMatch(/Сейчас монтаж ничего не ждёт|В работе у вас/u);
    expect(all).toContain("озвучка вашего текста");
    expect(await prisma.freeNarration.count({ where: { agentId: montajerId } })).toBe(0);
  });
});
