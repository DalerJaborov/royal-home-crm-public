import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { createCustomerMessengerFixture, type CustomerMessengerFixture } from "./helpers/customerMessengerFixture.js";

/**
 * ОТВЕТ СОТРУДНИКА ИЗ CRM И ПАУЗА БОТА: РУБИЛЬНИК botPauseOnStaffReplyEnabled (владелец 27.11.2026: «Убрать у всех»).
 *
 * ВЫКЛ (по умолчанию): ответ сотрудника бота не останавливает — ни умолчанием сервера, ни явным сроком (старый клиент
 * ещё мог его прислать); уже стоящая пауза (кнопка «Пауза») не меняется. ВКЛ: прежнее поведение — явный срок
 * ставится как есть, без срока действует умолчание для отправителя. Бот и служебные отправки от рубильника не зависят.
 *
 * Рубильник подменён в модуле, а не записан в Settings: тесты идут в несколько процессов на одной базе.
 */

const { sendMessage, isMetaChannelEnabled, switchState } = vi.hoisted(() => ({
  sendMessage: vi.fn(async (_c: string, _to: string, _text: string) => "wamid.sent-1"),
  isMetaChannelEnabled: vi.fn(async () => true),
  switchState: { on: false },
}));

vi.mock("../src/messengers/meta.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/messengers/meta.js")>()),
  sendMessage,
  isMetaChannelEnabled,
}));
vi.mock("../src/lib/automationSwitches.js", async (importOriginal) => {
  const original = await importOriginal<typeof import("../src/lib/automationSwitches.js")>();
  return {
    ...original,
    automationSwitchOn: async (key: Parameters<typeof original.automationSwitchOn>[0], db?: Parameters<typeof original.automationSwitchOn>[1]) =>
      key === "botPauseOnStaffReplyEnabled" ? switchState.on : original.automationSwitchOn(key, db),
  };
});

const { prisma } = await import("../src/db.js");
const { deliverToConversation } = await import("../src/lib/conversationDelivery.js");
const { AUTOMATION_SWITCH_DEFAULT_OFF } = await import("@royal-home/shared");

let fixture: CustomerMessengerFixture;
beforeAll(async () => { fixture = await createCustomerMessengerFixture("INSTAGRAM"); });

const runId = Date.now().toString(36);
const conversationIds: string[] = [];
const agentIds: string[] = [];
const HOUR = 60 * 60 * 1000;

async function makeAgent() {
  const a = await prisma.agent.create({
    data: { fullName: `Агент пауза ${runId}`, phone: `+99293${Date.now().toString().slice(-7)}`, role: "AGENT", passwordHash: "x" },
  });
  agentIds.push(a.id);
  return a;
}

async function makeConversation(pausedUntil: Date | null = null) {
  const c = await prisma.botConversation.create({
    data: {
      channel: "INSTAGRAM", accountId: fixture.id, endpointScopeId: fixture.transport.endpointScopeId,
      subscriberId: `staff-pause-${runId}-${conversationIds.length}`, messages: [], pausedUntil,
      botPausedAt: pausedUntil ? new Date() : null,
    },
  });
  conversationIds.push(c.id);
  return c;
}

const targetOf = (c: Awaited<ReturnType<typeof makeConversation>>) =>
  ({ kind: "bot", id: c.id, channel: c.channel, subscriberId: c.subscriberId, accountId: fixture.id, transport: fixture.transport }) as const;

async function savedPause(id: string) {
  return (await prisma.botConversation.findUnique({ where: { id }, select: { pausedUntil: true } }))!.pausedUntil;
}

afterEach(() => { vi.clearAllMocks(); switchState.on = false; });
afterAll(async () => {
  await fixture?.dispose();
  if (agentIds.length > 0) await prisma.agent.deleteMany({ where: { id: { in: agentIds } } });
});

describe("рубильник: по умолчанию выключен", () => {
  it("в списке выключенных по умолчанию и в базе", async () => {
    expect(AUTOMATION_SWITCH_DEFAULT_OFF.has("botPauseOnStaffReplyEnabled")).toBe(true);
    const row = await prisma.settings.upsert({ where: { id: "singleton" }, update: {}, create: { id: "singleton" }, select: { botPauseOnStaffReplyEnabled: true } });
    expect(row.botPauseOnStaffReplyEnabled).toBe(false);
  });
});

describe("рубильник ВЫКЛ: ответ сотрудника бота не останавливает", () => {
  it("ответ без срока: пауза не ставится, сообщение уходит", async () => {
    const agent = await makeAgent();
    const c = await makeConversation();
    const result = await deliverToConversation(targetOf(c), "Здравствуйте", undefined, { sender: { kind: "agent", agentId: agent.id, agentName: agent.fullName } });
    expect(result.ok).toBe(true);
    expect(sendMessage).toHaveBeenCalledTimes(1);
    const paused = await savedPause(c.id);
    expect(paused === null || paused.getTime() <= Date.now()).toBe(true);
    if (result.ok) expect(result.pausedUntil.getTime()).toBeLessThanOrEqual(Date.now() + 1000);
  });

  it("явный срок от старого клиента игнорируется", async () => {
    const agent = await makeAgent();
    const c = await makeConversation();
    const result = await deliverToConversation(targetOf(c), "Добрый день", new Date(Date.now() + 2 * HOUR), { sender: { kind: "agent", agentId: agent.id, agentName: agent.fullName } });
    expect(result.ok).toBe(true);
    const paused = await savedPause(c.id);
    expect(paused === null || paused.getTime() <= Date.now()).toBe(true);
  });

  it("пауза, поставленная кнопкой «Пауза», ответом не меняется", async () => {
    const agent = await makeAgent();
    const manual = new Date(Date.now() + 5 * HOUR);
    const c = await makeConversation(manual);
    const result = await deliverToConversation(targetOf(c), "Ответ", undefined, { sender: { kind: "agent", agentId: agent.id, agentName: agent.fullName } });
    expect(result.ok).toBe(true);
    expect((await savedPause(c.id))!.getTime()).toBe(manual.getTime());
    if (result.ok) expect(result.pausedUntil.getTime()).toBe(manual.getTime());
  });
});

describe("рубильник ВКЛ: прежнее поведение", () => {
  it("явный срок ставится как есть", async () => {
    switchState.on = true;
    const agent = await makeAgent();
    const c = await makeConversation();
    const until = new Date(Date.now() + 2 * HOUR);
    const result = await deliverToConversation(targetOf(c), "Добрый день", until, { sender: { kind: "agent", agentId: agent.id, agentName: agent.fullName } });
    expect(result.ok).toBe(true);
    expect((await savedPause(c.id))!.getTime()).toBe(until.getTime());
  });

  it("без срока: ставится умолчание сервера для отправителя (не закреплённый за клиентом — 10 минут)", async () => {
    switchState.on = true;
    const agent = await makeAgent();
    const c = await makeConversation();
    const result = await deliverToConversation(targetOf(c), "Здравствуйте", undefined, { sender: { kind: "agent", agentId: agent.id, agentName: agent.fullName } });
    expect(result.ok).toBe(true);
    const left = (await savedPause(c.id))!.getTime() - Date.now();
    expect(left).toBeGreaterThan(9 * 60_000);
    expect(left).toBeLessThanOrEqual(10 * 60_000 + 5000);
  });
});
