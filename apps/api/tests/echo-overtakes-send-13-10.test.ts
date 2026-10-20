import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { prisma } from "../src/db.js";
import { handleOutgoingEcho } from "../src/routes/webhooks.js";
import { IN_FLIGHT_ECHO_WINDOW_MS, isOwnInFlightEcho } from "../src/messengers/inFlightEcho.js";
import { createCustomerMessengerFixture, type CustomerMessengerFixture } from "./helpers/customerMessengerFixture.js";

/**
 * Скриншот владельца 13.10.2026 (Instagram, @dilnoza_l8): эхо ответа бота пришло
 * раньше, чем Graph API ответил на отправку, — отметки «отправили мы» ещё не было,
 * и CRM поставила боту паузу на 12 часов как будто за ответ сотрудника.
 */

const runId = Date.now().toString(36);
const SUBSCRIBER = `echo-race-${runId}`;
const BOT_TEXT = "Уточните, пожалуйста, какую цену Вы хотите за квартиру?";
let instagram: CustomerMessengerFixture;
beforeAll(async () => { instagram = await createCustomerMessengerFixture("INSTAGRAM"); });

beforeEach(async () => {
  await instagram.cleanupConversations();
});

afterAll(async () => {
  await instagram.dispose();
});

async function makeConversation(messages: unknown[]): Promise<string> {
  const conv = await prisma.botConversation.update({
    where: { id: (await instagram.ensureConversation(SUBSCRIBER)).id },
    data: { messages: messages as never },
  });
  return conv.id;
}

describe("эхо ответа бота, обогнавшее отправку", () => {
  it("живой случай: реплика бота без mid, эхо с тем же текстом — ни паузы, ни «вручную»", async () => {
    const id = await makeConversation([
      { role: "user", content: "Законченный ремонт", at: new Date(Date.now() - 10_000).toISOString() },
      { role: "assistant", content: BOT_TEXT, by: { kind: "bot" }, at: new Date(Date.now() - 8_000).toISOString() },
    ]);

    await handleOutgoingEcho({ channel: "INSTAGRAM", accountExternalId: instagram.externalId, senderId: SUBSCRIBER, text: BOT_TEXT, messageId: `mid-${runId}-a` });

    const conv = await prisma.botConversation.findUnique({ where: { id }, select: { messages: true, pausedUntil: true } });
    const messages = conv!.messages as { by?: { kind: string } }[];
    expect(conv!.pausedUntil).toBeNull();
    expect(messages.some((m) => m.by?.kind === "manual")).toBe(false);
    expect(messages).toHaveLength(2);
  });

  it("второй пузырь двухпузырного ответа узнаётся по части текста", async () => {
    const id = await makeConversation([
      {
        role: "assistant",
        content: "Здравствуйте! Наш консультант на связи\nРасскажите, где находится квартира?",
        by: { kind: "bot" },
        at: new Date().toISOString(),
        mid: `mid-${runId}-first`,
      },
    ]);

    await handleOutgoingEcho({
      channel: "INSTAGRAM",
      accountExternalId: instagram.externalId,
      senderId: SUBSCRIBER,
      text: "Расскажите, где находится квартира?",
      messageId: `mid-${runId}-second`,
    });

    const conv = await prisma.botConversation.findUnique({ where: { id }, select: { pausedUntil: true } });
    expect(conv!.pausedUntil).toBeNull();
  });

  it("сотрудник пишет СВОЙ текст — пауза по-прежнему ставится", async () => {
    const id = await makeConversation([
      { role: "assistant", content: BOT_TEXT, by: { kind: "bot" }, at: new Date().toISOString() },
    ]);

    await handleOutgoingEcho({
      channel: "INSTAGRAM",
      accountExternalId: instagram.externalId,
      senderId: SUBSCRIBER,
      text: "Добрый вечер, это Сурайё, наберу вам через 5 минут",
      messageId: `mid-${runId}-human`,
    });

    const conv = await prisma.botConversation.findUnique({ where: { id }, select: { pausedUntil: true } });
    expect(conv!.pausedUntil).not.toBeNull();
    expect(conv!.pausedUntil!.getTime()).toBeGreaterThan(Date.now());
  });
});

describe("isOwnInFlightEcho", () => {
  const now = Date.parse("2026-10-13T14:33:24.905Z");
  const botEntry = { role: "assistant", content: BOT_TEXT, by: { kind: "bot" }, at: "2026-10-13T14:33:16.954Z" };

  it("совпадение текста в окне — наше", () => {
    expect(isOwnInFlightEcho([botEntry], BOT_TEXT, now)).toBe(true);
    expect(isOwnInFlightEcho([botEntry], `  ${BOT_TEXT.replace(" ", "\n")} `, now)).toBe(true);
  });

  it("старше окна — не наше", () => {
    expect(isOwnInFlightEcho([botEntry], BOT_TEXT, Date.parse(botEntry.at) + IN_FLIGHT_ECHO_WINDOW_MS + 1)).toBe(false);
  });

  it("короткий ответ сотрудника, совпавший с КУСКОМ текста бота, — не наше (аудит Codex)", () => {
    expect(isOwnInFlightEcho([botEntry], "пожалуйста", now)).toBe(false);
    expect(isOwnInFlightEcho([{ ...botEntry, content: `Хорошо\n${BOT_TEXT}` }], "Хорошо", now)).toBe(true);
    expect(isOwnInFlightEcho([{ ...botEntry, content: `Хорошо, записал\n${BOT_TEXT}` }], "Хорошо", now)).toBe(false);
  });

  it("реплика с обоими mid, ручная реплика, пустое эхо — не наше", () => {
    expect(isOwnInFlightEcho([{ ...botEntry, mid: "a", mid2: "b" }], BOT_TEXT, now)).toBe(false);
    expect(isOwnInFlightEcho([{ ...botEntry, by: { kind: "manual" } }], BOT_TEXT, now)).toBe(false);
    expect(isOwnInFlightEcho([botEntry], "", now)).toBe(false);
    expect(isOwnInFlightEcho([botEntry], undefined, now)).toBe(false);
  });
});
