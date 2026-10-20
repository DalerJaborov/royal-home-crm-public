import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { waitFor } from "./helpers/waitFor.js";
import { createCustomerMessengerFixture, type CustomerMessengerFixture } from "./helpers/customerMessengerFixture.js";

/**
 * ЗАГОТОВЛЕННЫЕ ФРАЗЫ — НА ЯЗЫКЕ КЛИЕНТА (20.09.2026, выгрузка 775 живых
 * переписок, docs/bot-razbor-20-09.md).
 *
 * За месяц 141 раз человек писал по-русски и получал ответ по-таджикски, а в
 * обратную сторону — ОДИН раз. Односторонность и выдала причину: язык клиента
 * определяется кодом и учитывается в ответе модели, в переспросе номера и в
 * ответах стражей, но собственные заготовки messengers/conversation.ts
 * существовали только на таджикском. Оттуда же брались 55 реплик, где таджикская
 * заготовка и русский ответ модели склеивались в одну фразу.
 *
 * Таджикская сторона проверена рядом в тех же случаях: умолчание остаётся
 * таджикским, и bot-fast-greeting.test.ts стережёт таджикский ответ на «Салом».
 */

const { callAi } = vi.hoisted(() => ({ callAi: vi.fn() }));
vi.mock("../src/ai/client.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/ai/client.js")>()),
  callAiText: callAi,
}));

const { prisma } = await import("../src/db.js");
const { processMessengerTurn } = await import("../src/messengers/conversation.js");
const { rentRefusalReply } = await import("../src/ai/rentGuard.js");

const runId = Date.now().toString(36);
const prefix = `lang-${runId}`;
const fetchDenied = vi.fn(async () => { throw new Error("Unexpected external fetch in language fixture"); });

let settingsBefore: { botReplyDelaySec: number; botReplyMaxWaitSec: number } | null = null;
let fixture: CustomerMessengerFixture | undefined;

beforeAll(async () => {
  vi.stubGlobal("fetch", fetchDenied);
  const s = await prisma.settings.upsert({
    where: { id: "singleton" },
    update: {},
    create: { id: "singleton" },
    select: { botReplyDelaySec: true, botReplyMaxWaitSec: true },
  });
  settingsBefore = s;
  await prisma.settings.update({ where: { id: "singleton" }, data: { botReplyDelaySec: 1, botReplyMaxWaitSec: 3 } });
  fixture = await createCustomerMessengerFixture("INSTAGRAM");
});

afterAll(async () => {
  if (settingsBefore) await prisma.settings.update({ where: { id: "singleton" }, data: settingsBefore });
  await fixture?.dispose();
  expect(fetchDenied).not.toHaveBeenCalled();
  vi.unstubAllGlobals();
});

/** Таджикские буквы, которых в русском алфавите нет вовсе. */
const TAJIK_LETTERS = /[ҳҷӣӯқғ]/;

describe("заготовленные фразы на языке клиента", () => {
  it("«Здравствуйте» первым сообщением — быстрый ответ по-русски, а не по-таджикски", async () => {
    callAi.mockClear();
    const subscriberId = `${prefix}-greet-ru`;

    const result = await processMessengerTurn({ ...fixture!.turnInput(subscriberId), text: "Здравствуйте" });

    // Именно эту пару и видно было в выгрузке: русское приветствие → таджикский ответ.
    expect(result.reply).not.toMatch(TAJIK_LETTERS);
    expect(result.reply).toContain("Здравствуйте");
    // Быстрый путь по-прежнему без обращения к модели.
    expect(callAi).not.toHaveBeenCalled();
  });

  it("«Салом» по-прежнему получает таджикский ответ", async () => {
    callAi.mockClear();
    const subscriberId = `${prefix}-greet-tg`;

    const result = await processMessengerTurn({ ...fixture!.turnInput(subscriberId), text: "Салом" });

    expect(result.reply).toMatch(TAJIK_LETTERS);
  });

  it("пустой результат модели сохраняет русский вход для восстановления, без ложного ответа", async () => {
    const subscriberId = `${prefix}-empty`;
    // Первый ход: своими словами и по-русски, чтобы язык был распознан однозначно.
    callAi.mockClear();
    callAi.mockResolvedValue({ reply: [], ready: false, confident: true,
      topic: "other", openQuestion: "", clientAnsweredOpenQuestion: false });

    const result = await processMessengerTurn({
      ...fixture!.turnInput(subscriberId),
      text: "Здравствуйте, ищу двухкомнатную квартиру в центре, какой у вас выбор?",
    });

    expect(result).toMatchObject({ reply: "", shouldReply: false, aiUnavailable: true });
    expect(callAi).toHaveBeenCalledWith(expect.objectContaining({ endpoint: "lead-qualify" }));
    const conversation = await prisma.botConversation.findUniqueOrThrow({
      where: { channel_subscriberId: { channel: "INSTAGRAM", subscriberId } },
    });
    expect(conversation.clientId).toBeNull();
    expect(conversation.messages).toEqual(expect.arrayContaining([
      expect.objectContaining({ role: "user", content: "Здравствуйте, ищу двухкомнатную квартиру в центре, какой у вас выбор?" }),
    ]));
    const job = await waitFor(() => prisma.backgroundJob.findUnique({
      where: { dedupeKey: `ai-reply-retry:${conversation.id}` },
    }), { label: "invalid reply recovery job" });
    expect(job).toMatchObject({ type: "ai-reply-retry", payload: { conversationId: conversation.id } });
  });

  it("отказ по аренде — на языке клиента, и в одном месте на все каналы", () => {
    expect(rentRefusalReply("Здравствуйте, сдаёте квартиры в аренду?")).toContain("аренды у нас нет");
    expect(rentRefusalReply("Хонаи иҷора доред?")).toMatch(TAJIK_LETTERS);
    // Язык не распознан — остаётся таджикский, как и было.
    expect(rentRefusalReply("")).toMatch(TAJIK_LETTERS);
  });
});
