import { createCustomerMessengerFixture, type CustomerMessengerFixture } from "./helpers/customerMessengerFixture.js";
import { drainBackgroundTasks } from "../src/lib/shutdownState.js";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { prisma } from "../src/db.js";

/**
 * Старый путь лички (messengers/conversation.ts), ревью 1b: №2 — аварийный рубильник глушит ВСЕ готовые тексты до двери
 * (номер и заявка сохраняются молча); №12 — блокировка личных Meta (#273): модель не зовётся; №7 — офтопик при «бот
 * отвечает сам»: без карточки никого не зовём, с карточкой — как раньше. Модель и пуши подменены, база — стенд.
 */
const m = vi.hoisted(() => ({ ai: vi.fn(), push: vi.fn(async () => 0), blocked: vi.fn(async () => false) }));
vi.mock("../src/ai/client.js", async (importOriginal) => ({ ...(await importOriginal<typeof import("../src/ai/client.js")>()), callAiText: m.ai }));
vi.mock("../src/push.js", async (importOriginal) => ({ ...(await importOriginal<typeof import("../src/push.js")>()), sendPushToAgents: m.push }));
vi.mock("../src/lib/recipients.js", async (importOriginal) => ({ ...(await importOriginal<typeof import("../src/lib/recipients.js")>()),
  findAgentsWithPermission: async () => ["agent-1"] }));
vi.mock("../src/lib/metaSendBlock.js", async (importOriginal) => ({ ...(await importOriginal<typeof import("../src/lib/metaSendBlock.js")>()),
  isAccountSendBlocked: m.blocked }));

const { processMessengerTurn: actual } = await import("../src/messengers/conversation.js");
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
beforeEach(() => { vi.clearAllMocks(); m.blocked.mockResolvedValue(false); m.ai.mockResolvedValue(null); });
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
    expect(m.ai).not.toHaveBeenCalled();
    expect(await prisma.client.count({ where: { phone: { contains: phone.slice(-9) } } })).toBe(1);
  });
});

describe("№12: Meta запретила аккаунту личные — модель не зовётся", () => {
  it("вопрос без номера: ни модели, ни ответа", async () => {
    m.blocked.mockResolvedValue(true);
    const result = await turn({ channel: "INSTAGRAM", subscriberId: `blocked-q-${runId}`, text: "Сколько стоит квартира в Сино?" });
    expect(result.reply ?? "").toBe("");
    // Фоновое заполнение карточки из прошлого теста (client-current-intents) — не ход бота.
    expect(m.ai.mock.calls.filter(([p]) => (p as { endpoint?: string }).endpoint !== "client-current-intents")).toHaveLength(0);
  }, 60_000); // окно склейки сообщений старого пути (debounce) — до десятка секунд
  it("номер при блокировке: заявка сохраняется молча", async () => {
    m.blocked.mockResolvedValue(true);
    const phone = digits(); cleanup.push(phone);
    const result = await turn({ channel: "INSTAGRAM", subscriberId: `blocked-phone-${runId}`, text: `Звоните ${phone}` });
    expect(result.reply ?? "").toBe("");
    expect(await prisma.client.count({ where: { phone: { contains: phone.slice(-9) } } })).toBe(1);
  });
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
  it("ВКЛ, карточка есть — как раньше: человеку пуш", async () => {
    await prisma.settings.update({ where: { id: "singleton" }, data: { botAnswersItself: true } });
    const phone = digits(); cleanup.push(phone);
    const card = await prisma.client.create({ data: { fullName: `Офтопик ${runId}`, phone: `+992${phone}`, source: "INSTAGRAM" } });
    await third(`offtopic-card-${runId}`, card.id);
    expect(m.push).toHaveBeenCalledTimes(1);
  });
});
