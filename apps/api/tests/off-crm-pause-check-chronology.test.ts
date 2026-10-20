import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * ПРОВЕРКА «ОБЪЯСНИЛ ЛИ КЛИЕНТ ПАУЗУ» ВИДИТ СВЕЖАЙШУЮ ПЕРЕПИСКУ (CHANNEL-NEW-29, аудит 04.10.2026).
 *
 * recentClientMessages складывала сообщения по каналам (свежие бот-диалоги, потом
 * старые, Telegram последним) и резала последние 10 массива, а не по времени:
 * при Telegram-диалоге из 10+ старых реплик свежее объяснение из Instagram не
 * попадало в запрос к модели, и директору уходило подозрение в уводе клиента.
 * Модель подменена, смотрим, что именно ей отдали.
 */

const { callAiText } = vi.hoisted(() => ({ callAiText: vi.fn() }));
vi.mock("../src/ai/client.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/ai/client.js")>()),
  callAiText,
}));

const { prisma } = await import("../src/db.js");
const { checkClientExplainedPause } = await import("../src/ai/offCrmPauseCheck.js");

const runId = Date.now().toString(36);
const clientIds: string[] = [];
const botConvIds: string[] = [];
const tgConvIds: string[] = [];

beforeEach(() => {
  callAiText.mockReset();
  callAiText.mockResolvedValue({ explained: true, reason: "уехал" });
});

afterAll(async () => {
  await prisma.botConversation.deleteMany({ where: { id: { in: botConvIds } } });
  await prisma.telegramConversation.deleteMany({ where: { id: { in: tgConvIds } } });
  await prisma.client.deleteMany({ where: { id: { in: clientIds } } });
});

const iso = (daysAgo: number, minute = 0) => new Date(Date.now() - daysAgo * 86_400_000 + minute * 60_000).toISOString();

describe("recentClientMessages через checkClientExplainedPause", () => {
  it("свежее объяснение из Instagram не вытесняется старым Telegram на 12 сообщений", async () => {
    const client = await prisma.client.create({
      data: {
        fullName: `Хронология ${runId}`,
        phone: `+99293${String(Math.floor(Math.random() * 9_000_000) + 1_000_000)}`,
        source: "INSTAGRAM",
        kind: "BUYER",
        currency: "TJS",
      },
    });
    clientIds.push(client.id);
    const bot = await prisma.botConversation.create({
      data: {
        channel: "INSTAGRAM",
        subscriberId: `chrono-${runId}`,
        clientId: client.id,
        lastMessageAt: new Date(),
        messages: [
          { role: "user", content: "Покупку отложим, уехали с гостями в отпуск", at: iso(0, -5) },
        ] as object[],
      },
    });
    botConvIds.push(bot.id);
    const old = Array.from({ length: 12 }, (_, i) => ({
      role: "user",
      content: `старое-сообщение-${i}`,
      at: iso(60, i),
    }));
    const tg = await prisma.telegramConversation.create({
      data: { chatId: `chrono-tg-${runId}`, clientId: client.id, lastMessageAt: new Date(Date.now() - 60 * 86_400_000), messages: old as object[] },
    });
    tgConvIds.push(tg.id);

    await checkClientExplainedPause(client.id);

    const user = String(callAiText.mock.calls[0]?.[0]?.user ?? "");
    expect(user).toContain("отложим");
    expect(user).not.toContain("старое-сообщение-0");
  });
});
