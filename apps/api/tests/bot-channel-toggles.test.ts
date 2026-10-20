import { createCustomerMessengerFixture, type CustomerMessengerFixture } from "./helpers/customerMessengerFixture.js";
import { drainBackgroundTasks } from "../src/lib/shutdownState.js";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { prisma } from "../src/db.js";
import { isBotEnabledForChannel, loadBotChannelToggles } from "../src/messengers/botChannels.js";
import { processMessengerTurn as actualProcessMessengerTurn } from "../src/messengers/conversation.js";

/**
 * Раздельные рубильники бота по каналам.
 *
 * Смысл всей затеи — «выключить Instagram, оставив WhatsApp», поэтому проверяем
 * ровно это: выключенный канал молчит, соседний отвечает как ни в чём не бывало.
 *
 * И главное, что легко потерять при такой правке: выключенный бот НЕ значит
 * «сообщения не принимаем». Входящее обязано попасть в переписку CRM в обоих
 * случаях — иначе сотрудник не увидит клиента и не ответит ему руками.
 *
 * Модель подменена: тест не должен ни платить за токены, ни зависеть от
 * доступности API. Всё остальное настоящее, включая базу.
 */

const { qualify } = vi.hoisted(() => ({ qualify: vi.fn() }));
vi.mock("../src/ai/client.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/ai/client.js")>()),
  callAiText: qualify,
}));

/** Уникальный хвост: база общая с другими прогонами, пересечься диалогами нельзя. */
let instagramFixture: CustomerMessengerFixture;
let whatsappFixture: CustomerMessengerFixture;
function processMessengerTurn(input: Parameters<typeof actualProcessMessengerTurn>[0]) {
  const fixture = input.channel === "INSTAGRAM" ? instagramFixture : input.channel === "WHATSAPP" ? whatsappFixture : null;
  if (!fixture) throw new Error("No configured fixture for this channel");
  return actualProcessMessengerTurn({ ...input, ...fixture.turnInput(input.subscriberId) });
}

const runId = Date.now().toString(36);
const IG_SUBSCRIBER = `bct-ig-${runId}`;
const WA_SUBSCRIBER = `bct-wa-${runId}`;

/** Настройки — singleton, общий на всю базу: то, что трогаем, возвращаем на место. */
type SettingsSnapshot = {
  botEnabled: boolean;
  botWhatsappEnabled: boolean;
  botInstagramEnabled: boolean;
  botFacebookEnabled: boolean;
  botTelegramEnabled: boolean;
  botReplyDelaySec: number;
  botReplyMaxWaitSec: number;
};
let saved: SettingsSnapshot;

const SELECT = {
  botEnabled: true,
  botWhatsappEnabled: true,
  botInstagramEnabled: true,
  botFacebookEnabled: true,
  botTelegramEnabled: true,
  botReplyDelaySec: true,
  botReplyMaxWaitSec: true,
} as const;

async function setToggles(patch: Partial<SettingsSnapshot>): Promise<void> {
  await prisma.settings.update({ where: { id: "singleton" }, data: patch });
}

/** Сообщения диалога так, как их увидит сотрудник в «Сообщениях». */
async function historyOf(channel: string, subscriberId: string): Promise<{ role: string; content: string }[]> {
  const conv = await prisma.botConversation.findUnique({
    where: { channel_subscriberId: { channel, subscriberId } },
    select: { messages: true },
  });
  return (Array.isArray(conv?.messages) ? conv.messages : []) as { role: string; content: string }[];
}

beforeAll(async () => {
  instagramFixture = await createCustomerMessengerFixture("INSTAGRAM");
  whatsappFixture = await createCustomerMessengerFixture("WHATSAPP");
  const current = await prisma.settings.upsert({
    where: { id: "singleton" },
    update: {},
    create: { id: "singleton" },
    select: SELECT,
  });
  saved = current;
  // Дебаунс на ноль: ход бота ждёт тишины (по умолчанию 25 секунд), и тест бы
  // просто не уложился в таймаут. Проверяем рубильники, а не паузу.
  await setToggles({ botReplyDelaySec: 0, botReplyMaxWaitSec: 5 });
});

afterAll(async () => {
  await drainBackgroundTasks(2000);
  await instagramFixture?.dispose();
  await whatsappFixture?.dispose();
  await prisma.settings.update({ where: { id: "singleton" }, data: saved });
});

beforeEach(async () => {
  qualify.mockReset();
  await setToggles({
    botEnabled: true,
    botWhatsappEnabled: true,
    botInstagramEnabled: true,
    botFacebookEnabled: true,
    botTelegramEnabled: true,
  });
});

describe("рубильники каналов: что считается включённым", () => {
  it("выключенный канал молчит, соседний отвечает", async () => {
    await setToggles({ botInstagramEnabled: false });
    expect(await isBotEnabledForChannel("INSTAGRAM")).toBe(false);
    expect(await isBotEnabledForChannel("WHATSAPP")).toBe(true);
    expect(await isBotEnabledForChannel("FACEBOOK")).toBe(true);
    expect(await isBotEnabledForChannel("TELEGRAM")).toBe(true);
  });

  it("общий рубильник сильнее канального: выключен глобально — молчат все", async () => {
    await setToggles({ botEnabled: false, botInstagramEnabled: true, botWhatsappEnabled: true });
    const toggles = await loadBotChannelToggles();
    expect(toggles.botEnabled).toBe(false);
    expect(Object.values(toggles.channels).every((on) => on === false)).toBe(true);
  });

  it("канал без своего рубильника подчиняется только общему — новый транспорт не должен молчать без причины", async () => {
    expect(await isBotEnabledForChannel("VIBER")).toBe(true);
    await setToggles({ botEnabled: false });
    expect(await isBotEnabledForChannel("VIBER")).toBe(false);
  });
});

describe("выключенный канал: молчим, но принимаем", () => {
  it("бот в Instagram не отвечает и не тратит токены, а входящее ложится в переписку", async () => {
    await setToggles({ botInstagramEnabled: false });

    const result = await processMessengerTurn({
      channel: "INSTAGRAM",
      subscriberId: IG_SUBSCRIBER,
      text: "Салом, хона мекобам",
    });

    expect(result.shouldReply).toBe(false);
    expect(result.reply).toBe("");
    // Модель не звали вовсе: выключенный канал не должен стоить ни копейки.
    expect(qualify).not.toHaveBeenCalled();

    const history = await historyOf("INSTAGRAM", IG_SUBSCRIBER);
    expect(history).toHaveLength(1);
    expect(history[0]).toMatchObject({ role: "user", content: "Салом, хона мекобам" });
  });

  it("соседний WhatsApp при выключенном Instagram отвечает и тоже сохраняет входящее", async () => {
    await setToggles({ botInstagramEnabled: false, botWhatsappEnabled: true });
    qualify.mockResolvedValue({ reply: ["Салом! Дар кадом ноҳия?"], ready: false, confident: true, topic: "other", openQuestion: "", clientAnsweredOpenQuestion: false, lead: {} });

    const result = await processMessengerTurn({
      channel: "WHATSAPP",
      subscriberId: WA_SUBSCRIBER,
      text: "Салом, хона мекобам",
    });

    expect(result.shouldReply).not.toBe(false);
    expect(result.reply).toBe("Салом! Дар кадом ноҳия?");
    expect(qualify).toHaveBeenCalled();

    const history = await historyOf("WHATSAPP", WA_SUBSCRIBER);
    expect(history.map((m) => m.role)).toEqual(["user", "assistant"]);
    expect(history[0].content).toBe("Салом, хона мекобам");
  });
});
