import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { createCustomerMessengerFixture, type CustomerMessengerFixture } from "./helpers/customerMessengerFixture.js";
import { drainBackgroundTasks } from "../src/lib/shutdownState.js";

/**
 * СЛОВА КЛИЕНТА НЕ ПРОПАДАЮТ (аудит 12.08.2026, критично).
 *
 * Клиент пишет «Сино, 3 хона», через три секунды ставит реакцию «🔥» или шлёт
 * голосовое, которое не расшифровалось. Первый ход в это время спит в окне
 * дебаунса, его текст лежит в буфере. Ветки, которые ничего не отвечают
 * (реакция, спам, нераспознанное голосовое, выключенный бот, пауза оператора),
 * двигали lastMessageAt — и спящий победитель просыпался, видел чужую отметку и
 * молчал, НЕ забрав свой буфер. Текст клиента не уходил ни модели, ни в
 * переписку: агент его не видел, ответа не было, а всплывал он позже
 * приклеенным к следующему сообщению как только что сказанный.
 *
 * Проверяется главное свойство: НИ ОДНО СЛОВО КЛИЕНТА НЕ ТЕРЯЕТСЯ.
 */

const { callAi } = vi.hoisted(() => ({ callAi: vi.fn() }));
vi.mock("../src/ai/client.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/ai/client.js")>()),
  callAiText: callAi,
}));

const { prisma } = await import("../src/db.js");
const { processMessengerTurn } = await import("../src/messengers/conversation.js");

const runId = Date.now().toString(36);
const SUBSCRIBER = `lost-${runId}`;
let settingsBefore: { botReplyDelaySec: number; botReplyMaxWaitSec: number } | null = null;
let instagram: CustomerMessengerFixture;

beforeAll(async () => {
  instagram = await createCustomerMessengerFixture("INSTAGRAM");
  const s = await prisma.settings.upsert({
    where: { id: "singleton" },
    update: {},
    create: { id: "singleton" },
    select: { botReplyDelaySec: true, botReplyMaxWaitSec: true },
  });
  settingsBefore = s;
});

afterEach(async () => {
  await drainBackgroundTasks(2000);
  const conv = await prisma.botConversation.findFirst({
    where: { endpointScopeId: instagram.transport.endpointScopeId, channel: "INSTAGRAM", subscriberId: SUBSCRIBER },
    select: { id: true, clientId: true },
  });
  if (conv) {
    if (conv.clientId) await prisma.client.deleteMany({ where: { id: conv.clientId } });
  }
  await instagram.cleanupConversations();
});

afterAll(async () => {
  if (settingsBefore) {
    await prisma.settings.update({ where: { id: "singleton" }, data: settingsBefore });
  }
  await instagram.dispose();
  await prisma.$disconnect();
});

/** Реплики клиента, сохранённые в переписке диалога. */
async function clientLines(): Promise<string[]> {
  const conv = await prisma.botConversation.findFirst({
    where: { channel: "INSTAGRAM", subscriberId: SUBSCRIBER },
    select: { messages: true },
  });
  const messages = (Array.isArray(conv?.messages) ? conv!.messages : []) as { role: string; content: string }[];
  return messages.filter((m) => m.role === "user").map((m) => m.content);
}

describe("Реакция клиента не глушит его же текст", () => {
  it("текст, а следом «🔥»: текст отвечен и лежит в переписке", async () => {
    callAi.mockResolvedValue({ reply: ["Раҳмат!"], ready: false, confident: true, topic: "other", openQuestion: "", clientAnsweredOpenQuestion: false });
    // Окно ожидания настоящее — иначе первый ход успевает закончиться до второго,
    // буфер пуст, и гонки не происходит: тест был бы зелёным и без правки.
    await prisma.settings.update({
      where: { id: "singleton" },
      data: { botReplyDelaySec: 3, botReplyMaxWaitSec: 6 },
    });

    const first = processMessengerTurn({ ...instagram.turnInput(SUBSCRIBER), text: "Сино, 3 хона" });
    await new Promise((r) => setTimeout(r, 400));
    // Реакция без текста: ветка silent — она НИЧЕГО не отвечает и раньше глушила
    // спящего победителя, не забрав его буфер.
    await processMessengerTurn({ ...instagram.turnInput(SUBSCRIBER), text: "🔥", silent: true });
    const firstResult = await first;

    // Спящий ход обязан выжить и ответить на слова клиента.
    expect(firstResult.shouldReply).not.toBe(false);
    const lines = await clientLines();
    expect(lines.join("\n")).toContain("Сино, 3 хона");
  });

  it("текст, а следом спам: слова клиента всё равно в переписке", async () => {
    callAi.mockResolvedValue({ reply: ["Хуб"], ready: false, confident: true, topic: "other", openQuestion: "", clientAnsweredOpenQuestion: false });
    await prisma.settings.update({
      where: { id: "singleton" },
      data: { botReplyDelaySec: 3, botReplyMaxWaitSec: 6 },
    });

    const first = processMessengerTurn({
      ...instagram.turnInput(SUBSCRIBER),
      text: "Фирдавсӣ, 2 хона мекобам",
    });
    await new Promise((r) => setTimeout(r, 400));
    // Похоже на рассылку: ветка спама тоже ничего не отвечает.
    await processMessengerTurn({
      ...instagram.turnInput(SUBSCRIBER),
      text: "СРОЧНО ЗАРАБОТОК ОТ 5000$ В ДЕНЬ ПЕРЕХОДИ ПО ССЫЛКЕ http://spam.example/a",
    });
    await first;

    const lines = await clientLines();
    expect(lines.join("\n")).toContain("Фирдавсӣ, 2 хона");
  });
});
