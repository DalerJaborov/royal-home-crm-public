import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createCustomerMessengerFixture, type CustomerMessengerFixture } from "./helpers/customerMessengerFixture.js";
import { prisma } from "../src/db.js";
import { handleOutgoingEcho } from "../src/routes/webhooks.js";
import { OUTGOING_TEXT_WINDOW_MS, rememberOutgoingText, resetOutgoingMids } from "../src/messengers/outgoingMids.js";

/**
 * ЭХО С ДРУГОГО ПУТИ (ревью #344, 21.11.2026). Instagram отвечает через Страницу (ключ
 * компании), а эхо приходит по подписке входа через Instagram. Своё эхо CRM узнаёт по mid;
 * незнакомый mid = ручной ответ сотрудника = бот на паузе. Если бы mid на путях разошлись,
 * бот замолчал бы в каждой переписке. ФАКТ (прод 21.11, чтение): mid совпадают (24/24 наших
 * ответов). Здесь — страховка независимо от этого: эхо нашего приложения своё; без app_id —
 * совпадение текста с нашей отправкой тому же человеку за 2 минуты. Ручной ответ остаётся ручным.
 */

let fixture: CustomerMessengerFixture;
beforeAll(async () => { fixture = await createCustomerMessengerFixture("INSTAGRAM"); });
afterAll(async () => { await fixture?.dispose(); });

const runId = Date.now().toString(36);
const PEER = `echo2-${runId}`;

async function makeConversation(): Promise<string> {
  const conv = await prisma.botConversation.create({
    data: {
      channel: "INSTAGRAM", accountId: fixture.id, endpointScopeId: fixture.transport.endpointScopeId, subscriberId: PEER,
      messages: [{ role: "user", content: "Салом", at: new Date().toISOString() }] as never,
      leadDraft: { stage: "chatting" } as never,
    },
  });
  return conv.id;
}

async function state(id: string) {
  const conv = await prisma.botConversation.findUnique({ where: { id }, select: { messages: true, pausedUntil: true } });
  return { count: (conv?.messages as unknown[] | null)?.length ?? 0, paused: !!conv?.pausedUntil && conv.pausedUntil.getTime() > Date.now() };
}

const echo = (over: Partial<Parameters<typeof handleOutgoingEcho>[0]>) => handleOutgoingEcho({
  channel: "INSTAGRAM", accountExternalId: fixture.externalId, senderId: PEER, text: "", messageId: `mid-${Math.random()}`, ...over,
});

beforeEach(async () => {
  await fixture.cleanupConversations();
  resetOutgoingMids();
  await prisma.processedMessage.deleteMany({ where: { channel: "out:text", messageId: { contains: PEER } } });
});

describe("эхо нашего приложения с незнакомым mid — своё", () => {
  it.each(["1684679092586215", "1353986909508972"])("app %s: ни записи, ни паузы", async (appId) => {
    const id = await makeConversation();
    await echo({ text: "Ассалому алейкум, нархаш 450 000", echoAppId: appId });
    expect(await state(id)).toEqual({ count: 1, paused: false });
  });

  it("чужое приложение (Instagram сотрудника) с тем же незнакомым mid — ручной ответ, бот на паузе", async () => {
    const id = await makeConversation();
    await echo({ text: "Отвечаю с телефона", echoAppId: "124024574287414" });
    expect(await state(id)).toEqual({ count: 2, paused: true });
  });
});

describe("эхо без app_id — сверка по тексту и времени нашей отправки (2 минуты)", () => {
  it("тот же текст тому же человеку только что — своё", async () => {
    const id = await makeConversation();
    await rememberOutgoingText({ channel: "INSTAGRAM", peer: PEER, content: "Хона дар Сино, 3 хуҷра" });
    await echo({ text: "  Хона дар Сино, 3 хуҷра " });
    expect(await state(id)).toEqual({ count: 1, paused: false });
  });

  it("другой процесс (память пуста) — узнаёт по базе", async () => {
    const id = await makeConversation();
    await rememberOutgoingText({ channel: "INSTAGRAM", peer: PEER, content: "Перезвоним сегодня" });
    resetOutgoingMids();
    await echo({ text: "Перезвоним сегодня" });
    expect(await state(id)).toEqual({ count: 1, paused: false });
  });

  it("вложение того же вида — своё", async () => {
    const id = await makeConversation();
    await rememberOutgoingText({ channel: "INSTAGRAM", peer: PEER, content: "[вложение:image]" });
    await echo({ attachmentType: "image" });
    expect(await state(id)).toEqual({ count: 1, paused: false });
  });

  it("отправка старше 2 минут — уже не наша: ручной ответ, пауза", async () => {
    const id = await makeConversation();
    await rememberOutgoingText({ channel: "INSTAGRAM", peer: PEER, content: "Старый текст" });
    resetOutgoingMids();
    await prisma.processedMessage.updateMany({ where: { channel: "out:text", messageId: { contains: PEER } },
      data: { createdAt: new Date(Date.now() - OUTGOING_TEXT_WINDOW_MS - 5_000) } });
    await echo({ text: "Старый текст" });
    expect(await state(id)).toEqual({ count: 2, paused: true });
  });

  it("другой текст — ручной ответ сотрудника, пауза", async () => {
    const id = await makeConversation();
    await rememberOutgoingText({ channel: "INSTAGRAM", peer: PEER, content: "Текст бота" });
    await echo({ text: "Сотрудник пишет своё" });
    expect(await state(id)).toEqual({ count: 2, paused: true });
  });

  it("тот же текст ДРУГОМУ человеку — не считается", async () => {
    const id = await makeConversation();
    await rememberOutgoingText({ channel: "INSTAGRAM", peer: `${PEER}-other`, content: "Одинаковый текст" });
    await echo({ text: "Одинаковый текст" });
    expect(await state(id)).toEqual({ count: 2, paused: true });
    await prisma.processedMessage.deleteMany({ where: { channel: "out:text", messageId: { contains: `${PEER}-other` } } });
  });
});
