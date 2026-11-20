import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createCustomerMessengerFixture, type CustomerMessengerFixture } from "./helpers/customerMessengerFixture.js";
import { waitFor } from "./helpers/waitFor.js";

// Пуши и журнал подменены (importOriginal: остальной модуль живой, audit:mocks). Модель понимания оператора и модель
// ответа старого пути — тоже: понимание идёт запасными правилами (живых вызовов нет).
const mocks = vi.hoisted(() => ({ push: vi.fn(async () => 1), pushMany: vi.fn(async () => 1), log: vi.fn(async () => undefined), callAi: vi.fn() }));
vi.mock("../src/push.js", async (importOriginal) => ({ ...(await importOriginal<typeof import("../src/push.js")>()),
  sendPushToAgent: mocks.push, sendPushToAgents: mocks.pushMany }));
vi.mock("../src/lib/systemError.js", async (importOriginal) => ({ ...(await importOriginal<typeof import("../src/lib/systemError.js")>()),
  logSystemError: mocks.log }));
vi.mock("../src/ai/client.js", async (importOriginal) => ({ ...(await importOriginal<typeof import("../src/ai/client.js")>()),
  callAiText: mocks.callAi }));

const { prisma } = await import("../src/db.js");
const { alertClientWaiting } = await import("../src/lib/clientWaitingAlert.js");
const { planCustomerLeadOnlyTurn } = await import("../src/lib/customerLeadOnlyCore.js");
const { signalStaffFollowUp } = await import("../src/lib/customerDmAgentTurn.js");
const { processMessengerTurn } = await import("../src/messengers/conversation.js");
const { LEAD_ONLY_DEFAULTS } = await import("../src/ai/leadOnlyMode.js");
const { drainBackgroundTasks } = await import("../src/lib/shutdownState.js");

/**
 * ЖАЛОБА И ГРУБОСТЬ ДО ЗАЯВКИ — ЧЕЛОВЕК ПРАВДА УЗНАЁТ (расхождение №2 проверки #311, живой диалог Instagram 19.11.2026).
 *
 * Клиент: «По этим номерам никто не отвечает» → бот: «Ваше сообщение увидит руководитель.» и молчит дальше (SPEC, случай 26).
 * Сигнал оператора шёл дверью «клиент ждёт» поводом follow_up, а её правило режима «только заявки» (до карточки людей не
 * беспокоим, решение владельца 13.11) этот повод глушило: обещание «увидит руководитель» оставалось неправдой. Прежний тест
 * staffRequired (bot-answers-itself-postgres) этого не видел: он выключает режим «только заявки», а на проде режим включён.
 * Здесь режим ВКЛЮЧЁН, как на проде; оба пути бота (ядро и старый путь) и сама дверь.
 */
const runId = `sig-${randomUUID().slice(0, 8)}`;
const convIds: string[] = [];
const clientIds: string[] = [];
let agentId = "";
let whatsapp: CustomerMessengerFixture;
let saved: Record<string, unknown> | null = null;

async function chat(opts: { card?: "agent" } = {}) {
  let clientId: string | null = null;
  if (opts.card) {
    const client = await prisma.client.create({ data: { fullName: `Клиент ${runId}-${convIds.length}`, source: "INSTAGRAM",
      phone: `+99294${String(Date.now() + convIds.length).slice(-7)}`, assignedAgentId: agentId } });
    clientId = client.id; clientIds.push(client.id);
  }
  const conv = await prisma.botConversation.create({ data: { channel: "INSTAGRAM", subscriberId: `${runId}-${convIds.length}`,
    lastMessageAt: new Date(), messages: [{ role: "user", content: "По этим номерам никто не отвечает", at: new Date(Date.now() - 30_000).toISOString() }],
    ...(clientId ? { clientId } : {}) } });
  convIds.push(conv.id);
  return conv.id;
}
const leadershipAlerts = (convId: string) => prisma.pendingDirectorAlert.findMany({ where: { tag: `client-waiting-${convId}` },
  select: { title: true, body: true, recipientRoles: true } });

beforeAll(async () => {
  saved = await prisma.settings.findUnique({ where: { id: "singleton" }, select: { botAnswersItself: true, workHoursStart: true, workHoursEnd: true,
    botLeadOnlyMode: true, botReplyDelaySec: true, botReplyMaxWaitSec: true, botUseWhatsappNumber: true } });
  // Как на проде 19.11: режим «только заявки» включён.
  await prisma.settings.update({ where: { id: "singleton" }, data: { workHoursStart: "00:00", workHoursEnd: "24:00", botLeadOnlyMode: true,
    botAnswersItself: false, botReplyDelaySec: 1, botReplyMaxWaitSec: 3, botUseWhatsappNumber: true } });
  agentId = (await prisma.agent.create({ data: { fullName: `Агент ${runId}`, phone: `+99295${String(Date.now()).slice(-7)}`, role: "AGENT", passwordHash: "x" } })).id;
  whatsapp = await createCustomerMessengerFixture("WHATSAPP");
});
beforeEach(() => {
  vi.clearAllMocks();
  // Понимание оператора — запасные правила (модель «молчит»); модель ответа старого пути звать не должны.
  mocks.callAi.mockImplementation(async () => null);
});
afterAll(async () => {
  await drainBackgroundTasks(2000);
  if (saved) await prisma.settings.update({ where: { id: "singleton" }, data: saved });
  const legacy = await prisma.botConversation.findMany({ where: { endpointScopeId: whatsapp.transport.endpointScopeId }, select: { id: true, clientId: true } });
  await prisma.pendingDirectorAlert.deleteMany({ where: { tag: { in: [...convIds, ...legacy.map(c => c.id)].map((id) => `client-waiting-${id}`) } } });
  await prisma.botConversation.deleteMany({ where: { id: { in: convIds } } });
  await whatsapp.dispose();
  await prisma.client.deleteMany({ where: { id: { in: [...clientIds, ...legacy.flatMap(c => c.clientId ? [c.clientId] : [])] } } });
  await prisma.agent.deleteMany({ where: { id: agentId } });
});

describe("дверь «клиент ждёт»: решение оператора звать человека не глушит тишина режима до заявки", () => {
  it("жалоба без карточки — руководству, с правдивым текстом; обычный follow_up до заявки — по-прежнему тишина", async () => {
    const quiet = await chat();
    expect(await alertClientWaiting({ conversationId: quiet, trigger: "follow_up", staffRequired: true })).toBe("excluded");
    const complaint = await chat();
    expect(await alertClientWaiting({ conversationId: complaint, trigger: "follow_up", staffRequired: true, staffReason: "complaint" })).toBe("director");
    const [alert] = await leadershipAlerts(complaint);
    expect(alert).toMatchObject({ title: "💬 Жалоба клиента", recipientRoles: ["DIRECTOR", "ADMIN"] });
    expect(alert!.body).toContain("клиент жалуется");
    expect(alert!.body).toContain("Ваше сообщение увидит руководитель");
  });

  it("жалоба по клиенту с агентом — руководству, а не агенту (клиенту обещан руководитель)", async () => {
    const id = await chat({ card: "agent" });
    expect(await alertClientWaiting({ conversationId: id, trigger: "follow_up", staffReason: "complaint" })).toBe("director");
    expect(mocks.push).not.toHaveBeenCalled();
  });

  it("грубость: без карточки — руководству; с агентом — агенту, как раньше", async () => {
    const noCard = await chat();
    expect(await alertClientWaiting({ conversationId: noCard, trigger: "follow_up", staffReason: "rude" })).toBe("director");
    expect((await leadershipAlerts(noCard))[0]!.body).toContain("написал грубо");
    const withAgent = await chat({ card: "agent" });
    expect(await alertClientWaiting({ conversationId: withAgent, trigger: "follow_up", staffReason: "rude" })).toBe("agent");
  });

  it("прежний неотвеченный сигнал «агент уточнит» жалобу не глушит; «Бот отвечает сам» — тоже", async () => {
    const id = await chat({ card: "agent" });
    await prisma.botConversation.update({ where: { id }, data: { silenceAlertFor: new Date(Date.now() - 3_600_000) } });
    await prisma.settings.update({ where: { id: "singleton" }, data: { botAnswersItself: true } });
    try {
      expect(await alertClientWaiting({ conversationId: id, trigger: "follow_up", staffReason: "complaint", since: new Date() })).toBe("director");
    } finally {
      await prisma.settings.update({ where: { id: "singleton" }, data: { botAnswersItself: false } });
    }
  });
});

describe("оба пути бота доводят жалобу до руководителя", () => {
  it("ядро: оператор отвечает «Ваше сообщение увидит руководитель.», сигнал с причиной уходит руководству", async () => {
    const id = await chat();
    const plan = await planCustomerLeadOnlyTurn({ config: { ...LEAD_ONLY_DEFAULTS, enabled: true, workHoursStart: "00:00", workHoursEnd: "24:00" },
      channel: "INSTAGRAM", peer: `${runId}-peer`, conversationId: id, eventKey: "a".repeat(64), inputText: "По этим номерам никто не отвечает",
      focusPropertyId: null, turns: [], model: async () => null });
    expect(plan!.text).toBe("Ваше сообщение увидит руководитель.");
    expect(plan!.signal).toEqual({ kind: "follow_up", reason: "complaint" });
    expect(await signalStaffFollowUp(id, Date.now(), false, false, true, plan!.signal!.reason)).toBe("director");
    expect(await leadershipAlerts(id)).toHaveLength(1);
  });

  it("старый путь, WhatsApp до заявки: тот же ответ, руководство получает сигнал", async () => {
    const peer = `9929${String(Math.floor(Math.random() * 1e8)).padStart(8, "0")}`;
    const result = await processMessengerTurn({ ...whatsapp.turnInput(peer), text: "По этим номерам никто не отвечает" });
    expect(result.reply).toBe("Ваше сообщение увидит руководитель.");
    const conv = await prisma.botConversation.findFirstOrThrow({ where: { subscriberId: peer }, select: { id: true, clientId: true } });
    expect(conv.clientId).toBeNull();
    const alerts = await waitFor(async () => { const rows = await leadershipAlerts(conv.id); return rows.length ? rows : null; },
      { label: "сигнал руководству по жалобе", timeoutMs: 5000 });
    expect(alerts[0]!.title).toBe("💬 Жалоба клиента");
  });
});
