import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * ДОВОДКА ПО РЕВЬЮ #497 (27.11.2026), четыре не-блокера — каждый своим тестом:
 *  1. ответ сотрудника с телефона компании (эхо WhatsApp: реплика роли user с `by: manual`) — доказательство «вёл человек»;
 *  2. карточка ушла сотруднику, который вёл переписку, — пуша руководству «заявка без типа» нет;
 *  3. отметка прохода номеров (phoneSweepAt) сверяется с запасом 15 минут и не ставится, если запись номера упала;
 *  4. номера сотрудников — один запрос на проход; причина назначения своя («staff_led_conversation»).
 */

const pushCalls = vi.hoisted(() => ({ tags: [] as string[] }));
const captureFault = vi.hoisted(() => ({ on: false }));
const staffSpy = vi.hoisted(() => ({ loads: 0, finds: 0 }));

vi.mock("../src/push.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/push.js")>();
  return {
    ...actual,
    sendPushToAgents: vi.fn(async (...args: Parameters<typeof actual.sendPushToAgents>) => {
      const payload = args[1] as { tag?: string };
      if (payload?.tag) pushCalls.tags.push(payload.tag);
      return actual.sendPushToAgents(...args);
    }),
  };
});
vi.mock("../src/lib/clientPhoneCapture.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/lib/clientPhoneCapture.js")>();
  return {
    ...actual,
    captureExplicitClientPhone: vi.fn(async (...args: Parameters<typeof actual.captureExplicitClientPhone>) => {
      if (captureFault.on) throw new Error("запись номера упала (тест)");
      return actual.captureExplicitClientPhone(...args);
    }),
  };
});
vi.mock("../src/lib/staffPhoneGuard.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/lib/staffPhoneGuard.js")>();
  return {
    ...actual,
    loadStaffPhoneChecker: vi.fn(async (...args: Parameters<typeof actual.loadStaffPhoneChecker>) => {
      staffSpy.loads++;
      return actual.loadStaffPhoneChecker(...args);
    }),
    findStaffPhone: vi.fn(async (...args: Parameters<typeof actual.findStaffPhone>) => {
      staffSpy.finds++;
      return actual.findStaffPhone(...args);
    }),
  };
});

const { prisma } = await import("../src/db.js");
const { findPhonesWithoutLead, runPhoneLeadWatchdogTick, sweepCardConversationPhones, sweepRereadFrom, PHONE_SWEEP_REREAD_MS } =
  await import("../src/lib/phoneLeadWatchdog.js");
const { unansweredClientTurn } = await import("../src/lib/unansweredChatTurn.js");
const { leadReasonText } = await import("../src/lib/leadReason.js");
const { AGENT_CLIENT_KIND_SCOPE } = await import("../src/lib/clientSearchWhere.js");

const runId = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
const conversationIds: string[] = [];
const clientIds: string[] = [];
const agentIds: string[] = [];
const tails: string[] = [];
let saved: { workHoursStart: string; workHoursEnd: string; botLeadOnlyMode: boolean } | null = null;

function digits9(): string {
  const d = `9${String(Math.floor(Math.random() * 1e8)).padStart(8, "0")}`;
  tails.push(d);
  return d;
}
const spaced = (d: string) => `+992 ${d.slice(0, 3)} ${d.slice(3, 5)} ${d.slice(5, 7)} ${d.slice(7)}`;
const ago = (min: number) => new Date(Date.now() - min * 60_000).toISOString();
type Msg = Record<string, unknown>;

async function waChat(messages: Msg[]): Promise<string> {
  const d = digits9();
  const conv = await prisma.botConversation.create({ data: { channel: "WHATSAPP", subscriberId: `992${d}`, messages: messages as never,
    leadDraft: { stage: "chatting" } as never, lastMessageAt: new Date() }, select: { id: true } });
  conversationIds.push(conv.id);
  return conv.id;
}
async function cardOf(id: string) {
  const row = await prisma.botConversation.findUnique({ where: { id },
    select: { clientId: true, client: { select: { assignedAgentId: true, assignReason: true } } } });
  if (row?.clientId) clientIds.push(row.clientId);
  return row;
}
async function existingCard(d: string): Promise<string> {
  const card = await prisma.client.create({ data: { fullName: `Карточка ${runId}`, phone: `+992${d}`, source: "INSTAGRAM", kind: "BUYER",
    acceptedAt: new Date(Date.now() - 5 * 3600_000), assignedAt: new Date(Date.now() - 5 * 3600_000) } as never, select: { id: true } });
  clientIds.push(card.id);
  return card.id;
}
const unclear = "Здравствуйте, у меня вопрос по квартире";
/** Наш собственный номер пишет в переписку (messengers/conversation.ts, fromStaff): роль user с by: manual. */
const ownNumberEcho = (min: number): Msg => ({ role: "user", content: "Салом, ҳозир занг мезанам", by: { kind: "manual" }, at: ago(min) });

beforeAll(async () => {
  saved = await prisma.settings.upsert({ where: { id: "singleton" }, update: {}, create: { id: "singleton" },
    select: { workHoursStart: true, workHoursEnd: true, botLeadOnlyMode: true } });
  await prisma.settings.update({ where: { id: "singleton" }, data: { workHoursStart: "00:00", workHoursEnd: "24:00",
    chatUnansweredCardEnabled: true, chatBarePhoneToCardEnabled: true, botLeadOnlyMode: false } });
  const agent = await prisma.agent.create({ data: { fullName: `Агент доводки ${runId}`, phone: `+99293${String(Math.floor(Math.random() * 1e7)).padStart(7, "0")}`,
    role: "AGENT", passwordHash: "x" }, select: { id: true } });
  agentIds.push(agent.id);
  // Руководитель с правом назначать: без него пуш «тип не определён» не уходит никому, и проверка п.2 была бы пустой.
  const director = await prisma.agent.create({ data: { fullName: `Директор доводки ${runId}`, phone: `+99292${String(Math.floor(Math.random() * 1e7)).padStart(7, "0")}`,
    role: "DIRECTOR", passwordHash: "x" }, select: { id: true } });
  agentIds.push(director.id);
});

beforeEach(() => {
  pushCalls.tags.length = 0;
  captureFault.on = false;
  staffSpy.loads = 0;
  staffSpy.finds = 0;
});

afterAll(async () => {
  if (saved) await prisma.settings.update({ where: { id: "singleton" }, data: { ...saved, chatUnansweredCardEnabled: true, chatBarePhoneToCardEnabled: true } });
  const linked = await prisma.botConversation.findMany({ where: { id: { in: conversationIds } }, select: { clientId: true } });
  const byTail = tails.length ? await prisma.$queryRaw<Array<{ id: string }>>`SELECT "id" FROM "Client"
    WHERE right(regexp_replace("phone", '[^0-9]', '', 'g'), 9) = ANY(${tails})` : [];
  const ids = [...new Set([...clientIds, ...linked.map((c) => c.clientId), ...byTail.map((c) => c.id)].filter((x): x is string => !!x))];
  await prisma.botConversation.deleteMany({ where: { id: { in: conversationIds } } });
  if (ids.length) {
    await prisma.clientWorkflowObservation.deleteMany({ where: { clientId: { in: ids } } });
    await prisma.interaction.deleteMany({ where: { clientId: { in: ids } } });
    await prisma.client.deleteMany({ where: { id: { in: ids } } });
  }
  await prisma.interaction.deleteMany({ where: { agentId: { in: agentIds } } });
  await prisma.agent.deleteMany({ where: { id: { in: agentIds } } });
});

describe("п.1 (после ревью): кто считается «сотрудник ответил»", () => {
  it("реплика роли user с by: manual — это наш собственный номер, пишущий как клиент, а не ответ сотрудника", () => {
    // fromStaff ставит только routes/webhooks.ts для отправителя из справочника своих номеров (lib/ownAccountGuard.ts).
    // Эхо ответов с телефона компании в WhatsApp не приходит (smb_message_echoes не подключено) — доказательством это не будет.
    const turn = unansweredClientTurn([{ role: "user", content: unclear, at: ago(60) }, ownNumberEcho(55)] as never, null, new Date());
    expect(turn?.staffReplied).toBe(false);
  });

  it("переписка с собственным номером и неясным текстом — карточки нет", async () => {
    const id = await waChat([{ role: "user", content: unclear, at: ago(60) }, ownNumberEcho(55)]);
    await runPhoneLeadWatchdogTick();
    expect((await cardOf(id))?.clientId).toBeNull();
  });

  it("ответил директор (не агент продаж), направление неясно — карточки нет, пушей нет", async () => {
    const id = await waChat([
      { role: "user", content: unclear, at: ago(90) },
      { role: "assistant", content: "Слушаю вас", by: { kind: "agent", agentId: agentIds[1], agentName: "Директор" }, at: ago(85) },
    ]);
    await runPhoneLeadWatchdogTick();
    expect((await cardOf(id))?.clientId).toBeNull();
    expect(pushCalls.tags.filter((t) => t.startsWith("lead-"))).toEqual([]);
  });

  it("без ответа сотрудника и без доказательства сбоя — по-прежнему не карточка", async () => {
    const id = await waChat([{ role: "user", content: unclear, at: ago(60) }]);
    await runPhoneLeadWatchdogTick();
    expect((await cardOf(id))?.clientId).toBeNull();
  });
});

describe("п.2 и п.4: карточка сотруднику, который вёл переписку", () => {
  it("причина назначения своя, пуша «заявка без типа» нет, NAMED_ASSIGNMENT не пишется", async () => {
    const staffId = agentIds[0];
    const id = await waChat([
      { role: "user", content: unclear, at: ago(90) },
      { role: "assistant", content: "Слушаю вас", by: { kind: "agent", agentId: staffId, agentName: "Агент" }, at: ago(85) },
    ]);
    await runPhoneLeadWatchdogTick();
    const card = await cardOf(id);
    expect(card?.client?.assignedAgentId).toBe(staffId);
    expect(card?.client?.assignReason).toBe("staff_led_conversation");
    expect(pushCalls.tags).not.toContain(`lead-intent-unknown-${card!.clientId}`);
    expect(await prisma.clientWorkflowObservation.count({ where: { clientId: card!.clientId!, kind: "NAMED_ASSIGNMENT" } })).toBe(0);
  });

  it("передача карточки другому агенту снимает «Вы уже вели эту переписку»", async () => {
    const card = await prisma.client.create({ data: { fullName: `Передача ${runId}`, phone: `+992${digits9()}`, source: "WHATSAPP", kind: "BUYER",
      assignedAgentId: agentIds[0], assignReason: "staff_led_conversation", assignedAt: new Date() } as never, select: { id: true } });
    clientIds.push(card.id);
    const other = await prisma.agent.create({ data: { fullName: `Второй агент ${runId}`, phone: `+99291${String(Math.floor(Math.random() * 1e7)).padStart(7, "0")}`,
      role: "AGENT", passwordHash: "x" }, select: { id: true } });
    agentIds.push(other.id);
    const { changeClientAgent } = await import("../src/lib/changeClientAgent.js");
    await prisma.$transaction((tx) => changeClientAgent({ clientId: card.id, toAgentId: other.id, reason: "тест передачи", source: "test", tx, skipInteraction: true }));
    expect((await prisma.client.findUnique({ where: { id: card.id }, select: { assignReason: true } }))?.assignReason).toBeNull();
  });

  it("причина видна агенту словами и карточка не прячется из его списка при неясном типе", () => {
    expect(leadReasonText({ assignReason: "staff_led_conversation" } as never, null)?.text).toBe("Вы уже вели эту переписку");
    expect(AGENT_CLIENT_KIND_SCOPE).toContainEqual({ assignReason: "staff_led_conversation" });
  });
});

describe("п.4: номера сотрудников — один запрос на проход", () => {
  it("много кандидатов WhatsApp — справочник сотрудников грузится один раз, findStaffPhone по строкам не зовётся", async () => {
    for (let i = 0; i < 3; i++) await waChat([{ role: "user", content: `${unclear}, №${i}`, at: ago(60), heldRouting: true }]);
    await findPhonesWithoutLead(new Date());
    expect(staffSpy.finds).toBe(0);
    expect(staffSpy.loads).toBe(1);
  });
});

describe("п.3: отметка прохода номеров в карточку", () => {
  it("повторный разбор берёт реплики за 15 минут до отметки, но не раньше окна", () => {
    const since = new Date("2026-11-27T00:00:00Z");
    const mark = new Date("2026-11-27T10:00:00Z");
    expect(sweepRereadFrom(null, since)).toEqual(since);
    expect(sweepRereadFrom(mark, since).getTime()).toBe(mark.getTime() - PHONE_SWEEP_REREAD_MS);
    expect(sweepRereadFrom(new Date(since.getTime() + 60_000), since)).toEqual(since);
  });

  it("реплика с временем Meta раньше отметки, записанная после прохода, — номер всё равно ложится в карточку", async () => {
    const own = digits9();
    const cardId = await existingCard(digits9());
    const sweptAt = new Date(Date.now() - 2 * 60_000);
    const conv = await prisma.botConversation.create({ data: { channel: "INSTAGRAM", subscriberId: `fu-${runId}-late`, clientId: cardId,
      lastMessageAt: new Date(), phoneSweepAt: sweptAt,
      // Meta отдала время отправки за 5 минут до прохода; в базу реплика легла позже (lastMessageAt новее отметки).
      messages: [{ role: "user", content: `Мой номер ${spaced(own)}`, at: ago(7) }] as never }, select: { id: true } });
    conversationIds.push(conv.id);
    await sweepCardConversationPhones();
    const card = await prisma.client.findUnique({ where: { id: cardId }, select: { extraPhones: true } });
    expect(card?.extraPhones.some((p) => p.replace(/\D/g, "").endsWith(own))).toBe(true);
  });

  it("запись номера упала — отметку не ставим, следующий проход пробует снова", async () => {
    const own = digits9();
    const cardId = await existingCard(digits9());
    const conv = await prisma.botConversation.create({ data: { channel: "INSTAGRAM", subscriberId: `fu-${runId}-fail`, clientId: cardId,
      lastMessageAt: new Date(), messages: [{ role: "user", content: `Мой номер ${spaced(own)}`, at: ago(3) }] as never }, select: { id: true } });
    conversationIds.push(conv.id);
    captureFault.on = true;
    await sweepCardConversationPhones();
    expect((await prisma.botConversation.findUnique({ where: { id: conv.id }, select: { phoneSweepAt: true } }))?.phoneSweepAt).toBeNull();
    captureFault.on = false;
    await sweepCardConversationPhones();
    expect((await prisma.botConversation.findUnique({ where: { id: conv.id }, select: { phoneSweepAt: true } }))?.phoneSweepAt).toBeTruthy();
    const card = await prisma.client.findUnique({ where: { id: cardId }, select: { extraPhones: true } });
    expect(card?.extraPhones.some((p) => p.replace(/\D/g, "").endsWith(own))).toBe(true);
  });
});
