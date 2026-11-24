import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * РАЗБОР СУТОК БОТА 22–23.11.2026 — КОММЕНТАРИИ (замаскированные живые случаи).
 *  C.  K8 (Facebook): «Хона кучода» → под постом «Ба директ навиштем 📩 Чандхонагӣ…», а личное не ушло (`dm_failed`, 7 из 7 за
 *      сутки). Теперь сначала личное; не ушло — публичный ответ без слов о директе; причина отказа Meta — в пометке и журнале.
 *  B2. K14/K16 (Instagram): «обьект 117» дважды получил тот же «Какой объект вы имеете в виду?…». Тот же ответ тому же человеку
 *      под тем же постом второй раз не уходит — человеку (по реакции «🔥» — тихо).
 *  B3. K17/K18: «обьект 117» упал по пределу шагов (`round_limit`) — человек не узнал. Такой отказ — «бот запутался», не сбой:
 *      человеку всегда, при любом положении «Бот отвечает сам» и рубильника технических отказов.
 */
const mocks = vi.hoisted(() => ({ model: vi.fn(), graph: vi.fn(), privateReply: vi.fn(), push: vi.fn(), log: vi.fn(), buyers: vi.fn(), fetch: vi.fn() }));
vi.mock("../src/ai/client.js", async (importOriginal) => ({ ...(await importOriginal<typeof import("../src/ai/client.js")>()), callAiText: mocks.model }));
vi.mock("../src/messengers/humanPacing.js", async (importOriginal) => ({ ...(await importOriginal<typeof import("../src/messengers/humanPacing.js")>()), sleep: async () => {} }));
vi.mock("../src/messengers/meta.js", async (importOriginal) => ({ ...(await importOriginal<typeof import("../src/messengers/meta.js")>()), callGraph: mocks.graph,
  sendPrivateReply: mocks.privateReply, fetchWithRetry: async () => new Response(JSON.stringify({ permalink: "", caption: "Synthetic post" }), { status: 200 }) }));
vi.mock("../src/push.js", async (importOriginal) => ({ ...(await importOriginal<typeof import("../src/push.js")>()), sendPushToAgents: mocks.push }));
vi.mock("../src/lib/systemError.js", async (importOriginal) => ({ ...(await importOriginal<typeof import("../src/lib/systemError.js")>()), logSystemError: mocks.log }));
vi.mock("../src/lib/ownerBuyerMatch.js", async (importOriginal) => ({ ...(await importOriginal<typeof import("../src/lib/ownerBuyerMatch.js")>()), matchBuyersForListing: mocks.buyers }));
vi.mock("../src/lib/leadMagnet.js", async (importOriginal) => ({ ...(await importOriginal<typeof import("../src/lib/leadMagnet.js")>()), leadMagnetActive: async () => false,
  isFunnelKeyword: async () => null, hasPendingLeadMagnetDelivery: async () => false }));

const { prisma } = await import("../src/db.js");
const { encryptSecret } = await import("../src/crypto.js");
const { handleComment, privateReplyFailure } = await import("../src/messengers/comments.js");
type QueuedComment = import("../src/messengers/comments.js").QueuedComment;
const { resetAccountsCache } = await import("../src/messengers/accounts.js");
const { MetaGraphCallError } = await import("../src/lib/metaSendBlock.js");
const { withoutDirectMention, mentionsDirect } = await import("../src/ai/commentDirectMention.js");
const { samePublicReply, commentWantsAnswer } = await import("../src/lib/commentReplyRepeat.js");
const { commentNeed, commentSignalKind, plainCommentReason } = await import("../src/lib/commentWaitingAlert.js");
const { staffSignalAllowed } = await import("../src/lib/botAnswersItself.js");

const tag = `dr23-${randomUUID()}`;
const accountIds: string[] = [];
const accounts = new Map<string, string>();
let seq = 0;
const permissionError = () => new MetaGraphCallError("Graph API HTTP 403: (#10) Application does not have permission for this action",
  { status: 403, code: 10, subcode: null, type: "OAuthException", fbtraceId: null, message: "(#10) Application does not have permission for this action" });

async function comment(channel: "FACEBOOK" | "INSTAGRAM", text: string, opts: { author?: string; media?: string } = {}) {
  const row = await prisma.instagramComment.create({ data: { channel, commentId: `${tag}-${seq++}`, mediaId: opts.media ?? `${tag}-media`,
    accountExternalId: accounts.get(channel) ?? null, authorId: opts.author ?? `${tag}-author-${seq}`, text, replyDueAt: new Date() } });
  return row;
}
const publicPosts = () => mocks.graph.mock.calls.filter(([, , body, method]) => method !== "DELETE" && body && "message" in (body as object));

beforeAll(async () => {
  for (const channel of ["INSTAGRAM", "FACEBOOK"] as const) {
    const account = await prisma.messengerAccount.create({ data: { channel, externalId: `${tag}-${channel}`, title: "DR23 synthetic", token: encryptSecret("fake-no-provider-access") } });
    accounts.set(channel, account.externalId); accountIds.push(account.id);
  }
  resetAccountsCache();
});
beforeEach(() => {
  vi.clearAllMocks(); mocks.model.mockReset(); mocks.privateReply.mockReset();
  mocks.graph.mockImplementation(async (_url: string, _token?: string, body?: Record<string, unknown>, method?: string) => {
    if (method === "DELETE" || (body && ("hide" in body || "is_hidden" in body))) return { success: true };
    return { id: `${tag}-public-${seq}` };
  });
  mocks.push.mockResolvedValue(undefined); mocks.log.mockResolvedValue(undefined); mocks.buyers.mockResolvedValue(null);
  mocks.fetch.mockImplementation(async () => { throw new Error("No provider I/O in tests"); });
  vi.stubGlobal("fetch", mocks.fetch);
});
afterEach(() => { expect(mocks.fetch).not.toHaveBeenCalled(); });
afterAll(async () => {
  vi.unstubAllGlobals();
  await prisma.instagramComment.deleteMany({ where: { commentId: { startsWith: tag } } });
  const convs = await prisma.botConversation.findMany({ where: { subscriberId: { startsWith: tag } }, select: { contactProfileId: true } });
  await prisma.botConversation.deleteMany({ where: { subscriberId: { startsWith: tag } } });
  await prisma.contactProfile.deleteMany({ where: { id: { in: convs.flatMap(c => c.contactProfileId ? [c.contactProfileId] : []) }, clientId: null } }).catch(() => {});
  await prisma.aiBudgetCounter.deleteMany({ where: { peerId: { startsWith: tag } } });
  await prisma.messengerAccount.deleteMany({ where: { id: { in: accountIds } } }); resetAccountsCache();
});

describe("C. K8: сначала личное, «написали в директ» — только если оно ушло", () => {
  const K8 = { action: "reply", reply: "Ба директ навиштем 📩 Чандхонагӣ ва дар кадом тарафи шаҳр меҷӯед?", dm: "Ассалому алейкум! Чандхонагӣ меҷӯед?" };

  it("личное не ушло (нет права у приложения): под постом — без «директ», личное раньше публичного, причина Meta в пометке и журнале", async () => {
    mocks.model.mockResolvedValueOnce(K8);
    mocks.privateReply.mockRejectedValueOnce(permissionError());
    const row = await comment("FACEBOOK", "Хона кучода");
    expect(await handleComment(row as QueuedComment)).toBe("replied");
    const [post] = publicPosts();
    expect((post![2] as { message: string }).message).toBe("Чандхонагӣ ва дар кадом тарафи шаҳр меҷӯед?");
    expect(mocks.privateReply.mock.invocationCallOrder[0]!).toBeLessThan(mocks.graph.mock.invocationCallOrder.at(-1)!);
    const stored = await prisma.instagramComment.findUniqueOrThrow({ where: { id: row.id } });
    expect(stored).toMatchObject({ status: "REPLIED", replyText: "Чандхонагӣ ва дар кадом тарафи шаҳр меҷӯед?", note: "dm_failed:permission:10/-", dmSentAt: null });
    expect(mocks.log).toHaveBeenCalledWith("meta", expect.stringContaining("у приложения Meta нет права на личные"),
      expect.objectContaining({ dedupKey: "comment-dm-failed:FACEBOOK:10/-" }));
  });

  it("личное ушло — публичный ответ как есть, со словами о директе", async () => {
    mocks.model.mockResolvedValueOnce(K8);
    mocks.privateReply.mockResolvedValueOnce(`${tag}-dm`);
    const row = await comment("FACEBOOK", "Хона кучода");
    expect(await handleComment(row as QueuedComment)).toBe("replied");
    expect((publicPosts()[0]![2] as { message: string }).message).toBe(K8.reply);
  });

  it("ответ только о директе, а личное не ушло — нейтральный ответ без директа", async () => {
    mocks.model.mockResolvedValueOnce({ action: "reply", reply: "Ответили вам в директ 📩", dm: "Здравствуйте!" });
    mocks.privateReply.mockRejectedValueOnce(permissionError());
    const row = await comment("FACEBOOK", "Сколько стоит?");
    await handleComment(row as QueuedComment);
    const text = (publicPosts()[0]![2] as { message: string }).message;
    expect(mentionsDirect(text)).toBe(false);
    expect(text.length).toBeGreaterThan(10);
  });

  it("чистые: что считается словами о директе и что остаётся от ответа", () => {
    expect(withoutDirectMention("Ба директ навиштем 📩 Чандхонагӣ ва дар кадом тарафи шаҳр меҷӯед?")).toBe("Чандхонагӣ ва дар кадом тарафи шаҳр меҷӯед?");
    expect(withoutDirectMention("Написали вам в личные сообщения. Цена 460 000 сомони.")).toBe("Цена 460 000 сомони.");
    expect(mentionsDirect("Нархи ин хона 460 000 сомонӣ аст.")).toBe(false);
    expect(privateReplyFailure(new Error("timeout"))).toMatchObject({ kind: "other" });
    expect(privateReplyFailure(new MetaGraphCallError("x", { status: 400, code: 10, subcode: 2018278, type: null, fbtraceId: null, message: "outside window" })))
      .toMatchObject({ kind: "window", code: "10/2018278" });
  });

  it("личное ушло, но постановка публичного ответа упала — личное всё равно легло в переписку CRM (слепое ревью 23.11.2026, В1)", async () => {
    mocks.model.mockResolvedValueOnce(K8);
    mocks.privateReply.mockResolvedValueOnce(`${tag}-dm-v1`);
    // Первый вызов callGraph (meta.js) у этого потока — постановка публичного ответа; делаем его падать.
    mocks.graph.mockImplementationOnce(async () => { throw new Error("Graph API HTTP 500: temporary"); });
    const row = await comment("FACEBOOK", "Хона кучода");
    await expect(handleComment(row as QueuedComment)).rejects.toThrow("temporary");
    const conv = await prisma.botConversation.findFirst({ where: { channel: "FACEBOOK", subscriberId: row.authorId } });
    expect(conv?.messages).toEqual(expect.arrayContaining([expect.objectContaining({ role: "assistant", content: K8.dm })]));
  });
});

describe("B2. Тот же публичный ответ тому же человеку под тем же постом — не дважды", () => {
  const ASK = "Какой объект вы имеете в виду? Пришлите номер объекта или ссылку.";

  it("K14→K16: второй раз тот же вопрос под постом не уходит — комментарий человеку", async () => {
    const author = `${tag}-k14`;
    const first = await comment("INSTAGRAM", "@royal.home.tj обьект 117 состоит из 7 комнат", { author });
    await prisma.instagramComment.update({ where: { id: first.id }, data: { status: "REPLIED", replyText: ASK, repliedAt: new Date() } });
    mocks.model.mockResolvedValueOnce({ action: "reply", reply: ASK });
    const second = await comment("INSTAGRAM", "@royal.home.tj  обьект 117", { author });
    expect(await handleComment(second as QueuedComment)).toBe("escalated");
    expect(publicPosts()).toHaveLength(0);
    expect(mocks.privateReply).not.toHaveBeenCalled();
    expect(await prisma.instagramComment.findUniqueOrThrow({ where: { id: second.id } })).toMatchObject({ status: "ESCALATED", note: "duplicate_public_reply" });
    expect(mocks.push).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ tag: `ig-comment-${second.commentId}` }));
  });

  it("повтор на реакцию «🔥» — тихо, без человека; другой автор или другой пост — отвечаем", async () => {
    const author = `${tag}-fire`;
    const first = await comment("INSTAGRAM", "🔥🔥", { author });
    await prisma.instagramComment.update({ where: { id: first.id }, data: { status: "REPLIED", replyText: "Спасибо, рады, что понравилось 🤍", repliedAt: new Date() } });
    mocks.model.mockResolvedValueOnce({ action: "reply", reply: "Спасибо, рады, что понравилось!" });
    const again = await comment("INSTAGRAM", "🔥", { author });
    // Реакцию прежний путь закрывает сам (смайлик в ответ или тишина) — человека по ней не зовём.
    expect(await handleComment(again as QueuedComment)).not.toBe("escalated");
    expect(mocks.push).not.toHaveBeenCalled();
    mocks.model.mockResolvedValueOnce({ action: "reply", reply: "Спасибо, рады, что понравилось!" });
    const other = await comment("INSTAGRAM", "🔥", { author, media: `${tag}-other-media` });
    expect(await handleComment(other as QueuedComment)).toBe("replied");
  });

  it("чистые: сравнение без регистра, знаков и смайликов; «- ?» — вопрос, «🔥» — нет", () => {
    expect(samePublicReply("Какой объект вы имеете в виду?", "какой объект вы имеете в виду")).toBe(true);
    expect(samePublicReply("🙏💚", "🙏💚")).toBe(false);
    expect(commentWantsAnswer("@royal.home.tj - ?")).toBe(true);
    expect(commentWantsAnswer("🔥🔥")).toBe(false);
  });
});

describe("B3. Комментарий, на который бот не смог ответить, доходит до человека", () => {
  it("K17/K18: «round_limit» — не технический сбой, а «бот запутался»: человеку при любом положении настроек", () => {
    expect(commentNeed("FAILED", "managed_core:failed:round_limit")).toBe("human");
    expect(commentSignalKind("FAILED", "managed_core:failed:round_limit", null)).toBe("unanswered");
    expect(staffSignalAllowed({ on: true, kind: commentSignalKind("FAILED", "managed_core:failed:round_limit", null) })).toBe(true);
    expect(plainCommentReason("FAILED", "managed_core:failed:round_limit")).toBe("бот запутался в вопросе и ответа не подготовил");
  });
  it("повтор ответа — человеку всегда; бот ответил и сам позвал или спорная модерация — как раньше (решает «Бот отвечает сам»)", () => {
    expect(commentSignalKind("ESCALATED", "managed_core:duplicate_public_reply", null)).toBe("unanswered");
    expect(commentSignalKind("ESCALATED", "бот не знает", "Уточним и вернёмся")).toBe("bot_choice");
    expect(commentSignalKind("ESCALATED", "managed_core:moderation_hide_spam", null)).toBe("bot_choice");
    expect(commentSignalKind("ESCALATED", "managed_core:staff_review_required", null)).toBe("bot_choice");
    // Настоящий технический сбой — по-прежнему под рубильником технических отказов.
    expect(commentNeed("FAILED", "managed_core:failed:turn_deadline")).toBe("technical");
  });
});
