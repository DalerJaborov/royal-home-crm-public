import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { prisma } from "../src/db.js";
import { encryptSecret } from "../src/crypto.js";
import { handleComment, type QueuedComment } from "../src/messengers/comments.js";
import { handleTelegramComment } from "../src/messengers/telegramGroupComments.js";
import { resetAccountsCache } from "../src/messengers/accounts.js";

const mocks = vi.hoisted(() => ({ model: vi.fn(), graph: vi.fn(), privateReply: vi.fn(), originalFetch: vi.fn(), youtube: vi.fn(), youtubeModerate: vi.fn(), telegramSend: vi.fn(), telegramDelete: vi.fn(), push: vi.fn(), log: vi.fn(), buyers: vi.fn() }));
vi.mock("../src/ai/client.js", async (importOriginal) => ({ ...(await importOriginal<typeof import("../src/ai/client.js")>()), callAiText: mocks.model }));
vi.mock("../src/messengers/humanPacing.js", async (importOriginal) => ({ ...(await importOriginal<typeof import("../src/messengers/humanPacing.js")>()), sleep: async () => {} }));
vi.mock("../src/messengers/meta.js", async (importOriginal) => ({ ...(await importOriginal<typeof import("../src/messengers/meta.js")>()), callGraph: mocks.graph, sendPrivateReply: mocks.privateReply, fetchWithRetry: async () => new Response(JSON.stringify({ permalink: "", caption: "Synthetic post" }), { status: 200 }) }));
vi.mock("../src/messengers/youtubeComments.js", async (importOriginal) => ({ ...(await importOriginal<typeof import("../src/messengers/youtubeComments.js")>()), fetchYouTubeVideoInfo: async () => ({ caption: "Synthetic post" }), postYouTubeCommentReplyResponse: mocks.youtube, setYouTubeCommentHidden: mocks.youtubeModerate, deleteYouTubeComment: mocks.youtubeModerate }));
vi.mock("../src/telegram/api.js", async (importOriginal) => ({ ...(await importOriginal<typeof import("../src/telegram/api.js")>()), sendMessage: mocks.telegramSend, deleteChannelCommentMessage: mocks.telegramDelete }));
vi.mock("../src/push.js", async (importOriginal) => ({ ...(await importOriginal<typeof import("../src/push.js")>()), sendPushToAgents: mocks.push }));
vi.mock("../src/lib/systemError.js", async (importOriginal) => ({ ...(await importOriginal<typeof import("../src/lib/systemError.js")>()), logSystemError: mocks.log }));
vi.mock("../src/lib/ownerBuyerMatch.js", async (importOriginal) => ({ ...(await importOriginal<typeof import("../src/lib/ownerBuyerMatch.js")>()), matchBuyersForListing: mocks.buyers }));
vi.mock("../src/lib/leadMagnet.js", async (importOriginal) => ({ ...(await importOriginal<typeof import("../src/lib/leadMagnet.js")>()), leadMagnetActive: async () => false, isFunnelKeyword: async () => null, hasPendingLeadMagnetDelivery: async () => false }));

const tag = `c02a-${randomUUID()}`;
const groupChatId = `-100${BigInt(`0x${randomUUID().replaceAll("-", "").slice(0, 12)}`)}`;
const peers: string[] = []; const accountIds: string[] = [];
const accounts = new Map<string, string>();
const channels = ["INSTAGRAM", "FACEBOOK", "YOUTUBE", "TELEGRAM"] as const;
type Channel = typeof channels[number];
let sequence = 0;
let propertyId = "";
async function turn(channel: Channel, result: unknown) {
  const peer = `${tag}-${sequence++}`; peers.push(peer); mocks.model.mockResolvedValueOnce(result);
  if (channel === "TELEGRAM") {
    const row = await prisma.telegramGroupComment.create({ data: { groupChatId, messageId: String(sequence), postMessageId: tag, authorId: peer, text: "Цена?", replyDueAt: new Date() } });
    return { id: row.id, peer, run: () => handleTelegramComment(row, groupChatId) };
  }
  const row = await prisma.instagramComment.create({ data: { channel, commentId: peer, mediaId: `${tag}-media-${channel}`, accountExternalId: accounts.get(channel) ?? null, authorId: peer, text: "Цена?", replyDueAt: new Date() } });
  return { id: row.id, peer, run: () => handleComment(row as QueuedComment) };
}
const externalEffects = () => mocks.graph.mock.calls.length + mocks.privateReply.mock.calls.length + mocks.youtube.mock.calls.length + mocks.youtubeModerate.mock.calls.length + mocks.telegramSend.mock.calls.length + mocks.telegramDelete.mock.calls.length + mocks.push.mock.calls.length;

beforeAll(async () => {
  const property = await prisma.property.create({ data: { title: "C02a synthetic card", type: "APARTMENT", areaSqm: 60, price: 41000, currency: "TJS", address: "Synthetic private address", condition: "GOOD", status: "AVAILABLE", publishedOnSite: true,
    publishedPostIds: Object.fromEntries(["INSTAGRAM", "FACEBOOK", "YOUTUBE"].map((channel) => [channel, `${tag}-media-${channel}`])) } }); propertyId = property.id;
  for (const channel of ["INSTAGRAM", "FACEBOOK"] as const) {
    const account = await prisma.messengerAccount.create({ data: { channel, externalId: `${tag}-${channel}`, title: "C02a synthetic", token: encryptSecret("fake-no-provider-access") } });
    accounts.set(channel, account.externalId); accountIds.push(account.id);
  }
  resetAccountsCache();
});
beforeEach(() => {
  vi.clearAllMocks(); mocks.model.mockReset();
  mocks.graph.mockImplementation(async (_url: string, _token?: string, body?: Record<string, unknown>, method?: string) => {
    if (method === "DELETE" || (body && ("hide" in body || "is_hidden" in body))) return { success: true };
    return { id: `${tag}-public`, message_id: `${tag}-dm` };
  });
  mocks.privateReply.mockResolvedValue(`${tag}-dm`);
  mocks.youtube.mockResolvedValue({ id: `${tag}-youtube` }); mocks.telegramSend.mockResolvedValue({ message_id: 4754 });
  mocks.youtubeModerate.mockResolvedValue(undefined);
  mocks.telegramDelete.mockResolvedValue({ provider: "TELEGRAM", effect: "delete", outcome: "accepted", reason: "provider_confirmed" });
  mocks.push.mockResolvedValue(undefined); mocks.log.mockResolvedValue(undefined); mocks.buyers.mockResolvedValue(null);
  mocks.originalFetch.mockImplementation(async () => { throw new Error("No original provider I/O in comment contract tests"); });
  vi.stubGlobal("fetch", mocks.originalFetch);
});
afterEach(() => { expect(mocks.originalFetch).not.toHaveBeenCalled(); });
afterAll(async () => {
  vi.unstubAllGlobals();
  await prisma.instagramComment.deleteMany({ where: { commentId: { startsWith: tag } } });
  await prisma.telegramGroupComment.deleteMany({ where: { postMessageId: tag } });
  const profiles = await prisma.botConversation.findMany({ where: { subscriberId: { in: peers } }, select: { contactProfileId: true } });
  const profileIds = profiles.flatMap((row) => row.contactProfileId ? [row.contactProfileId] : []);
  await prisma.botConversation.deleteMany({ where: { subscriberId: { in: peers } } });
  await prisma.contactProfile.deleteMany({ where: { id: { in: profileIds }, clientId: null, identities: { every: { value: { in: peers } } }, botConversations: { every: { subscriberId: { in: peers } } } } });
  await prisma.aiBudgetCounter.deleteMany({ where: { peerId: { in: peers } } });
  if (propertyId) {
    await prisma.propertyExposure.deleteMany({ where: { propertyId } });
    await prisma.property.delete({ where: { id: propertyId } });
  }
  await prisma.messengerAccount.deleteMany({ where: { id: { in: accountIds } } }); resetAccountsCache();
});

describe.each(channels)("actual %s CommentDecision consumer", (channel) => {
  it.each([
    { action: "unknown", reply: "Useful text" }, { action: "reply", reply: { unsafe: true } },
    { action: "ignore", reason: ["PRIVATE-SENTINEL"] }, { action: "reply", dm: 42 },
    { action: "delete", actorId: "PRIVATE-RESOURCE-SENTINEL" },
    { action: "owner", propertyId: "PRIVATE-RESOURCE-SENTINEL" },
    { action: "escalate", reason: "x".repeat(2001) },
  ])("invalid whole result %# refuses before MODEL-selected downstream effects", async (result) => {
    const input = await turn(channel, result);
    await expect(input.run()).rejects.toThrow(/Модель не вернула решение/);
    expect(mocks.model).toHaveBeenCalledTimes(1); expect(externalEffects()).toBe(0); expect(mocks.buyers).not.toHaveBeenCalled();
    expect(await prisma.botConversation.findUnique({ where: { channel_subscriberId: { channel, subscriberId: input.peer } } })).toBeNull();
    expect(await prisma.propertyInterestEvent.count({ where: { propertyId, externalAuthorId: input.peer } })).toBe(0);
    expect(await prisma.propertyExposure.count({ where: { propertyId, recipientId: input.peer } })).toBe(0);
    expect(JSON.stringify(mocks.log.mock.calls)).not.toContain("PRIVATE-");
  });
  it("valid public reply reaches the actual handler instead of an invalid-result no-op", async () => {
    const input = await turn(channel, { action: "reply", reply: "Салом!" });
    expect(await input.run()).toBe("replied"); expect(externalEffects()).toBe(1);
    const stored = channel === "TELEGRAM" ? await prisma.telegramGroupComment.findUniqueOrThrow({ where: { id: input.id } }) : await prisma.instagramComment.findUniqueOrThrow({ where: { id: input.id } });
    expect(stored.status).toBe("REPLIED"); expect(stored.replyText).toBeTruthy();
    expect(mocks.model).toHaveBeenCalledTimes(1);
    if (channel === "YOUTUBE") {
      expect(mocks.youtube).toHaveBeenCalledTimes(1);
      expect(mocks.youtube).toHaveBeenCalledWith(input.peer, stored.replyText, undefined);
      expect(stored).toMatchObject({ replyCommentId: `${tag}-youtube` });
    }
  });
  it("valid ignore and empty optional fields retain their existing no-public-OUT path", async () => {
    const input = await turn(channel, { action: "ignore", reply: "", dm: " ", reason: "" });
    expect(await input.run()).toBe("skipped"); expect(externalEffects()).toBe(0);
  });
  it("valid owner without required reply keeps the existing owner branch", async () => {
    const input = await turn(channel, { action: "owner" });
    expect(await input.run()).toBe("hidden");
    expect(mocks.model).toHaveBeenCalledTimes(1); expect(mocks.buyers.mock.calls.length).toBe(channel === "TELEGRAM" ? 0 : 1);
  });
  it("valid escalation keeps its established outcome without inventing required reply", async () => {
    const input = await turn(channel, { action: "escalate", reason: "Нужен сотрудник" });
    expect(await input.run()).toBe("escalated"); expect(mocks.model).toHaveBeenCalledTimes(1);
  });
});

it.each(["YOUTUBE", "TELEGRAM"] as const)("actual %s rejects unsupported nonempty DM before any public or private effect", async (channel) => {
  const input = await turn(channel, { action: "reply", reply: "Good public answer", dm: "Private unsupported request" });
  await expect(input.run()).rejects.toThrow(/Модель не вернула решение/);
  expect(externalEffects()).toBe(0); expect(mocks.model).toHaveBeenCalledTimes(1);
});

it.each(["INSTAGRAM", "FACEBOOK"] as const)("actual %s keeps a valid optional private reply after public OUT", async (channel) => {
  const input = await turn(channel, { action: "reply", reply: "Салом!", dm: "Могу рассказать подробнее." });
  expect(await input.run()).toBe("replied");
  expect(mocks.model).toHaveBeenCalledTimes(1); expect(mocks.graph).toHaveBeenCalledTimes(1);
  expect(mocks.privateReply).toHaveBeenCalledTimes(1); expect(externalEffects()).toBe(2);
  const stored = await prisma.instagramComment.findUniqueOrThrow({ where: { id: input.id } });
  expect(stored.status).toBe("REPLIED"); expect(stored.dmSentAt).not.toBeNull(); expect(stored.dmText).toBeTruthy();
  expect(mocks.graph.mock.calls[0][1]).toBe("fake-no-provider-access");
  expect(mocks.graph.mock.calls[0][2]).toEqual({ message: stored.replyText });
  expect(new URL(mocks.graph.mock.calls[0][0]).pathname).toMatch(new RegExp(`/${input.peer}/${channel === "INSTAGRAM" ? "replies" : "comments"}$`));
  expect(mocks.privateReply).toHaveBeenCalledWith(input.peer, stored.dmText, [], "fake-no-provider-access", channel);
});
