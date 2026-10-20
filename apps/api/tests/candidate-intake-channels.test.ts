import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createCustomerMessengerFixture, type CustomerMessengerFixture } from "./helpers/customerMessengerFixture.js";

/**
 * КАНДИДАТ НИКОГДА НЕ ОСТАЁТСЯ У АГЕНТА — ВО ВСЕХ КАНАЛАХ ПЕРЕПИСКИ (02.10.2026).
 *
 * Правило владельца было сделано в Telegram-боте, а в остальных каналах держалось
 * наполовину (разбор приёма кандидатов):
 *  · Meta: «старую карточку» искали только через botConversation.clientId, а приём
 *    номера зовётся ровно когда он пуст — агент не снимался никогда;
 *  · Meta, привязанный диалог (WhatsApp по номеру): анкета писалась, карточка
 *    оставалась у агента;
 *  · каждый следующий номер — снова «💼 Новый кандидат» и весь разговор в анкету
 *    заново;
 *  · Telegram-бот: сперва карточка «прочего обращения» (свой пуш), потом пуш о
 *    кандидате — два уведомления на одно событие;
 *  · Telegram Direct Messages: кандидатов не знал вовсе, «агент свяжется»;
 *  · «позвоните мне» от кандидата поднимало дежурного, если модель в этом ходе
 *    не заполнила анкету.
 *
 * Модель и транспорт подменены; уведомление руководству — шпион (считаем, сколько
 * раз позвали), снятие агента — настоящее.
 */

const { callAiText, sendMessage, requestContact, removeKeyboard, notifyCandidateOwners, notifyHumanAsk } = vi.hoisted(
  () => ({
    callAiText: vi.fn(),
    sendMessage: vi.fn(async (_chatId: string, _text: string, _replyTo?: number, _topicId?: number) => {}),
    requestContact: vi.fn(async (_chatId: string, _text: string) => {}),
    removeKeyboard: vi.fn(async (_chatId: string, _text: string) => {}),
    notifyCandidateOwners: vi.fn(async (_input: { name?: string | null; channel: string; conversationId: string; why: string }) => {}),
    notifyHumanAsk: vi.fn(async (_input: unknown) => {}),
  })
);

vi.mock("../src/ai/client.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/ai/client.js")>()),
  callAiText,
}));
vi.mock("../src/telegram/api.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/telegram/api.js")>()),
  sendMessage,
  requestContact,
  removeKeyboard,
}));
vi.mock("../src/lib/clientToCandidate.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/lib/clientToCandidate.js")>()),
  notifyCandidateOwners,
}));
vi.mock("../src/lib/callbackRequests.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/lib/callbackRequests.js")>()),
  notifyHumanAsk,
  routeMessengerCallbackRequest: vi.fn(async () => false),
}));

delete process.env.TELEGRAM_BOT_TOKEN;

const { prisma } = await import("../src/db.js");
const { acceptLead, processMessengerTurn } = await import("../src/messengers/conversation.js");
const { handleTelegramUpdate } = await import("../src/telegram/bot.js");
const { recordJobApplication, captureCandidate } = await import("../src/lib/jobApplications.js");
const { createTestAgent } = await import("./helpers/ownAgent.js");
const { deleteAgentsWithTraces } = await import("./helpers/cleanupAgents.js");
const { waitFor } = await import("./helpers/waitFor.js");

const runId = Date.now().toString(36);
const agentIds: string[] = [];
const clientIds: string[] = [];
const botConvIds: string[] = [];
const profileIds: string[] = [];
const propertyIds: string[] = [];
const districtIds: string[] = [];
const tgChatIds: string[] = [];
const DM_CHAT_ID = -(2_100_000_000_000 + (Date.now() % 1_000_000_000));

/** Номер, которого нет в базе: 93 + 7 случайных цифр. */
function freshDigits(): string {
  return `93${String(Math.floor(Math.random() * 9_000_000) + 1_000_000)}`;
}

const SETTINGS = {
  botEnabled: true,
  botTelegramEnabled: true,
  telegramOwnerChatId: true,
  telegramDirectMessagesEnabled: true,
  botCanHandleVacancies: true,
  botReplyDelaySec: true,
  botReplyMaxWaitSec: true,
  workHoursStart: true,
  workHoursEnd: true,
} as const;
let savedSettings: Record<string, unknown> | null = null;
let instagram: CustomerMessengerFixture;
let whatsapp: CustomerMessengerFixture;

beforeAll(async () => {
  instagram = await createCustomerMessengerFixture("INSTAGRAM");
  whatsapp = await createCustomerMessengerFixture("WHATSAPP");
  savedSettings = await prisma.settings.upsert({
    where: { id: "singleton" },
    update: {},
    create: { id: "singleton" },
    select: SETTINGS,
  });
  await prisma.settings.update({
    where: { id: "singleton" },
    data: {
      botEnabled: true,
      botTelegramEnabled: true,
      telegramOwnerChatId: null,
      telegramDirectMessagesEnabled: true,
      botCanHandleVacancies: true,
      botReplyDelaySec: 1,
      botReplyMaxWaitSec: 3,
      workHoursStart: "00:00",
      workHoursEnd: "24:00",
    },
  });
});

afterAll(async () => {
  if (savedSettings) await prisma.settings.update({ where: { id: "singleton" }, data: savedSettings });
  const tgConvs = await prisma.telegramConversation.findMany({ where: { chatId: { in: tgChatIds } }, select: { id: true } });
  const dmConvs = await prisma.telegramDirectConversation.findMany({
    where: { chatId: String(DM_CHAT_ID) },
    select: { id: true },
  });
  const convIds = [...botConvIds, ...tgConvs.map((c) => c.id), ...dmConvs.map((c) => c.id)];
  await prisma.jobApplication.deleteMany({
    where: { OR: [{ conversationId: { in: convIds } }, { contactProfileId: { in: profileIds } }] },
  });
  await instagram?.dispose();
  await whatsapp?.dispose();
  await prisma.telegramConversation.deleteMany({ where: { chatId: { in: tgChatIds } } });
  await prisma.telegramDirectConversation.deleteMany({ where: { chatId: String(DM_CHAT_ID) } });
  await prisma.property.deleteMany({ where: { id: { in: propertyIds } } });
  await prisma.district.deleteMany({ where: { id: { in: districtIds } } });
  await prisma.interaction.deleteMany({ where: { clientId: { in: clientIds } } });
  await prisma.client.deleteMany({ where: { id: { in: clientIds } } });
  await prisma.contactProfile.deleteMany({ where: { id: { in: profileIds } } });
  await deleteAgentsWithTraces(agentIds);
});

beforeEach(() => {
  callAiText.mockReset();
  callAiText.mockResolvedValue({ bubbles: ["Раҳмат!"] });
  notifyCandidateOwners.mockClear();
  notifyHumanAsk.mockClear();
  sendMessage.mockClear();
  removeKeyboard.mockClear();
});

/** Покупатель, уже принятый агентом, — тот, кого кандидат «прячет» под собой. */
async function acceptedBuyer(digits: string): Promise<{ clientId: string; agentId: string }> {
  const agentId = await createTestAgent(`Агент кандидата ${runId}-${digits}`);
  agentIds.push(agentId);
  const client = await prisma.client.create({
    data: {
      fullName: `Покупатель ${digits}`,
      phone: `+992${digits}`,
      source: "INSTAGRAM",
      kind: "BUYER",
      currency: "TJS",
      assignedAgentId: agentId,
      acceptedAt: new Date(),
    },
  });
  clientIds.push(client.id);
  return { clientId: client.id, agentId };
}

async function botConversation(data: {
  subscriberId: string;
  channel?: "INSTAGRAM" | "WHATSAPP";
  clientId?: string;
  adTopic?: string;
  leadDraft: Record<string, unknown>;
  messages?: unknown[];
}) {
  const fixture = data.channel === "WHATSAPP" ? whatsapp : instagram;
  const scoped = await fixture.ensureConversation(data.subscriberId);
  const conv = await prisma.botConversation.update({
    where: { id: scoped.id },
    data: {
      ...(data.adTopic ? { adTopic: data.adTopic } : {}),
      clientId: data.clientId ?? null,
      leadDraft: data.leadDraft as object,
      messages: (data.messages ?? []) as object[],
    },
  });
  botConvIds.push(conv.id);
  return conv;
}

describe("HELPER-FINAL02: сбой сохранения анкеты не съедает приём кандидата", () => {
  it("анкета не сохранилась: карточка остаётся у агента, руководство не зовут, захват снят; повтор принимает кандидата с первым рассказом", async () => {
    const digits = freshDigits();
    const { clientId, agentId } = await acceptedBuyer(digits);
    const conv = await botConversation({
      subscriberId: `cand-save-fail-${runId}`,
      channel: "INSTAGRAM",
      clientId,
      leadDraft: { stage: "chatting", intent: "job", confident: true },
      messages: [{ role: "user", content: "Мехоҳам агент шавам" }],
    });
    const application = { phone: `+992${digits}`, wholeStory: "ПЕРВЫЙ_РАССКАЗ_КАНДИДАТА", newText: "ТОЛЬКО_НОВЫЙ_ХОД" };
    const capture = () =>
      captureCandidate({ table: "bot", conversationId: conv.id, channel: "INSTAGRAM", knownClientId: clientId, application });

    // Временный сбой базы на сохранении анкеты (recordJobApplication его глотает).
    const spy = vi.spyOn(prisma.jobApplication, "upsert").mockRejectedValueOnce(new Error("временный сбой базы"));
    let first;
    try {
      first = await capture();
    } finally {
      spy.mockRestore();
    }

    expect(first.detached).toBe(false);
    expect(first.notified).toBe(false);
    expect((await prisma.client.findUnique({ where: { id: clientId } }))?.assignedAgentId).toBe(agentId);
    expect(notifyCandidateOwners).not.toHaveBeenCalled();
    expect(await prisma.jobApplication.findUnique({ where: { conversationId: conv.id } })).toBeNull();

    // Следующий ход: захват снят, поэтому это снова «первый приём» — рассказ целиком, карточка снята, руководство позвано.
    const second = await capture();
    expect(second.detached).toBe(true);
    expect(second.notified).toBe(true);
    expect(notifyCandidateOwners).toHaveBeenCalledTimes(1);
    const saved = await prisma.jobApplication.findUnique({ where: { conversationId: conv.id } });
    expect(saved?.rawText).toContain("ПЕРВЫЙ_РАССКАЗ_КАНДИДАТА");
    expect((await prisma.client.findUnique({ where: { id: clientId } }))?.assignedAgentId).toBeNull();
  });
});
describe("Meta: номер кандидата, у которого уже есть карточка у агента", () => {
  it("карточка самого человека (его номер WhatsApp) снимается с агента, анкета знает карточку, руководство зовут один раз", async () => {
    const digits = freshDigits();
    const { clientId } = await acceptedBuyer(digits);
    const history = [{ role: "user" as const, content: "Салом, кор ҳаст? Мехоҳам агент шавам" }];
    // wa_id — это и есть номер человека: карточка по нему точно его.
    const conv = await botConversation({
      subscriberId: `992${digits}`,
      channel: "WHATSAPP",
      leadDraft: { stage: "chatting", intent: "job", confident: true },
      messages: history,
    });
    const draft = { stage: "chatting" as const, intent: "job" as const, confident: true };

    await acceptLead(conv.id, "WHATSAPP", "Фируз Назаров", `+992${digits}`, draft, history, {
      clientText: `Рақамам ${digits}`,
      whatsappPhone: `+992${digits}`,
    });

    const card = await prisma.client.findUnique({ where: { id: clientId } });
    // Правило владельца: кандидат у агента по продажам не остаётся.
    expect(card?.assignedAgentId).toBeNull();
    expect(card?.kind).toBe("OTHER");

    const app = await prisma.jobApplication.findUnique({ where: { conversationId: conv.id } });
    expect(app?.phone).toBe(`+992${digits}`);
    // Анкета знает карточку того же человека.
    expect(app?.clientId).toBe(clientId);
    expect(notifyCandidateOwners).toHaveBeenCalledTimes(1);
    expect(notifyCandidateOwners.mock.calls[0]?.[0]?.why).toBe("обращение переведено из клиентов");

    // Тот же человек присылает номер ещё раз — второго уведомления нет, а в анкету
    // добавились только новые слова, не весь разговор заново.
    await acceptLead(conv.id, "WHATSAPP", "Фируз Назаров", `+992${digits}`, draft, history, {
      clientText: `Ещё раз номер: ${digits}`,
      whatsappPhone: `+992${digits}`,
    });
    expect(notifyCandidateOwners).toHaveBeenCalledTimes(1);
    const again = await prisma.jobApplication.findUnique({ where: { conversationId: conv.id } });
    expect(again?.rawText?.match(/Мехоҳам агент шавам/g)?.length).toBe(1);
    expect(again?.rawText).toContain("Ещё раз номер");
    // Карточку второй раз не трогали: событие о переводе в хронологии одно.
    const events = await prisma.interaction.count({
      where: { clientId, notes: { startsWith: "Обращение переведено в кандидаты" } },
    });
    expect(events).toBe(1);
  });

  it("привязанный диалог (карточка у агента) заговорил о работе — карточка снята с агента", async () => {
    const digits = freshDigits();
    const { clientId } = await acceptedBuyer(digits);
    const subscriberId = `cand-linked-${runId}`;
    await botConversation({
      subscriberId,
      clientId,
      leadDraft: { stage: "done", intent: "buy", confident: true },
      messages: [
        { role: "user", content: "Салом, 2 хонага дар Сино лозим" },
        { role: "assistant", content: "Хуб, агенти мо занг мезанад.", by: { kind: "bot" } },
      ],
    });
    callAiText.mockResolvedValue({
      reply: ["Бале, мо агентҳои фурӯш мегирем. Резюме доред?"],
      intent: "job",
      confident: true,
      jobApplication: { summary: "Хочет работать агентом" },
      ready: false,
      topic: "job",
      openQuestion: "",
      clientAnsweredOpenQuestion: false,
    });

    await processMessengerTurn({ ...instagram.turnInput(subscriberId), text: "Салом, кор ҳаст? Мехоҳам агент шавам" });

    await waitFor(async () => (await prisma.client.findUnique({ where: { id: clientId } }))?.assignedAgentId === null, {
      label: "карточка снята с агента",
    });
    const card = await prisma.client.findUnique({ where: { id: clientId } });
    expect(card?.assignedAgentId).toBeNull();
    expect(card?.kind).toBe("OTHER");
    await waitFor(() => notifyCandidateOwners.mock.calls.length === 1, { label: "руководство позвали" });
    expect(notifyCandidateOwners).toHaveBeenCalledTimes(1);
  });

  it("«позвоните мне» от кандидата не поднимает дежурного, даже если модель не заполнила анкету в этом ходе", async () => {
    const subscriberId = `cand-callback-${runId}`;
    await botConversation({
      subscriberId,
      leadDraft: { stage: "chatting", intent: "job", confident: true },
      messages: [
        { role: "user", content: "Салом, кор ҳаст?" },
        { role: "assistant", content: "Бале. Резюме доред?", by: { kind: "bot" } },
      ],
    });
    callAiText.mockResolvedValue({
      reply: ["Хуб, дар бораи худатон нақл кунед."],
      intent: "job",
      confident: true,
      callbackRequest: "Кандидат просит перезвонить",
      ready: false,
      topic: "job",
      openQuestion: "",
      clientAnsweredOpenQuestion: false,
    });

    await processMessengerTurn({ ...instagram.turnInput(subscriberId), text: "Позвоните мне, пожалуйста" });

    expect(callAiText).toHaveBeenCalled();
    expect(notifyHumanAsk).not.toHaveBeenCalled();
    const conv = await prisma.botConversation.findFirst({ where: { subscriberId }, select: { leadDraft: true } });
    expect((conv?.leadDraft as { callbackTopic?: string } | null)?.callbackTopic).toBeUndefined();
  });
});

describe("Telegram-бот: кандидат — анкета, а не «прочее обращение»", () => {
  it("номер кандидата не заводит карточку и зовёт руководство один раз", async () => {
    const chatId = String(783000000 + Math.floor(Math.random() * 100000));
    tgChatIds.push(chatId);
    const digits = freshDigits();
    let updateId = Math.floor(Math.random() * 1_000_000_000);
    const update = (text: string) => ({
      update_id: updateId++,
      message: { chat: { id: Number(chatId) }, from: { id: Number(chatId), username: `cand_tg_${runId}` }, text },
    });

    callAiText.mockResolvedValue({ reply: ["Бале, мо агентҳо мегирем. Резюме доред?"], intent: "job", confident: true, ready: false });
    await handleTelegramUpdate(update("Салом, кор ҳаст?"));
    await prisma.telegramConversation.update({
      where: { chatId },
      data: { leadDraft: { stage: "chatting", intent: "job", confident: true } },
    });

    await handleTelegramUpdate(update(`Рақамам ${digits}`));

    // Ни карточки «прочего обращения» (её пуш и был вторым уведомлением), ни привязки.
    expect(await prisma.client.count({ where: { phone: `+992${digits}` } })).toBe(0);
    const conv = await prisma.telegramConversation.findUnique({ where: { chatId } });
    expect(conv?.clientId).toBeNull();
    const app = await prisma.jobApplication.findUnique({ where: { conversationId: conv!.id } });
    expect(app?.phone).toBe(`+992${digits}`);
    expect(app?.channel).toBe("TELEGRAM");
    // Имени в Telegram нет — заглушка «Клиент Telegram» в анкету и пуш не попадает.
    expect(app?.name).toBeNull();
    expect(notifyCandidateOwners.mock.calls[0]?.[0]?.name).toBeUndefined();
    expect(notifyCandidateOwners).toHaveBeenCalledTimes(1);

    await handleTelegramUpdate(update(`Ещё раз: ${digits}`));
    expect(notifyCandidateOwners).toHaveBeenCalledTimes(1);
    expect(await prisma.client.count({ where: { phone: `+992${digits}` } })).toBe(0);
  });
});

describe("Telegram Direct Messages: кандидат", () => {
  it("номер кандидата — анкета с каналом TELEGRAM_DIRECT, без карточки и без «агент свяжется»", async () => {
    const topicId = 600000000 + Math.floor(Math.random() * 1_000_000);
    const digits = freshDigits();
    let updateId = Math.floor(Math.random() * 1_000_000_000);
    const dm = (text: string) => ({
      update_id: updateId++,
      message: {
        chat: { id: DM_CHAT_ID, type: "supergroup", is_direct_messages: true },
        from: { id: topicId, username: `cand_dm_${runId}` },
        text,
        direct_messages_topic: { topic_id: topicId, user: { id: topicId, is_bot: false, username: `cand_dm_${runId}` } },
      },
    });

    callAiText.mockResolvedValue({ reply: ["Бале, мо агентҳо мегирем. Резюме доред?"], intent: "job", confident: true, ready: false });
    await handleTelegramUpdate(dm("Салом, кор ҳаст?"));
    await prisma.telegramDirectConversation.update({
      where: { chatId_topicId: { chatId: String(DM_CHAT_ID), topicId: String(topicId) } },
      data: { leadDraft: { stage: "chatting", intent: "job", confident: true } },
    });
    sendMessage.mockClear();

    await handleTelegramUpdate(dm(`Рақамам ${digits}`));

    const conv = await prisma.telegramDirectConversation.findUnique({
      where: { chatId_topicId: { chatId: String(DM_CHAT_ID), topicId: String(topicId) } },
    });
    expect(conv?.clientId).toBeNull();
    expect(await prisma.client.count({ where: { phone: `+992${digits}` } })).toBe(0);
    const app = await prisma.jobApplication.findUnique({ where: { conversationId: conv!.id } });
    expect(app?.phone).toBe(`+992${digits}`);
    // По этому каналу раздел «Вакансии» найдёт разговор в своей таблице.
    expect(app?.channel).toBe("TELEGRAM_DIRECT");
    expect(app?.name).toBeNull();
    expect(notifyCandidateOwners).toHaveBeenCalledTimes(1);
    const replies = sendMessage.mock.calls.map((c) => c[1]).join("\n");
    expect(replies).not.toMatch(/агент/i);
    expect(replies).not.toMatch(/свяж/i);
  });
});

describe("Анкета второго разговора того же человека", () => {
  it("начинается не с нуля: берёт уже рассказанное в другом канале", async () => {
    const profile = await prisma.contactProfile.create({ data: {} });
    profileIds.push(profile.id);
    const first = await botConversation({
      subscriberId: `cand-seed-a-${runId}`,
      leadDraft: { stage: "chatting", intent: "job" },
    });
    const second = await botConversation({
      subscriberId: `cand-seed-b-${runId}`,
      leadDraft: { stage: "chatting", intent: "job" },
    });

    await recordJobApplication({
      conversationId: first.id,
      channel: "INSTAGRAM",
      contactProfileId: profile.id,
      draft: {
        age: 27,
        experience: "продавец телефонов 2 года",
        studyingNow: false,
        studyingUniversity: false,
        employedNow: false,
      },
    });
    await recordJobApplication({
      conversationId: second.id,
      channel: "WHATSAPP",
      contactProfileId: profile.id,
      draft: { summary: "Салом, ман аз Instagram навишта будам" },
    });

    const app = await prisma.jobApplication.findUnique({ where: { conversationId: second.id } });
    expect(app?.age).toBe(27);
    expect(app?.experience).toBe("продавец телефонов 2 года");
    expect(app?.priority).toBe("GREEN");
    expect(app?.eligible).toBe(true);
  });
});

describe("Снятие с агента — только когда это точно кандидат и карточку можно трогать (доразбор 02.10.2026)", () => {
  it("номер родственника: чужая карточка у агента не снимается и к анкете не привязывается", async () => {
    const digits = freshDigits();
    const { clientId } = await acceptedBuyer(digits);
    const history = [{ role: "user" as const, content: "Салом, кор ҳаст? Мехоҳам агент шавам" }];
    const conv = await botConversation({
      subscriberId: `cand-relative-${runId}`,
      leadDraft: { stage: "chatting", intent: "job", confident: true },
      messages: history,
    });
    const draft = { stage: "chatting" as const, intent: "job" as const, confident: true };

    await acceptLead(conv.id, "INSTAGRAM", "Фируз Назаров", `+992${digits}`, draft, history, {
      clientText: `Рақами бародарам ${digits}`,
    });

    const card = await prisma.client.findUnique({ where: { id: clientId } });
    expect(card?.assignedAgentId).not.toBeNull();
    expect(card?.kind).toBe("BUYER");
    const app = await prisma.jobApplication.findUnique({ where: { conversationId: conv.id } });
    expect(app?.phone).toBe(`+992${digits}`);
    expect(app?.clientId).toBeNull();
    // Кандидат при этом не потерян: руководство позвали.
    expect(notifyCandidateOwners).toHaveBeenCalledTimes(1);
    expect(notifyCandidateOwners.mock.calls[0]?.[0]?.why).toBe("оставил номер в переписке");
  });

  it("продавец с объектом в работе: автоматика его карточку с агента не снимает", async () => {
    const digits = freshDigits();
    const { clientId, agentId } = await acceptedBuyer(digits);
    await prisma.client.update({ where: { id: clientId }, data: { kind: "SELLER" } });
    const districtId = (await prisma.district.create({ data: { name: `Кандидат-объект-${runId}-${digits}` } })).id;
    districtIds.push(districtId);
    const property = await prisma.property.create({
      data: {
        title: `Объект продавца ${digits}`,
        type: "APARTMENT",
        areaSqm: 55,
        rooms: 2,
        price: 450_000,
        currency: "TJS",
        districtId,
        address: "Тестовая, 1",
        condition: "GOOD",
        status: "AVAILABLE",
        assignedAgentId: agentId,
        sellerClientId: clientId,
      },
    });
    propertyIds.push(property.id);
    const conv = await botConversation({
      subscriberId: `cand-seller-${runId}`,
      clientId,
      leadDraft: { stage: "done", intent: "job" },
    });

    const result = await captureCandidate({
      table: "bot",
      conversationId: conv.id,
      channel: "INSTAGRAM",
      knownClientId: clientId,
    });

    expect(result.detached).toBe(false);
    const card = await prisma.client.findUnique({ where: { id: clientId } });
    expect(card?.assignedAgentId).toBe(agentId);
    expect(card?.kind).toBe("SELLER");
    expect(notifyCandidateOwners).not.toHaveBeenCalled();
  });

  it("привязанный продавец спросил про вакансии: слова о своём жилье считаются по всему разговору", async () => {
    const digits = freshDigits();
    const { clientId, agentId } = await acceptedBuyer(digits);
    const subscriberId = `cand-linked-seller-${runId}`;
    const conv = await botConversation({
      subscriberId,
      clientId,
      leadDraft: { stage: "done", intent: "sell", confident: true },
      messages: [
        { role: "user", content: "Продаю квартиру в Сино, 3 комнаты" },
        { role: "assistant", content: "Хорошо, агент свяжется.", by: { kind: "bot" } },
      ],
    });
    callAiText.mockResolvedValue({
      reply: ["Бале, мо агентҳои фурӯш мегирем."],
      intent: "job",
      confident: true,
      jobApplication: { summary: "Спрашивает про вакансии для брата" },
      ready: false,
      topic: "job",
      openQuestion: "",
      clientAnsweredOpenQuestion: false,
    });

    await processMessengerTurn({ ...instagram.turnInput(subscriberId), text: "А вакансии у вас есть? Для брата" });

    await waitFor(async () => !!(await prisma.jobApplication.findUnique({ where: { conversationId: conv.id } })), {
      label: "анкета записана",
    });
    await new Promise((r) => setTimeout(r, 500));
    const card = await prisma.client.findUnique({ where: { id: clientId } });
    expect(card?.assignedAgentId).toBe(agentId);
    expect(card?.kind).toBe("BUYER");
  });
});

describe("Одно уведомление на разговор — отметка, которую не стирает чужой ход", () => {
  it("черновик переписали устаревшим (без отметки) — повторный номер руководство всё равно не зовёт", async () => {
    const digits = freshDigits();
    const history = [{ role: "user" as const, content: "Салом, кор ҳаст?" }];
    const conv = await botConversation({
      subscriberId: `cand-stale-${runId}`,
      leadDraft: { stage: "chatting", intent: "job", confident: true },
      messages: history,
    });
    const draft = { stage: "chatting" as const, intent: "job" as const, confident: true };

    await acceptLead(conv.id, "INSTAGRAM", "Фируз Назаров", `+992${digits}`, draft, history, { clientText: digits });
    expect(notifyCandidateOwners).toHaveBeenCalledTimes(1);

    // Параллельный ход квалификатора записал черновик, прочитанный ДО приёма.
    await prisma.botConversation.update({ where: { id: conv.id }, data: { leadDraft: draft } });

    await acceptLead(conv.id, "INSTAGRAM", "Фируз Назаров", `+992${digits}`, draft, history, {
      clientText: `ещё раз ${digits}`,
    });
    expect(notifyCandidateOwners).toHaveBeenCalledTimes(1);
  });
});

describe("Просьба о звонке: реклама вакансии сама по себе кандидатом не делает", () => {
  it("покупатель, нажавший кнопку под рекламой вакансии, просит позвонить — просьба не теряется", async () => {
    const subscriberId = `cand-adbuyer-${runId}`;
    await botConversation({
      subscriberId,
      adTopic: "job",
      leadDraft: { stage: "chatting", intent: "buy", confident: true },
      messages: [
        { role: "user", content: "Салом" },
        { role: "assistant", content: "Салом! Чем можем помочь?", by: { kind: "bot" } },
      ],
    });
    callAiText.mockResolvedValue({
      reply: ["Хорошо, передам агенту."],
      intent: "buy",
      confident: true,
      callbackRequest: "Клиент просит перезвонить",
      ready: false,
      topic: "other",
      openQuestion: "",
      clientAnsweredOpenQuestion: false,
    });

    await processMessengerTurn({ ...instagram.turnInput(subscriberId), text: "Позвоните мне, пожалуйста" });

    expect(callAiText).toHaveBeenCalled();
    expect(notifyHumanAsk).toHaveBeenCalledTimes(1);
  });
});
