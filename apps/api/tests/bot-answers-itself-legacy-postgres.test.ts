import { createCustomerMessengerFixture, type CustomerMessengerFixture } from "./helpers/customerMessengerFixture.js";
import { drainBackgroundTasks } from "../src/lib/shutdownState.js";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { prisma } from "../src/db.js";

/**
 * Старый путь лички (messengers/conversation.ts), ревью 1b: №2 — аварийный рубильник глушит ВСЕ готовые тексты до двери
 * (номер и заявка сохраняются молча); №12 — блокировка личных Meta (#273): ход идёт как в main (пересмотрено 20.11);
 * №7 — офтопик при «бот отвечает сам»: без карточки никого не зовём, с карточкой — как раньше. Модель и пуши подменены, база — стенд.
 */
const m = vi.hoisted(() => ({ ai: vi.fn(), push: vi.fn(async () => 0), blocked: vi.fn(async () => false), privateReply: vi.fn(), graph: vi.fn(),
  review: vi.fn(async () => ({ handled: false })) }));
vi.mock("../src/lib/dealReviewIntake.js", async (importOriginal) => ({ ...(await importOriginal<typeof import("../src/lib/dealReviewIntake.js")>()),
  tryHandleDealReviewReply: m.review }));
vi.mock("../src/messengers/meta.js", async (importOriginal) => ({ ...(await importOriginal<typeof import("../src/messengers/meta.js")>()),
  sendPrivateReply: m.privateReply, callGraph: m.graph,
  fetchWithRetry: async () => new Response(JSON.stringify({ permalink: "", caption: "Synthetic post" }), { status: 200 }) }));
vi.mock("../src/messengers/humanPacing.js", async (importOriginal) => ({ ...(await importOriginal<typeof import("../src/messengers/humanPacing.js")>()),
  sleep: async () => {} }));
vi.mock("../src/ai/client.js", async (importOriginal) => ({ ...(await importOriginal<typeof import("../src/ai/client.js")>()), callAiText: m.ai }));
vi.mock("../src/push.js", async (importOriginal) => ({ ...(await importOriginal<typeof import("../src/push.js")>()), sendPushToAgents: m.push }));
vi.mock("../src/lib/recipients.js", async (importOriginal) => ({ ...(await importOriginal<typeof import("../src/lib/recipients.js")>()),
  findAgentsWithPermission: async () => ["agent-1"] }));
vi.mock("../src/lib/metaSendBlock.js", async (importOriginal) => ({ ...(await importOriginal<typeof import("../src/lib/metaSendBlock.js")>()),
  isAccountSendBlocked: m.blocked }));

const { processMessengerTurn: actual } = await import("../src/messengers/conversation.js");
const { handleComment } = await import("../src/messengers/comments.js");
const { releaseCommentPhoneHolds } = await import("../src/lib/commentPhoneHold.js");
const { COMMENT_PHONE_DM } = await import("../src/ai/botSelfAnswerText.js");
const { mentionsPhoneRequest } = await import("../src/ai/replyGuards.js");
let fixture: CustomerMessengerFixture;
const turn = (input: Parameters<typeof actual>[0]) => actual({ ...input, ...fixture.turnInput(input.subscriberId) });
const runId = Date.now().toString(36);
const OFFTOPIC = "а кто тебя создал?";
const digits = () => `93${String(Math.floor(Math.random() * 9_000_000) + 1_000_000)}`;
const cleanup: string[] = [];
let saved: { botAnswersItself: boolean; botLeadOnlyMode: boolean } | null = null;
const savedOff = process.env.CUSTOMER_AGENT_CHANNEL_OFF;

beforeAll(async () => {
  fixture = await createCustomerMessengerFixture("INSTAGRAM");
  saved = await prisma.settings.findUnique({ where: { id: "singleton" }, select: { botAnswersItself: true, botLeadOnlyMode: true } });
  await prisma.settings.update({ where: { id: "singleton" }, data: { botLeadOnlyMode: false } });
});
beforeEach(() => { vi.clearAllMocks(); m.blocked.mockResolvedValue(false); m.ai.mockResolvedValue(null); m.review.mockResolvedValue({ handled: false }); });
afterEach(() => { if (savedOff === undefined) delete process.env.CUSTOMER_AGENT_CHANNEL_OFF; else process.env.CUSTOMER_AGENT_CHANNEL_OFF = savedOff; });
afterAll(async () => {
  await drainBackgroundTasks(2000);
  if (saved) await prisma.settings.update({ where: { id: "singleton" }, data: saved });
  const cards = await prisma.client.findMany({ where: { OR: cleanup.map((d) => ({ phone: { contains: d.slice(-9) } })) }, select: { id: true } });
  await prisma.botConversation.updateMany({ where: { clientId: { in: cards.map((c) => c.id) } }, data: { clientId: null } });
  await prisma.interaction.deleteMany({ where: { clientId: { in: cards.map((c) => c.id) } } });
  await prisma.client.deleteMany({ where: { id: { in: cards.map((c) => c.id) } } });
  await fixture?.dispose();
});

describe("№2: аварийный рубильник — готовые тексты старого пути не уходят, номер сохраняется", () => {
  it("номер при выключенном канале: заявка есть, «номер получил» клиенту не уходит, модель не зовётся", async () => {
    process.env.CUSTOMER_AGENT_CHANNEL_OFF = "instagram";
    const phone = digits(); cleanup.push(phone);
    const result = await turn({ channel: "INSTAGRAM", subscriberId: `off-phone-${runId}`, text: `Мой номер ${phone}` });
    expect(result.reply ?? "").toBe("");
    // Модель ОТВЕТА не зовётся. Фоновая оценка новой карточки («score-client» и соседи) идёт своим путём после приёма и в
    // этот ход не входит: без фильтра тест гонялся с ней и краснел через раз (20.11.2026, ревью #333).
    const background = new Set(["card-fill", "client-current-intents", "score-client"]);
    expect(m.ai.mock.calls.filter((call: unknown[]) => !background.has(String((call[0] as { endpoint?: string } | undefined)?.endpoint ?? "")))).toEqual([]);
    expect(await prisma.client.count({ where: { phone: { contains: phone.slice(-9) } } })).toBe(1);
  });
});

/**
 * №12 ПЕРЕСМОТРЕН 20.11.2026 (HANDOFF #283, блокер ревью 19.11): при блокировке личных Meta старый путь больше не молчит
 * сам — ход идёт как в main (#273): номер становится заявкой, ответ уходит к двери отправки, а та его не выпускает и сразу
 * передаёт переписку человеку (lib/metaSendBlock.ts). Подмена `isAccountSendBlocked` = true оставлена нарочно: вернёт
 * кто-то тихий выход в messengers/conversation.ts — эти два теста покраснеют.
 */
describe("№12: Meta запретила аккаунту личные — старый путь не глушит ход сам (как в main)", () => {
  it("вопрос без номера: ход идёт, ответ отдаётся двери отправки", async () => {
    m.blocked.mockResolvedValue(true);
    const background = new Set(["card-fill", "client-current-intents", "score-client"]);
    m.ai.mockImplementation(async (p: { endpoint?: string }) => background.has(p.endpoint ?? "") ? null
      : { reply: ["Подскажите, сколько комнат ищете?"], ready: false, confident: true, topic: "other", openQuestion: "", clientAnsweredOpenQuestion: false });
    const result = await turn({ channel: "INSTAGRAM", subscriberId: `blocked-q-${runId}`, text: "Сколько стоит квартира в Сино?" });
    expect(result.shouldReply).not.toBe(false);
    expect(result.reply ?? "").not.toBe("");
  }, 60_000); // окно склейки сообщений старого пути (debounce) — до десятка секунд
  it("номер при блокировке: заявка заводится, ответ отдаётся двери отправки", async () => {
    m.blocked.mockResolvedValue(true);
    const phone = digits(); cleanup.push(phone);
    const result = await turn({ channel: "INSTAGRAM", subscriberId: `blocked-phone-${runId}`, text: `Звоните ${phone}` });
    expect(await prisma.client.count({ where: { phone: { contains: phone.slice(-9) } } })).toBe(1);
    expect(result.reply ?? "").not.toBe("");
  });
});

describe("второе ревью 1b, №4: номер под постом → личное → ответ клиента в личке, режим «только заявки» ВКЛ", () => {
  it("ответ засчитан, карточка уходит в раздачу с целью, номер у клиента не просим", async () => {
    await prisma.settings.update({ where: { id: "singleton" }, data: { botLeadOnlyMode: true, botAnswersItself: false, botCommentPhoneConversation: true, botCommentPhoneLead: true } });
    try {
      m.ai.mockImplementation(async (p: { endpoint?: string }) => /-comment$/.test(p.endpoint ?? "") ? { action: "reply", reply: "Салом!" } : null);
      m.privateReply.mockResolvedValue(`dm-${runId}`);
      m.graph.mockImplementation(async (_u: string, _t: string, body?: Record<string, unknown>) => body && "hide" in body ? { success: true } : { id: `r-${runId}` });
      const subscriber = `cphone-lo-${runId}`, phone = digits(); cleanup.push(phone);
      await fixture.ensureConversation(subscriber);
      const row = await prisma.instagramComment.create({ data: { channel: "INSTAGRAM", commentId: `${subscriber}-c`, mediaId: `${runId}-m`,
        accountExternalId: fixture.externalId, authorId: subscriber, text: `Нархаш? ${phone}`, replyDueAt: new Date() } });
      expect(await handleComment(row as never)).toBe("hidden");
      expect(m.privateReply.mock.calls[0]![1]).toBe(COMMENT_PHONE_DM.tg);
      const card = await prisma.client.findFirstOrThrow({ where: { phone: { contains: phone.slice(-9) } }, select: { id: true, commentPhoneHoldUntil: true } });
      expect(card.commentPhoneHoldUntil).not.toBeNull();

      // Клиент отвечает в личке: бот не просит номер (он уже есть в карточке).
      const reply = await turn({ channel: "INSTAGRAM", subscriberId: subscriber, text: "Хона мехарам, ду ҳуҷра дар Сино" });
      expect(mentionsPhoneRequest(reply.reply ?? "")).toBe(false);

      const released = await releaseCommentPhoneHolds();
      expect(released.answered).toBeGreaterThanOrEqual(1);
      const after = await prisma.client.findUniqueOrThrow({ where: { id: card.id }, select: { commentPhoneHoldUntil: true } });
      expect(after.commentPhoneHoldUntil).toBeNull();
      const notes = (await prisma.interaction.findMany({ where: { clientId: card.id }, select: { notes: true } })).map((n) => n.notes ?? "");
      expect(notes.some((n) => n.includes("Хона мехарам"))).toBe(true);
    } finally {
      await prisma.instagramComment.deleteMany({ where: { commentId: { startsWith: `cphone-lo-${runId}` } } });
      await prisma.settings.update({ where: { id: "singleton" }, data: { botLeadOnlyMode: false, botCommentPhoneConversation: false, botCommentPhoneLead: false } });
    }
  }, 90_000);
});

describe("второе ревью 1b, №5: отзыв о сделке на выключенном канале", () => {
  async function reviewChat(subscriber: string) {
    const phone = digits(); cleanup.push(phone);
    const card = await prisma.client.create({ data: { fullName: `Отзыв ${runId}`, phone: `+992${phone}`, source: "INSTAGRAM" } });
    await prisma.botConversation.update({ where: { id: (await fixture.ensureConversation(subscriber)).id }, data: { clientId: card.id } });
  }
  it("рубильник выше ответа на отзыв: ответа клиенту нет, реплика в переписке; включённый канал — ответ как раньше", async () => {
    m.review.mockResolvedValue({ handled: true, reply: "Спасибо за оценку!" } as never);
    await reviewChat(`review-on-${runId}`);
    expect((await turn({ channel: "INSTAGRAM", subscriberId: `review-on-${runId}`, text: "5" })).reply).toBe("Спасибо за оценку!");
    process.env.CUSTOMER_AGENT_CHANNEL_OFF = "instagram";
    await reviewChat(`review-off-${runId}`);
    const result = await turn({ channel: "INSTAGRAM", subscriberId: `review-off-${runId}`, text: "5" });
    expect(result.reply ?? "").toBe("");
    expect(m.review).toHaveBeenCalledTimes(2); // сам отзыв записан и на выключенном канале
    const chat = await prisma.botConversation.findFirst({ where: { subscriberId: `review-off-${runId}` }, select: { messages: true } });
    expect((chat!.messages as Array<{ role: string }>).filter((x) => x.role === "assistant")).toHaveLength(0);
  }, 60_000);
});

describe("№7: офтопик третий раз подряд при «бот отвечает сам»", () => {
  async function third(subscriber: string, clientId: string | null) {
    await prisma.botConversation.update({ where: { id: (await fixture.ensureConversation(subscriber)).id }, data: {
      offTopicReplies: 2, ...(clientId ? { clientId } : {}),
      messages: [{ role: "user", content: OFFTOPIC }, { role: "assistant", content: "[⛔ бот молчит]" }] as never } });
    return turn({ channel: "INSTAGRAM", subscriberId: subscriber, text: OFFTOPIC });
  }
  it("ВКЛ, без карточки — никого не зовём, бота с диалога не снимаем", async () => {
    await prisma.settings.update({ where: { id: "singleton" }, data: { botAnswersItself: true } });
    await third(`offtopic-self-${runId}`, null);
    expect(m.push).not.toHaveBeenCalled();
  });
  it("ВЫКЛ (как в main), без карточки — человеку пуш (закрепление «оба ВЫКЛ = main» для личных)", async () => {
    await prisma.settings.update({ where: { id: "singleton" }, data: { botAnswersItself: false, botCommentPhoneConversation: false, botCommentPhoneLead: false } });
    await third(`offtopic-off-${runId}`, null);
    expect(m.push).toHaveBeenCalledTimes(1);
  });
  it("ВКЛ, карточка есть — как раньше: человеку пуш", async () => {
    await prisma.settings.update({ where: { id: "singleton" }, data: { botAnswersItself: true } });
    const phone = digits(); cleanup.push(phone);
    const card = await prisma.client.create({ data: { fullName: `Офтопик ${runId}`, phone: `+992${phone}`, source: "INSTAGRAM" } });
    await third(`offtopic-card-${runId}`, card.id);
    expect(m.push).toHaveBeenCalledTimes(1);
  });
});
