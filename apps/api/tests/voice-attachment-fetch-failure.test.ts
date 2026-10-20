import { createCustomerMessengerFixture, type CustomerMessengerFixture } from "./helpers/customerMessengerFixture.js";
import { drainBackgroundTasks } from "../src/lib/shutdownState.js";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { prisma } from "../src/db.js";
import { processMessengerTurn as actualProcessMessengerTurn } from "../src/messengers/conversation.js";

/**
 * ГОЛОСОВОЕ, КОТОРОЕ НЕ УДАЛОСЬ ДАЖЕ СКАЧАТЬ (17.08.2026, живой случай).
 *
 * Клиент прислал два голосовых подряд без подписи, CDN Instagram на скачивание
 * ответил не-2xx (подписанная ссылка истекла/недоступна) — fetchOne молча
 * возвращал null, hadUnsupported становился true, но пометка «[📎 файл не
 * открылся]» приклеивалась ТОЛЬКО когда text или images уже не пусты. Тут пусто
 * и то, и другое — пометка не приклеивалась, ход падал в ветку "!text" с ПУСТЫМ
 * текстом: saveIncoming("") молча ничего не писал (сообщение клиента пропадало
 * из переписки без следа), а ответ выбирался по voiceNotUnderstood (которая
 * здесь ложная — она про неудачную РАСШИФРОВКУ уже скачанного файла, а не про
 * невозможность скачать), поэтому клиент получал не «не расслышал голосовое»,
 * а не относящееся к делу «не могу прочитать ваше сообщение». Два голосовых —
 * два независимых пустых хода без дебаунса — одна и та же фраза дважды.
 *
 * Модель и загрузчик подменены: тест не должен ни платить за токены, ни зависеть от сети.
 */

const { callAi } = vi.hoisted(() => ({ callAi: vi.fn() }));
vi.mock("../src/ai/client.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/ai/client.js")>()),
  callAiText: callAi,
}));

vi.mock("../src/messengers/attachments.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/messengers/attachments.js")>()),
  // Ровно то, что возвращает fetchAttachments, когда fetchOne получил не-2xx
  // на каждый источник: ничего не распозналось, но hadUnsupported честно true.
  fetchAttachments: async () => ({ images: [], audios: [], medias: [], hadUnsupported: true }),
  storeFetchedAttachments: () => [],
}));

let messengerFixture: CustomerMessengerFixture;
function processMessengerTurn(input: Parameters<typeof actualProcessMessengerTurn>[0]) {
  return actualProcessMessengerTurn({ ...input, ...messengerFixture.turnInput(input.subscriberId) });
}

const runId = Date.now().toString(36);
const SUBSCRIBER = `voice-fail-${runId}`;

let settingsBefore: { botReplyDelaySec: number; botReplyMaxWaitSec: number } | null = null;

beforeAll(async () => {
  messengerFixture = await createCustomerMessengerFixture("INSTAGRAM");
  const s = await prisma.settings.upsert({
    where: { id: "singleton" },
    update: {},
    create: { id: "singleton" },
    select: { botReplyDelaySec: true, botReplyMaxWaitSec: true },
  });
  settingsBefore = s;
  // Окно дебаунса в ноль: этот тест проверяет пропажу реплики, а не ожидание.
  await prisma.settings.update({ where: { id: "singleton" }, data: { botReplyDelaySec: 0, botReplyMaxWaitSec: 0 } });
  await prisma.botConversation.update({
    where: { id: (await messengerFixture.ensureConversation(SUBSCRIBER)).id },
    data: {
      channel: "INSTAGRAM",
      subscriberId: SUBSCRIBER,
      messages: [],
      leadDraft: { stage: "chatting" } as never,
    },
  });
});

afterAll(async () => {
  await drainBackgroundTasks(2000);
  if (settingsBefore) await prisma.settings.update({ where: { id: "singleton" }, data: settingsBefore });
  await messengerFixture?.dispose();
});

describe("Голосовое, которое не удалось скачать", () => {
  it("не пропадает из переписки и не отвечается жёсткой заглушкой про текст", async () => {
    callAi.mockResolvedValue({ reply: ["Бубахшед, овозиро нашунидам — бо матн нависед 🙂"], ready: false, confident: true, topic: "other", openQuestion: "", clientAnsweredOpenQuestion: false });
    callAi.mockClear();

    const result = await processMessengerTurn({
      channel: "INSTAGRAM",
      subscriberId: SUBSCRIBER,
      text: "",
      attachments: [{ url: "https://cdn.example/voice.ogg", type: "audio" }],
    });

    // Ход не должен уходить в раннюю ветку "!text" — модель вызвана, а не
    // возвращена жёстко зашитая фраза про "не могу прочитать ваше сообщение".
    expect(callAi).toHaveBeenCalledTimes(1);
    expect(result.reply).not.toContain("паёматонро хонда наметавонам");
    expect(result.aiUnavailable ?? false).toBe(false);
    expect(result.shouldReply).not.toBe(false);
    expect(result.reply).not.toBe("");

    const conv = await prisma.botConversation.findFirst({
      where: { channel: "INSTAGRAM", subscriberId: SUBSCRIBER },
      select: { messages: true },
    });
    const messages = (Array.isArray(conv?.messages) ? conv!.messages : []) as { role: string; content: string }[];
    // Реплика клиента ОБЯЗАНА остаться в переписке — раньше пропадала совсем.
    expect(messages.some((m) => m.role === "user" && m.content.includes("файл не открылся"))).toBe(true);
  });
});
