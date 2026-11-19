import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { prisma } from "../src/db.js";
import { encryptSecret } from "../src/crypto.js";
import { handleComment, type QueuedComment } from "../src/messengers/comments.js";
import { handleTelegramComment } from "../src/messengers/telegramGroupComments.js";
import { COMMENT_HISTORY_PREFIX } from "../src/messengers/commentPhoneLead.js";
import { resetAccountsCache } from "../src/messengers/accounts.js";

/**
 * Номер в комментарии становится заявкой, что бы ни решила модель и ушло ли личное (17.11.2026).
 * Живые обработчики handleComment / handleTelegramComment на базе стенда; модель, Graph и
 * Telegram подменены, ни одного запроса к провайдерам. Номера тестовые (93 + 7 цифр).
 */
const mocks = vi.hoisted(() => ({ model: vi.fn(), graph: vi.fn(), privateReply: vi.fn(), originalFetch: vi.fn(), telegramSend: vi.fn(), telegramDelete: vi.fn(), push: vi.fn(), log: vi.fn(), buyers: vi.fn() }));
vi.mock("../src/ai/client.js", async (importOriginal) => ({ ...(await importOriginal<typeof import("../src/ai/client.js")>()), callAiText: mocks.model }));
vi.mock("../src/messengers/humanPacing.js", async (importOriginal) => ({ ...(await importOriginal<typeof import("../src/messengers/humanPacing.js")>()), sleep: async () => {} }));
vi.mock("../src/messengers/meta.js", async (importOriginal) => ({ ...(await importOriginal<typeof import("../src/messengers/meta.js")>()), callGraph: mocks.graph, sendPrivateReply: mocks.privateReply, fetchWithRetry: async () => new Response(JSON.stringify({ permalink: "", caption: "Synthetic post" }), { status: 200 }) }));
vi.mock("../src/telegram/api.js", async (importOriginal) => ({ ...(await importOriginal<typeof import("../src/telegram/api.js")>()), sendMessage: mocks.telegramSend, deleteChannelCommentMessage: mocks.telegramDelete }));
vi.mock("../src/push.js", async (importOriginal) => ({ ...(await importOriginal<typeof import("../src/push.js")>()), sendPushToAgents: mocks.push }));
vi.mock("../src/lib/systemError.js", async (importOriginal) => ({ ...(await importOriginal<typeof import("../src/lib/systemError.js")>()), logSystemError: mocks.log }));
vi.mock("../src/lib/ownerBuyerMatch.js", async (importOriginal) => ({ ...(await importOriginal<typeof import("../src/lib/ownerBuyerMatch.js")>()), matchBuyersForListing: mocks.buyers }));
vi.mock("../src/lib/leadMagnet.js", async (importOriginal) => ({ ...(await importOriginal<typeof import("../src/lib/leadMagnet.js")>()), leadMagnetActive: async () => false, isFunnelKeyword: async () => null, hasPendingLeadMagnetDelivery: async () => false }));

const tag = `cphone-${randomUUID()}`;
const groupChatId = `-100${BigInt(`0x${randomUUID().replaceAll("-", "").slice(0, 12)}`)}`;
const peers: string[] = [];
const phones: string[] = [];
let accountId = "";
let accountExternalId = "";
let sequence = 0;
// Очередь решений модели ТОЛЬКО для комментариев: фоновое заполнение карточки после заявки тоже зовёт модель, и общий once-стек она бы съедала.
const decisions: unknown[] = [];

const freshDigits = (): string => `93${String(Math.floor(Math.random() * 9_000_000) + 1_000_000)}`;
const tailOf = (digits: string): string => digits.slice(-9);

async function clientsWith(digits: string) {
  return prisma.client.findMany({ where: { phone: { contains: tailOf(digits) } }, select: { id: true, phone: true, source: true } });
}

async function instagramTurn(text: string, decision: unknown, opts: { parentId?: string } = {}) {
  const peer = `${tag}-${sequence++}`; peers.push(peer);
  if (decision !== undefined) decisions.push(decision);
  const row = await prisma.instagramComment.create({ data: { channel: "INSTAGRAM", commentId: peer, mediaId: `${tag}-media`, accountExternalId, authorId: peer, text, parentId: opts.parentId ?? null, replyDueAt: new Date() } });
  return { id: row.id, peer, run: () => handleComment(row as QueuedComment) };
}
async function conversationOf(peer: string) {
  return prisma.botConversation.findUnique({ where: { channel_subscriberId: { channel: "INSTAGRAM", subscriberId: peer } } });
}
const userMessages = (messages: unknown): string[] =>
  (messages as Array<{ role: string; content: string }>).filter((m) => m.role === "user").map((m) => m.content);

beforeAll(async () => {
  await prisma.settings.upsert({ where: { id: "singleton" }, update: { workHoursStart: "00:00", workHoursEnd: "23:59" }, create: { id: "singleton", workHoursStart: "00:00", workHoursEnd: "23:59" } });
  accountExternalId = `${tag}-INSTAGRAM`;
  const account = await prisma.messengerAccount.create({ data: { channel: "INSTAGRAM", externalId: accountExternalId, title: "cphone synthetic", token: encryptSecret("fake-no-provider-access") } });
  accountId = account.id;
  resetAccountsCache();
});
beforeEach(() => {
  vi.clearAllMocks(); mocks.model.mockReset(); decisions.length = 0;
  mocks.model.mockImplementation(async (params: { endpoint?: string }) => (/-comment$/.test(params.endpoint ?? "") ? (decisions.shift() ?? null) : null));
  mocks.graph.mockResolvedValue({ id: `${tag}-public`, message_id: `${tag}-dm` });
  mocks.privateReply.mockResolvedValue(`${tag}-dm`);
  mocks.telegramSend.mockResolvedValue({ message_id: 1 });
  mocks.telegramDelete.mockResolvedValue({ provider: "TELEGRAM", effect: "delete", outcome: "accepted", reason: "provider_confirmed" });
  mocks.push.mockResolvedValue(undefined); mocks.log.mockResolvedValue(undefined); mocks.buyers.mockResolvedValue(null);
  mocks.originalFetch.mockImplementation(async () => { throw new Error("No provider I/O in comment phone tests"); });
  vi.stubGlobal("fetch", mocks.originalFetch);
});
afterEach(() => { expect(mocks.originalFetch).not.toHaveBeenCalled(); });
afterAll(async () => {
  vi.unstubAllGlobals();
  const conversations = await prisma.botConversation.findMany({ where: { subscriberId: { in: peers } }, select: { clientId: true, contactProfileId: true } });
  const found = (await Promise.all(phones.map((digits) => clientsWith(digits)))).flat().map((c) => c.id);
  const clientIds = [...new Set([...conversations.flatMap((c) => (c.clientId ? [c.clientId] : [])), ...found])];
  await prisma.botConversation.deleteMany({ where: { subscriberId: { in: peers } } });
  if (clientIds.length) {
    await prisma.interaction.deleteMany({ where: { clientId: { in: clientIds } } });
    await prisma.client.deleteMany({ where: { id: { in: clientIds } } });
  }
  const profileIds = conversations.flatMap((c) => (c.contactProfileId ? [c.contactProfileId] : []));
  await prisma.contactProfile.deleteMany({ where: { id: { in: profileIds } } }).catch(() => undefined);
  await prisma.instagramComment.deleteMany({ where: { commentId: { startsWith: tag } } });
  await prisma.telegramGroupComment.deleteMany({ where: { postMessageId: tag } });
  await prisma.aiBudgetCounter.deleteMany({ where: { peerId: { in: peers } } });
  await prisma.messengerAccount.deleteMany({ where: { id: accountId } }); resetAccountsCache();
});

describe("Instagram: номер в комментарии → заявка", () => {
  it("модель выбрала ignore — номер всё равно становится заявкой, повтор разбора дубля не даёт", async () => {
    const digits = freshDigits(); phones.push(digits);
    const turn = await instagramTurn(`Нарх чанд? Занг занед ${digits}`, { action: "ignore", reason: "nothing" });
    expect(await turn.run()).toBe("skipped");
    const created = await clientsWith(digits);
    expect(created).toHaveLength(1);
    const conversation = await conversationOf(turn.peer);
    expect(conversation?.clientId).toBe(created[0]!.id);
    expect(userMessages(conversation!.messages)).toEqual([`${COMMENT_HISTORY_PREFIX}Нарх чанд? Занг занед ${digits}`]);
    // Тот же комментарий разобран ещё раз (повтор после сбоя): карточка и запись — по-прежнему одна.
    decisions.push({ action: "ignore", reason: "nothing" });
    await turn.run();
    expect(await clientsWith(digits)).toHaveLength(1);
    expect(userMessages((await conversationOf(turn.peer))!.messages)).toHaveLength(1);
  });

  it("ответ внутри ветки (личное не уходит) — заявка есть", async () => {
    const digits = freshDigits(); phones.push(digits);
    const turn = await instagramTurn(`Салом, хона дорам? ${digits}`, { action: "reply", reply: "Салом! Агент ба Шумо занг мезанад.", dm: "Агар хоҳед, нависед." }, { parentId: `${tag}-root` });
    expect(await turn.run()).toBe("replied");
    expect(mocks.privateReply).not.toHaveBeenCalled();
    expect(await clientsWith(digits)).toHaveLength(1);
  });

  it("личное ушло — заявка есть, а комментарий в переписке записан один раз", async () => {
    const digits = freshDigits(); phones.push(digits);
    const turn = await instagramTurn(`Нарх чанд? ${digits}`, { action: "reply", reply: "Салом!", dm: "Могу рассказать подробнее." });
    expect(await turn.run()).toBe("replied");
    expect(mocks.privateReply).toHaveBeenCalledTimes(1);
    expect(await clientsWith(digits)).toHaveLength(1);
    const conversation = await conversationOf(turn.peer);
    expect(userMessages(conversation!.messages).filter((m) => m.startsWith(COMMENT_HISTORY_PREFIX))).toHaveLength(1);
    expect((conversation!.messages as Array<{ role: string }>).some((m) => m.role === "assistant")).toBe(true);
  });

  it("просьба о деньгах: полное молчание, заявки НЕТ (решение владельца)", async () => {
    const digits = freshDigits(); phones.push(digits);
    const turn = await instagramTurn(`Ёрдами шумоҳо даркор… лечение ребёнка ${digits}`, undefined);
    expect(await turn.run()).toBe("skipped");
    expect(mocks.model.mock.calls.filter(([p]) => /-comment$/.test(p.endpoint ?? ""))).toHaveLength(0);
    expect(await clientsWith(digits)).toHaveLength(0);
    const stored = await prisma.instagramComment.findUniqueOrThrow({ where: { id: turn.id } });
    expect(stored.status).toBe("SKIPPED");
  });

  it("отсечка «не по теме» молчит, но номер не уносит: заявка есть, модель не звали", async () => {
    const digits = freshDigits(); phones.push(digits);
    const turn = await instagramTurn(`напиши мне код на Python для расчёта ипотеки, мой номер ${digits}`, undefined);
    expect(await turn.run()).toBe("skipped");
    expect(mocks.model.mock.calls.filter(([p]) => /-comment$/.test(p.endpoint ?? ""))).toHaveLength(0);
    expect(await clientsWith(digits)).toHaveLength(1);
    const stored = await prisma.instagramComment.findUniqueOrThrow({ where: { id: turn.id } });
    expect(stored.status).toBe("SKIPPED");
  });

  it("без номера заявки нет; номер сотрудника заявкой не становится", async () => {
    const plain = await instagramTurn("Цена? Площадь 58, этаж 15", { action: "ignore" });
    await plain.run();
    expect((await conversationOf(plain.peer))?.clientId ?? null).toBeNull();

    const staff = await prisma.agent.findFirstOrThrow({ where: { isActive: true, phone: { not: "" } }, select: { phone: true } });
    const turn = await instagramTurn(`Занг занед ${staff.phone}`, { action: "ignore" });
    await expect(turn.run()).resolves.toBe("skipped");
    expect((await conversationOf(turn.peer))?.clientId ?? null).toBeNull();
  });
});

describe("Telegram-обсуждение: номер в комментарии → заявка", () => {
  async function telegramTurn(text: string, decision: unknown) {
    const peer = `${tag}-tg-${sequence++}`; peers.push(peer);
    if (decision !== undefined) decisions.push(decision);
    const row = await prisma.telegramGroupComment.create({ data: { groupChatId, messageId: String(100000 + sequence), postMessageId: tag, authorId: peer, text, replyDueAt: new Date() } });
    return { id: row.id, run: () => handleTelegramComment(row, groupChatId) };
  }

  it("ignore модели — заявка, источник Telegram; повтор разбора дубля не даёт", async () => {
    const digits = freshDigits(); phones.push(digits);
    const turn = await telegramTurn(`Нарх чанд? ${digits}`, { action: "ignore" });
    expect(await turn.run()).toBe("skipped");
    const created = await clientsWith(digits);
    expect(created).toHaveLength(1);
    expect(created[0]!.source).toBe("TELEGRAM");
    decisions.push({ action: "ignore" });
    await turn.run();
    expect(await clientsWith(digits)).toHaveLength(1);
  });

  it("просьба о деньгах — заявки нет; «не по теме» с номером — заявка есть", async () => {
    const money = freshDigits(); phones.push(money);
    expect(await (await telegramTurn(`Ёрдами шумоҳо даркор… лечение ребёнка ${money}`, undefined)).run()).toBe("skipped");
    expect(await clientsWith(money)).toHaveLength(0);
    const digits = freshDigits(); phones.push(digits);
    const turn = await telegramTurn(`напиши мне код на Python для расчёта ипотеки, мой номер ${digits}`, undefined);
    expect(await turn.run()).toBe("skipped");
    expect(mocks.model.mock.calls.filter(([p]) => /-comment$/.test(p.endpoint ?? ""))).toHaveLength(0);
    expect(await clientsWith(digits)).toHaveLength(1);
  });
});
