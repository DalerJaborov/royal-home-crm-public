import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { prisma } from "../src/db.js";
import { encryptSecret } from "../src/crypto.js";
import { captureCommentPhoneWhileBotOff, handleComment, type QueuedComment } from "../src/messengers/comments.js";
import { handleTelegramComment, ingestGroupComment } from "../src/messengers/telegramGroupComments.js";
import { enqueueComments } from "../src/messengers/commentsQueue.js";
import { drainBackgroundTasks } from "../src/lib/shutdownState.js";
import { COMMENT_HISTORY_PREFIX } from "../src/messengers/commentPhoneLead.js";
import { resetAccountsCache } from "../src/messengers/accounts.js";
import { COMMENT_PHONE_DM, COMMENT_PHONE_PUBLIC, COMMENT_SELF_REPLY } from "../src/ai/botSelfAnswerText.js";
import { releaseCommentPhoneHolds } from "../src/lib/commentPhoneHold.js";

/**
 * НОМЕР ИЗ КОММЕНТАРИЯ: КАРТОЧКА → ОДНО ЛИЧНОЕ С ВОПРОСОМ → СКРЫТЬ (решения владельца 18.11.2026; основа — #270).
 * Живые обработчики handleComment / handleTelegramComment на базе стенда; модель, Graph, YouTube и Telegram подменены,
 * ни одного запроса к провайдерам. Номера тестовые (93 + 7 цифр).
 */
const mocks = vi.hoisted(() => ({ model: vi.fn(), graph: vi.fn(), privateReply: vi.fn(), originalFetch: vi.fn(), telegramSend: vi.fn(),
  telegramDelete: vi.fn(), push: vi.fn(), log: vi.fn(), buyers: vi.fn(), blocked: vi.fn(), ytReply: vi.fn(), ytHold: vi.fn() }));
vi.mock("../src/ai/client.js", async (importOriginal) => ({ ...(await importOriginal<typeof import("../src/ai/client.js")>()), callAiText: mocks.model }));
vi.mock("../src/messengers/humanPacing.js", async (importOriginal) => ({ ...(await importOriginal<typeof import("../src/messengers/humanPacing.js")>()), sleep: async () => {} }));
vi.mock("../src/messengers/meta.js", async (importOriginal) => ({ ...(await importOriginal<typeof import("../src/messengers/meta.js")>()), callGraph: mocks.graph, sendPrivateReply: mocks.privateReply, fetchWithRetry: async () => new Response(JSON.stringify({ permalink: "", caption: "Synthetic post" }), { status: 200 }) }));
vi.mock("../src/messengers/youtubeComments.js", async (importOriginal) => ({ ...(await importOriginal<typeof import("../src/messengers/youtubeComments.js")>()), postYouTubeCommentReplyResponse: mocks.ytReply, holdYouTubeCommentForReview: mocks.ytHold, fetchYouTubeVideoInfo: async () => null }));
vi.mock("../src/telegram/api.js", async (importOriginal) => ({ ...(await importOriginal<typeof import("../src/telegram/api.js")>()), sendMessage: mocks.telegramSend, deleteChannelCommentMessage: mocks.telegramDelete }));
vi.mock("../src/push.js", async (importOriginal) => ({ ...(await importOriginal<typeof import("../src/push.js")>()), sendPushToAgents: mocks.push }));
vi.mock("../src/lib/systemError.js", async (importOriginal) => ({ ...(await importOriginal<typeof import("../src/lib/systemError.js")>()), logSystemError: mocks.log }));
vi.mock("../src/lib/ownerBuyerMatch.js", async (importOriginal) => ({ ...(await importOriginal<typeof import("../src/lib/ownerBuyerMatch.js")>()), matchBuyersForListing: mocks.buyers }));
vi.mock("../src/lib/leadMagnet.js", async (importOriginal) => ({ ...(await importOriginal<typeof import("../src/lib/leadMagnet.js")>()), leadMagnetActive: async () => false, isFunnelKeyword: async () => null, hasPendingLeadMagnetDelivery: async () => false }));
// Блокировка Meta (#273, lib/metaSendBlock.ts): метка аккаунта подменена.
vi.mock("../src/lib/metaSendBlock.js", async (importOriginal) => ({ ...(await importOriginal<typeof import("../src/lib/metaSendBlock.js")>()), isAccountSendBlocked: mocks.blocked }));

const tag = `cphone-${randomUUID()}`;
const groupChatId = `-100${BigInt(`0x${randomUUID().replaceAll("-", "").slice(0, 12)}`)}`;
const peers: string[] = [];
const phones: string[] = [];
let accountId = "";
let accountExternalId = "";
let sequence = 0;
let savedSettings: { workHoursStart: string | null; workHoursEnd: string | null; botAnswersItself: boolean; botCommentPhoneConversation: boolean } | null = null;
let fbAccountId = "";
const fbAccountExternalId = `${tag}-FACEBOOK`;
const decisions: unknown[] = [];
/** Решение модели по комментарию: она не узнала рекламу/спам/собственника — дальше решает дверь номера. */
const REPLY = { action: "reply", reply: "Салом! Агент ба шумо занг мезанад." };

const freshDigits = (): string => `93${String(Math.floor(Math.random() * 9_000_000) + 1_000_000)}`;
const tailOf = (digits: string): string => digits.slice(-9);
const clientsWith = (digits: string) => prisma.client.findMany({ where: { phone: { contains: tailOf(digits) } },
  select: { id: true, phone: true, source: true, commentPhoneHoldUntil: true, requirementsNotes: true } });
const notesOf = async (clientId: string) => (await prisma.interaction.findMany({ where: { clientId }, select: { notes: true } })).map((i) => i.notes ?? "");

async function instagramTurn(text: string, decision: unknown, opts: { parentId?: string; createdAt?: Date; channel?: "INSTAGRAM" | "FACEBOOK" | "YOUTUBE" } = {}) {
  const peer = `${tag}-${sequence++}`; peers.push(peer);
  if (decision !== undefined) decisions.push(decision);
  const channel = opts.channel ?? "INSTAGRAM";
  const row = await prisma.instagramComment.create({ data: { channel, commentId: peer, mediaId: `${tag}-media`,
    accountExternalId: channel === "YOUTUBE" ? null : channel === "FACEBOOK" ? fbAccountExternalId : accountExternalId, authorId: peer, text, parentId: opts.parentId ?? null,
    replyDueAt: new Date(), ...(opts.createdAt ? { createdAt: opts.createdAt } : {}) } });
  return { id: row.id, peer, run: () => handleComment(row as QueuedComment) };
}
const conversationOf = (peer: string) => prisma.botConversation.findUnique({ where: { channel_subscriberId: { channel: "INSTAGRAM", subscriberId: peer } } });
const userMessages = (messages: unknown): string[] =>
  (messages as Array<{ role: string; content: string }>).filter((m) => m.role === "user").map((m) => m.content);
const graphBodies = () => mocks.graph.mock.calls.map((call) => call[2] as Record<string, unknown> | undefined);
const publicReplies = () => graphBodies().filter((b) => b && "message" in b);
const hides = () => graphBodies().filter((b) => b && ("hide" in b || "is_hidden" in b));
const commentModelCalls = () => mocks.model.mock.calls.filter(([p]) => /-comment$/.test((p as { endpoint?: string }).endpoint ?? ""));

beforeAll(async () => {
  savedSettings = await prisma.settings.findUnique({ where: { id: "singleton" }, select: { workHoursStart: true, workHoursEnd: true, botAnswersItself: true,
    botCommentPhoneConversation: true } });
  // Разговор по номеру из комментария — ВКЛ для этого файла (по умолчанию ВЫКЛ, его ветка — в «оба тумблера ВЫКЛ» ниже).
  await prisma.settings.upsert({ where: { id: "singleton" }, update: { workHoursStart: "00:00", workHoursEnd: "23:59", botAnswersItself: false,
    botCommentPhoneConversation: true }, create: { id: "singleton", workHoursStart: "00:00", workHoursEnd: "23:59", botCommentPhoneConversation: true } });
  fbAccountId = (await prisma.messengerAccount.create({ data: { channel: "FACEBOOK", externalId: fbAccountExternalId, title: "cphone fb synthetic",
    token: encryptSecret("fake-no-provider-access") } })).id;
  accountExternalId = `${tag}-INSTAGRAM`;
  const account = await prisma.messengerAccount.create({ data: { channel: "INSTAGRAM", externalId: accountExternalId, title: "cphone synthetic", token: encryptSecret("fake-no-provider-access") } });
  accountId = account.id;
  resetAccountsCache();
});
beforeEach(() => {
  vi.clearAllMocks(); mocks.model.mockReset(); decisions.length = 0;
  mocks.model.mockImplementation(async (params: { endpoint?: string }) => (/-comment$/.test(params.endpoint ?? "") ? (decisions.shift() ?? null) : null));
  mocks.graph.mockImplementation(async (_url: string, _token: string, body?: Record<string, unknown>, method?: string) =>
    method === "DELETE" || (body && ("hide" in body || "is_hidden" in body)) ? { success: true } : { id: `${tag}-public-${mocks.graph.mock.calls.length}` });
  mocks.privateReply.mockImplementation(async (...args: unknown[]) => {
    const observe = args[6] as ((v: { messageId: string; recipientId: string | null }) => void) | undefined;
    observe?.({ messageId: `${tag}-dm`, recipientId: null });
    return `${tag}-dm`;
  });
  mocks.blocked.mockResolvedValue(false);
  mocks.ytReply.mockResolvedValue({ id: `${tag}-yt-reply` });
  mocks.ytHold.mockResolvedValue(undefined);
  mocks.telegramSend.mockResolvedValue({ message_id: 1 });
  mocks.telegramDelete.mockResolvedValue({ provider: "TELEGRAM", effect: "delete", outcome: "accepted", reason: "provider_confirmed" });
  mocks.push.mockResolvedValue(undefined); mocks.log.mockResolvedValue(undefined); mocks.buyers.mockResolvedValue(null);
  mocks.originalFetch.mockImplementation(async () => { throw new Error("No provider I/O in comment phone tests"); });
  vi.stubGlobal("fetch", mocks.originalFetch);
});
afterEach(() => { expect(mocks.originalFetch).not.toHaveBeenCalled(); });
afterAll(async () => {
  vi.unstubAllGlobals();
  if (savedSettings) await prisma.settings.update({ where: { id: "singleton" }, data: savedSettings });
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
  await prisma.processedMessage.deleteMany({ where: { channel: "comment-phone-lead", OR: [{ messageId: { contains: tag } }, { messageId: { startsWith: `TELEGRAM:${groupChatId}:` } }] } });
  await prisma.aiBudgetCounter.deleteMany({ where: { peerId: { in: peers } } });
  await prisma.messengerAccount.deleteMany({ where: { id: { in: [accountId, fbAccountId] } } }); resetAccountsCache();
});

describe("Instagram: номер в комментарии → карточка, одно личное, скрыть", () => {
  it("верхний уровень: карточка с придержкой 20 минут, ОДНО личное с вопросом о цели, публичного ответа нет, скрыт", async () => {
    const digits = freshDigits(); phones.push(digits);
    const turn = await instagramTurn(`Нарх чанд? Занг занед ${digits}`, REPLY);
    expect(await turn.run()).toBe("hidden");
    // Модель — только модерация (одно решение), её публичный ответ не уходит.
    expect(commentModelCalls()).toHaveLength(1);
    const [card] = await clientsWith(digits);
    expect(card).toBeTruthy();
    const holdMs = card!.commentPhoneHoldUntil!.getTime() - Date.now();
    expect(holdMs).toBeGreaterThan(18 * 60_000);
    expect(holdMs).toBeLessThanOrEqual(20 * 60_000);
    expect(mocks.privateReply).toHaveBeenCalledTimes(1);
    expect(mocks.privateReply.mock.calls[0]![1]).toBe(COMMENT_PHONE_DM.tg);
    expect(publicReplies()).toHaveLength(0);
    expect(hides()).toHaveLength(1);
    const conversation = await conversationOf(turn.peer);
    expect(conversation?.clientId).toBe(card!.id);
    expect(userMessages(conversation!.messages)).toEqual([`${COMMENT_HISTORY_PREFIX}Нарх чанд? Занг занед ${digits}`]);
    expect((conversation!.messages as Array<{ role: string; content: string }>).some((m) => m.role === "assistant" && m.content === COMMENT_PHONE_DM.tg)).toBe(true);
    const stored = await prisma.instagramComment.findUniqueOrThrow({ where: { id: turn.id } });
    expect(stored.status).toBe("HIDDEN");
    expect(stored.dmSentAt).not.toBeNull();
    // Заявка — штатное событие: строки «Здоровья системы» на каждую заявку больше нет.
    expect(mocks.log.mock.calls.filter(([, text]) => /оформлен заявкой/.test(String(text)))).toHaveLength(0);
    // Повтор разбора: ни второй карточки, ни второго личного.
    vi.clearAllMocks();
    decisions.push(REPLY);
    await turn.run();
    expect(await clientsWith(digits)).toHaveLength(1);
    expect(mocks.privateReply).not.toHaveBeenCalled();
    expect(userMessages((await conversationOf(turn.peer))!.messages)).toHaveLength(1);
  });

  it("ответ внутри ветки: личного нет — короткий публичный ответ без номера, скрыт, карточка сразу в раздачу с пометкой", async () => {
    const digits = freshDigits(); phones.push(digits);
    const turn = await instagramTurn(`Салом, хона дорам? ${digits}`, REPLY, { parentId: `${tag}-root` });
    expect(await turn.run()).toBe("hidden");
    expect(mocks.privateReply).not.toHaveBeenCalled();
    expect(publicReplies()).toHaveLength(1);
    const text = String(publicReplies()[0]!.message);
    expect(COMMENT_PHONE_PUBLIC.flatMap((p) => [p.ru, p.tg])).toContain(text);
    expect(text).not.toContain(tailOf(digits));
    expect(hides()).toHaveLength(1);
    const [card] = await clientsWith(digits);
    expect(card!.commentPhoneHoldUntil).toBeNull();
    expect((await notesOf(card!.id)).some((n) => /боту не удалось написать в личные \(комментарий внутри ветки\)/.test(n))).toBe(true);
  });

  it("Meta запретила аккаунту личные (#273): запасной путь — публичный ответ и скрытие", async () => {
    mocks.blocked.mockImplementation(async (_account: unknown, surface: string) => surface === "dm");
    const digits = freshDigits(); phones.push(digits);
    const turn = await instagramTurn(`Нархаш? ${digits}`, REPLY);
    expect(await turn.run()).toBe("hidden");
    expect(mocks.privateReply).not.toHaveBeenCalled();
    expect(publicReplies()).toHaveLength(1);
    const [card] = await clientsWith(digits);
    expect(card!.commentPhoneHoldUntil).toBeNull();
    expect((await notesOf(card!.id)).some((n) => /временно запретила аккаунту личные/.test(n))).toBe(true);
  });

  it("запрещены и комментарии: только заявка с пометкой, ни ответа, ни скрытия", async () => {
    mocks.blocked.mockResolvedValue(true);
    const digits = freshDigits(); phones.push(digits);
    const turn = await instagramTurn(`Нархаш? ${digits}`, REPLY);
    expect(await turn.run()).toBe("skipped");
    expect(mocks.graph).not.toHaveBeenCalled();
    expect(mocks.privateReply).not.toHaveBeenCalled();
    const [card] = await clientsWith(digits);
    expect(card!.commentPhoneHoldUntil).toBeNull();
  });

  it("личное не ушло (отказ Meta): публичный ответ, скрыт, карточка в раздачу", async () => {
    mocks.privateReply.mockRejectedValue(new Error('Graph API HTTP 400: {"error":{"code":10}}'));
    const digits = freshDigits(); phones.push(digits);
    const turn = await instagramTurn(`Нархаш? ${digits}`, REPLY);
    expect(await turn.run()).toBe("hidden");
    expect(publicReplies()).toHaveLength(1);
    expect((await clientsWith(digits))[0]!.commentPhoneHoldUntil).toBeNull();
  });

  it("скрыть не вышло: заявка остаётся, причина в хронологии и в журнале без тревоги", async () => {
    mocks.graph.mockImplementation(async (_url: string, _token: string, body?: Record<string, unknown>) =>
      body && "hide" in body ? { success: false } : { id: `${tag}-x` });
    const digits = freshDigits(); phones.push(digits);
    const turn = await instagramTurn(`Нархаш? ${digits}`, REPLY);
    expect(await turn.run()).toBe("skipped");
    const [card] = await clientsWith(digits);
    expect(card).toBeTruthy();
    expect((await notesOf(card!.id)).some((n) => /не удалось скрыть/.test(n))).toBe(true);
    const moderation = mocks.log.mock.calls.filter(([, text]) => /не подтвердила модерацию/.test(String(text)));
    expect(moderation.length).toBeGreaterThan(0);
    expect(moderation.every(([, , ctx]) => (ctx as { silent?: boolean }).silent === true)).toBe(true);
  });

  it("модель узнала рекламу чужой квартиры (delete): номер — «Прочее», не клиент; личного нет", async () => {
    const digits = freshDigits(); phones.push(digits);
    const turn = await instagramTurn(`Продаю свою квартиру, звоните ${digits}`, { action: "delete", reason: "реклама чужой квартиры" });
    expect(await turn.run()).toBe("deleted");
    expect(mocks.privateReply).not.toHaveBeenCalled();
    const [card] = await prisma.client.findMany({ where: { phone: { contains: tailOf(digits) } }, select: { kind: true } });
    expect(card?.kind).toBe("OTHER");
  });

  it("ограничитель круга (5 ответов под постом) номер не уносит: дверь номера срабатывает и там", async () => {
    const digits = freshDigits(); phones.push(digits);
    const turn = await instagramTurn(`Нархаш? ${digits}`, undefined);
    for (let i = 0; i < 5; i++) {
      await prisma.instagramComment.create({ data: { channel: "INSTAGRAM", commentId: `${turn.peer}-old-${i}`, mediaId: `${tag}-media`,
        accountExternalId, authorId: turn.peer, text: "Салом", status: "REPLIED", repliedAt: new Date(), replyDueAt: new Date() } });
    }
    expect(await turn.run()).toBe("hidden");
    expect(commentModelCalls()).toHaveLength(0);
    expect(await clientsWith(digits)).toHaveLength(1);
    expect(mocks.privateReply).toHaveBeenCalledTimes(1);
  });

  it("просьба о деньгах с номером: полное молчание, заявки нет, личного нет", async () => {
    const digits = freshDigits(); phones.push(digits);
    const turn = await instagramTurn(`Ёрдами шумоҳо даркор… лечение ребёнка ${digits}`, undefined);
    expect(await turn.run()).toBe("skipped");
    expect(await clientsWith(digits)).toHaveLength(0);
    expect(mocks.privateReply).not.toHaveBeenCalled();
  });

  it("номер сотрудника заявкой не становится и в «номер из комментария» не уходит", async () => {
    const staff = await prisma.agent.findFirstOrThrow({ where: { isActive: true, phone: { not: "" } }, select: { phone: true } });
    const turn = await instagramTurn(`Занг занед ${staff.phone}`, { action: "ignore" });
    await expect(turn.run()).resolves.toBe("skipped");
    expect((await conversationOf(turn.peer))?.clientId ?? null).toBeNull();
    expect(mocks.privateReply).not.toHaveBeenCalled();
  });
});

describe("ответ клиента в личных и молчание: раздача", () => {
  it("клиент ответил боту — придержка снята, его слова в хронологии; молчит — через срок с пометкой «боту не ответил»", async () => {
    const answered = freshDigits(); phones.push(answered);
    const a = await instagramTurn(`Нархаш? ${answered}`, REPLY);
    await a.run();
    const conversation = await conversationOf(a.peer);
    await prisma.botConversation.update({ where: { id: conversation!.id }, data: {
      messages: [...(conversation!.messages as object[]), { role: "user", content: "Хона мехарам, 2 ҳуҷра", at: new Date().toISOString() }] } });
    const silent = freshDigits(); phones.push(silent);
    const s = await instagramTurn(`Нархаш? ${silent}`, REPLY);
    await s.run();
    const [silentCard] = await clientsWith(silent);
    await prisma.client.update({ where: { id: silentCard!.id }, data: { commentPhoneHoldUntil: new Date(Date.now() - 1000) } });

    const released = await releaseCommentPhoneHolds();
    expect(released.answered).toBeGreaterThanOrEqual(1);
    expect(released.expired).toBeGreaterThanOrEqual(1);
    const [answeredCard] = await clientsWith(answered);
    expect(answeredCard!.commentPhoneHoldUntil).toBeNull();
    expect((await notesOf(answeredCard!.id)).some((n) => /клиент ответил боту в личных — «Хона мехарам, 2 ҳуҷра»/.test(n))).toBe(true);
    expect((await clientsWith(silent))[0]!.commentPhoneHoldUntil).toBeNull();
    expect((await notesOf(silentCard!.id)).some((n) => /боту не ответил/.test(n))).toBe(true);
  });

  it("придержка ещё не вышла и ответа нет — карточка ждёт", async () => {
    const digits = freshDigits(); phones.push(digits);
    await (await instagramTurn(`Нархаш? ${digits}`, REPLY)).run();
    await releaseCommentPhoneHolds();
    expect((await clientsWith(digits))[0]!.commentPhoneHoldUntil).not.toBeNull();
  });

  it("recipient_id ответа Meta отличается от автора (Facebook): переписка адресата — к той же карточке", async () => {
    const recipient = `${tag}-recipient-${sequence++}`; peers.push(recipient);
    mocks.privateReply.mockImplementation(async (...args: unknown[]) => {
      (args[6] as (v: { messageId: string; recipientId: string | null }) => void)({ messageId: `${tag}-dm`, recipientId: recipient });
      return `${tag}-dm`;
    });
    const digits = freshDigits(); phones.push(digits);
    await (await instagramTurn(`Нархаш? ${digits}`, REPLY)).run();
    const [card] = await clientsWith(digits);
    const recipientChat = await conversationOf(recipient);
    expect(recipientChat?.clientId).toBe(card!.id);
    // Переписка адресата знает, о чём бот спросил (ревью 1b, №5): ответ клиента ляжет к ней, а бот не начнёт заново.
    const messages = recipientChat!.messages as Array<{ role: string; content: string; mid?: string }>;
    expect(messages.some((m) => m.role === "user" && m.content.startsWith(COMMENT_HISTORY_PREFIX))).toBe(true);
    expect(messages.find((m) => m.role === "assistant")?.content).toBe(COMMENT_PHONE_DM.tg);
    expect(messages.find((m) => m.role === "assistant")?.mid).toBe(`${tag}-dm`);
  });
});

describe("ревью 1b: постоянный клиент, рубильники, двойное личное", () => {
  it("№3: у разговора уже есть карточка — новый номер из комментария ложится в неё запасным, с записью в хронологии", async () => {
    const known = freshDigits(); phones.push(known);
    const card = await prisma.client.create({ data: { fullName: `Постоянный ${tag}`, phone: `+992${known}`, source: "INSTAGRAM" } });
    const fresh = freshDigits(); phones.push(fresh);
    const turn = await instagramTurn(`Новый номер ${fresh}`, REPLY);
    const peerChat = await prisma.botConversation.create({ data: { channel: "INSTAGRAM", subscriberId: turn.peer, accountId, clientId: card.id, messages: [] } });
    await turn.run();
    const after = await prisma.client.findUniqueOrThrow({ where: { id: card.id }, select: { extraPhones: true } });
    expect(after.extraPhones.some((p) => p.endsWith(tailOf(fresh)))).toBe(true);
    expect((await notesOf(card.id)).some((n) => n.includes(fresh.slice(-7)))).toBe(true);
    // Ни второй карточки: новым главным номером никто не заведён.
    expect(await prisma.client.count({ where: { phone: { contains: tailOf(fresh) } } })).toBe(0);
    expect((await prisma.botConversation.findUnique({ where: { id: peerChat.id } }))?.clientId).toBe(card.id);
  });

  it("Н2: «уже разбирали», а карточки нет — дверь не скрывает и не пишет, разбор прежним путём", async () => {
    const digits = freshDigits(); phones.push(digits);
    const text = `Нархаш? ${digits}`;
    const turn = await instagramTurn(text, { action: "reply", reply: "Салом! Нархаш 41 000$." });
    await prisma.botConversation.create({ data: { channel: "INSTAGRAM", subscriberId: turn.peer, accountId,
      messages: [{ role: "user", content: `${COMMENT_HISTORY_PREFIX}${text}` }] } });
    expect(await turn.run()).toBe("replied");
    expect(mocks.privateReply).not.toHaveBeenCalled();
    expect(hides()).toHaveLength(0);
    expect(await clientsWith(digits)).toHaveLength(0);
  });

  it("Н3: у клиента карточка и действующий агент — общего личного нет, номер в карточку, комментарий скрыт", async () => {
    const agent = await prisma.agent.findFirstOrThrow({ where: { isActive: true }, select: { id: true } });
    const known = freshDigits(); phones.push(known);
    const card = await prisma.client.create({ data: { fullName: `Свой агент ${tag}`, phone: `+992${known}`, source: "INSTAGRAM", assignedAgentId: agent.id } });
    const fresh = freshDigits(); phones.push(fresh);
    const turn = await instagramTurn(`Ещё номер ${fresh}`, REPLY);
    await prisma.botConversation.create({ data: { channel: "INSTAGRAM", subscriberId: turn.peer, accountId, clientId: card.id, messages: [] } });
    expect(await turn.run()).toBe("hidden");
    expect(mocks.privateReply).not.toHaveBeenCalled();
    expect(publicReplies()).toHaveLength(0);
    const after = await prisma.client.findUniqueOrThrow({ where: { id: card.id }, select: { extraPhones: true } });
    expect(after.extraPhones.some((p) => p.endsWith(tailOf(fresh)))).toBe(true);
  });

  it("№6: бот на канале выключен (bot_off) — номер всё равно становится заявкой, без сообщений и скрытия", async () => {
    const digits = freshDigits(); phones.push(digits);
    const turn = await instagramTurn(`Нархаш? ${digits}`, undefined);
    const row = await prisma.instagramComment.findUniqueOrThrow({ where: { id: turn.id } });
    expect(await captureCommentPhoneWhileBotOff(row as QueuedComment)).toBe(true);
    expect(mocks.privateReply).not.toHaveBeenCalled();
    expect(mocks.graph).not.toHaveBeenCalled();
    expect(await clientsWith(digits)).toHaveLength(1);
    expect((await prisma.instagramComment.findUniqueOrThrow({ where: { id: turn.id } })).note).toMatch(/только заявка/);
  });

  it("№9: два комментария одного человека разобраны одновременно — личное одно", async () => {
    const author = `${tag}-author-${sequence++}`; peers.push(author);
    const a = freshDigits(), b = freshDigits(); phones.push(a, b);
    const rows = await Promise.all([a, b].map((digits, i) => prisma.instagramComment.create({ data: { channel: "INSTAGRAM",
      commentId: `${author}-c${i}`, mediaId: `${tag}-media`, accountExternalId, authorId: author, text: `Нархаш? ${digits}`, replyDueAt: new Date() } })));
    decisions.push(REPLY, REPLY);
    await Promise.all(rows.map((r) => handleComment(r as QueuedComment)));
    expect(mocks.privateReply).toHaveBeenCalledTimes(1);
  });

  it("№9: личное не ушло — отметка «писали» снимается (иначе следующий день не наступил бы)", async () => {
    mocks.privateReply.mockRejectedValue(new Error('Graph API HTTP 400: {"error":{"code":10}}'));
    const digits = freshDigits(); phones.push(digits);
    const turn = await instagramTurn(`Нархаш? ${digits}`, REPLY);
    await turn.run();
    expect((await prisma.instagramComment.findUniqueOrThrow({ where: { id: turn.id } })).dmSentAt).toBeNull();
  });
});

describe("СТОРОЖ: оба тумблера ВЫКЛ — поведение как в main (ревью #283, Б2/Б3)", () => {
  const both = { botAnswersItself: false, botCommentPhoneConversation: false };
  const restore = () => prisma.settings.update({ where: { id: "singleton" }, data: { botCommentPhoneConversation: true } });

  it.each(["INSTAGRAM", "FACEBOOK"] as const)("%s: номер под постом — ответ модели под постом, ни личного, ни скрытия, ни удаления; карточка есть", async (channel) => {
    await prisma.settings.update({ where: { id: "singleton" }, data: both });
    try {
      const digits = freshDigits(); phones.push(digits);
      const turn = await instagramTurn(`Цена? ${digits}`, { action: "reply", reply: "Салом! Агент ба шумо занг мезанад." }, { channel });
      expect(await turn.run()).toBe("replied");
      expect(publicReplies().map((b) => b!.message)).toEqual(["Салом! Агент ба шумо занг мезанад"]);
      expect(mocks.privateReply).not.toHaveBeenCalled();
      expect(hides()).toHaveLength(0);
      expect(mocks.graph.mock.calls.filter((call) => call[3] === "DELETE")).toHaveLength(0);
      expect(await clientsWith(digits)).toHaveLength(1);
    } finally { await restore(); }
  });

  it("INSTAGRAM: «не по теме» с матом и номером молча пропускается (как в main), не скрывается и не удаляется", async () => {
    await prisma.settings.update({ where: { id: "singleton" }, data: both });
    try {
      const digits = freshDigits(); phones.push(digits);
      const turn = await instagramTurn(`напиши мне код на Python для расчёта ипотеки, бля, мой номер ${digits}`, undefined);
      expect(await turn.run()).toBe("skipped");
      expect(mocks.graph).not.toHaveBeenCalled();
      expect(mocks.privateReply).not.toHaveBeenCalled();
      expect(commentModelCalls()).toHaveLength(0);
    } finally { await restore(); }
  });

  it("Telegram: «не по теме», похожее на объявление, молча пропускается — не удаляется (как в main)", async () => {
    await prisma.settings.update({ where: { id: "singleton" }, data: both });
    try {
      const digits = freshDigits(); phones.push(digits);
      const peer = `${tag}-tg-guard-${sequence++}`; peers.push(peer);
      const row = await prisma.telegramGroupComment.create({ data: { groupChatId, messageId: String(100000 + Math.floor(Math.random() * 1_000_000)),
        postMessageId: tag, authorId: peer, text: `напиши мне код на Python. Продаю 3-комн. квартиру, 58 кв, 15 этаж, тел ${digits}`, replyDueAt: new Date() } });
      expect(await handleTelegramComment(row, groupChatId)).toBe("skipped");
      expect(mocks.telegramDelete).not.toHaveBeenCalled();
      expect(mocks.telegramSend).not.toHaveBeenCalled();
    } finally { await restore(); }
  });

  it("Telegram: номер в обычном комментарии — ответ модели как в main, ничего не удаляется", async () => {
    await prisma.settings.update({ where: { id: "singleton" }, data: both });
    try {
      const digits = freshDigits(); phones.push(digits);
      const peer = `${tag}-tg-guard-${sequence++}`; peers.push(peer);
      decisions.push({ action: "reply", reply: "Салом! Агент занг мезанад." });
      const row = await prisma.telegramGroupComment.create({ data: { groupChatId, messageId: String(100000 + Math.floor(Math.random() * 1_000_000)),
        postMessageId: tag, authorId: peer, text: `Нарх чанд? ${digits}`, replyDueAt: new Date() } });
      expect(await handleTelegramComment(row, groupChatId)).toBe("replied");
      expect(mocks.telegramDelete).not.toHaveBeenCalled();
      expect(mocks.telegramSend).toHaveBeenCalledTimes(1);
    } finally { await restore(); }
  });
});

describe("второе ревью 1b: бот выключен при приёме, карточка в корзине", () => {
  it("№1: Instagram, бот выключен уже при приёме (SKIPPED bot_off) — номер всё равно заявка, без текстов и скрытия", async () => {
    const digits = freshDigits(); phones.push(digits);
    const peer = `${tag}-off-${sequence++}`; peers.push(peer);
    expect(await enqueueComments([{ channel: "INSTAGRAM", commentId: `${peer}-c`, mediaId: `${tag}-media`, accountExternalId, authorId: peer,
      text: `Нархаш? ${digits}` }], false)).toBe(1);
    await drainBackgroundTasks(15_000);
    expect(await clientsWith(digits)).toHaveLength(1);
    expect(mocks.privateReply).not.toHaveBeenCalled();
    expect(mocks.graph).not.toHaveBeenCalled();
    expect((await prisma.instagramComment.findUniqueOrThrow({ where: { commentId: `${peer}-c` } })).note).toMatch(/только заявка/);
  });

  it("№1: Telegram-обсуждение, бот выключен при приёме — номер заявка, комментарий не удаляется и без ответа", async () => {
    const digits = freshDigits(); phones.push(digits);
    const messageId = 500000 + Math.floor(Math.random() * 400_000);
    const accepted = await ingestGroupComment({ message_id: messageId, chat: { id: groupChatId as unknown as number }, from: { id: 77001, username: `${tag}-tgoff` },
      text: `Нарх чанд? ${digits}`, message_thread_id: messageId - 1 } as never, groupChatId, false);
    expect(accepted).toBe(true);
    await drainBackgroundTasks(15_000);
    const [card] = await clientsWith(digits);
    expect(card?.requirementsNotes).toMatch(/бот в обсуждении выключен/);
    expect(mocks.telegramSend).not.toHaveBeenCalled();
    expect(mocks.telegramDelete).not.toHaveBeenCalled();
    await prisma.telegramGroupComment.deleteMany({ where: { groupChatId, messageId: String(messageId) } });
  });

  it("№2: карточка постоянного клиента в корзине — штатный приём достаёт её, номер из комментария в ней", async () => {
    const known = freshDigits(); phones.push(known);
    const card = await prisma.client.create({ data: { fullName: `Из корзины ${tag}`, phone: `+992${known}`, source: "INSTAGRAM", kind: "BUYER",
      deletedAt: new Date() } });
    const fresh = freshDigits(); phones.push(fresh);
    const turn = await instagramTurn(`Новый номер ${fresh}`, REPLY);
    await prisma.botConversation.create({ data: { channel: "INSTAGRAM", subscriberId: turn.peer, accountId, clientId: card.id, messages: [] } });
    await turn.run();
    const after = await prisma.client.findUniqueOrThrow({ where: { id: card.id }, select: { deletedAt: true, phone: true, extraPhones: true } });
    expect(after.deletedAt).toBeNull();
    expect([after.phone, ...after.extraPhones].some((p) => p.endsWith(tailOf(fresh)))).toBe(true);
  });
});

describe("YouTube и Telegram-обсуждение", () => {
  it("YouTube: ответ под комментарием, заявка с пометкой сразу, комментарий «на проверку»", async () => {
    const digits = freshDigits(); phones.push(digits);
    const turn = await instagramTurn(`Нарх чанд? ${digits}`, REPLY, { channel: "YOUTUBE" });
    expect(await turn.run()).toBe("hidden");
    expect(mocks.ytReply).toHaveBeenCalledTimes(1);
    expect(mocks.ytHold).toHaveBeenCalledWith(turn.peer);
    const [card] = await clientsWith(digits);
    expect(card!.requirementsNotes).toMatch(/YouTube: личных сообщений там нет/);
    expect(card!.commentPhoneHoldUntil).toBeNull();
  });

  async function telegramTurn(text: string, decision: unknown) {
    const peer = `${tag}-tg-${sequence++}`; peers.push(peer);
    if (decision !== undefined) decisions.push(decision);
    const row = await prisma.telegramGroupComment.create({ data: { groupChatId, messageId: String(100000 + Math.floor(Math.random() * 1_000_000)), postMessageId: tag, authorId: peer, text, replyDueAt: new Date() } });
    return { id: row.id, run: () => handleTelegramComment(row, groupChatId) };
  }

  it("№8: «бот отвечает сам» в обсуждении — у того, кто оставил номер в этом комментарии, номер не просим", async () => {
    await prisma.settings.update({ where: { id: "singleton" }, data: { botAnswersItself: true } });
    try {
      const digits = freshDigits(); phones.push(digits);
      const turn = await telegramTurn(`Документы в порядке? ${digits}`, { action: "escalate", reason: "документы" });
      await turn.run();
      const sent = mocks.telegramSend.mock.calls.map((call) => String(call[1]));
      expect(sent.join(" ")).toMatch(/рақамро қабул кардем/u); // COMMENT_PHONE_PUBLIC[0] (точку в конце снимает фильтр примет)
      expect(sent.join(" ")).not.toMatch(/нависед|номер телефона/u);
    } finally {
      await prisma.settings.update({ where: { id: "singleton" }, data: { botAnswersItself: false } });
    }
  });

  it("Telegram: заявка с пометкой, комментарий не удаляется; повтор разбора дубля не даёт", async () => {
    const digits = freshDigits(); phones.push(digits);
    const turn = await telegramTurn(`Нарх чанд? ${digits}`, { action: "ignore" });
    expect(await turn.run()).toBe("skipped");
    const created = await clientsWith(digits);
    expect(created).toHaveLength(1);
    expect(created[0]!.source).toBe("TELEGRAM");
    expect(created[0]!.requirementsNotes).toMatch(/обсуждении Telegram/);
    expect(mocks.telegramDelete).not.toHaveBeenCalled();
    decisions.push({ action: "ignore" });
    await turn.run();
    expect(await clientsWith(digits)).toHaveLength(1);
  });
});

describe("«Бот отвечает сам» под постами", () => {
  it("ВКЛ: модель хотела позвать человека — пуша нет, бот сам отвечает шагом к номеру", async () => {
    await prisma.settings.update({ where: { id: "singleton" }, data: { botAnswersItself: true } });
    try {
      const turn = await instagramTurn("А документы на эту квартиру в порядке?", { action: "escalate", reason: "документы" });
      expect(await turn.run()).toBe("replied");
      expect(mocks.push).not.toHaveBeenCalled();
      expect(publicReplies().map((b) => b!.message)).toEqual([COMMENT_SELF_REPLY.ru]);
      const stored = await prisma.instagramComment.findUniqueOrThrow({ where: { id: turn.id } });
      expect(stored.status).toBe("REPLIED");
      expect(stored.note).toMatch(/^self_answer:/);
    } finally {
      await prisma.settings.update({ where: { id: "singleton" }, data: { botAnswersItself: false } });
    }
  });

  it("ВЫКЛ: как раньше — человеку пуш «бот не знает ответа»", async () => {
    const turn = await instagramTurn("А документы на эту квартиру в порядке?", { action: "escalate", reason: "документы", reply: "Уточним." });
    expect(await turn.run()).toBe("escalated");
    expect(mocks.push).toHaveBeenCalledTimes(1);
  });
});
