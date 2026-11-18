import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ push: vi.fn(async () => 1), pushMany: vi.fn(async () => 1), log: vi.fn(async () => undefined) }));
vi.mock("../src/push.js", async (importOriginal) => ({ ...(await importOriginal<typeof import("../src/push.js")>()),
  sendPushToAgent: mocks.push, sendPushToAgents: mocks.pushMany }));
vi.mock("../src/lib/systemError.js", async (importOriginal) => ({ ...(await importOriginal<typeof import("../src/lib/systemError.js")>()),
  logSystemError: mocks.log }));

const { prisma } = await import("../src/db.js");
const { alertClientWaiting } = await import("../src/lib/clientWaitingAlert.js");
const { notifyEscalatedCustomerTurn } = await import("../src/lib/customerHeldMessage.js");
const { runCommentNeedsHumanSweep } = await import("../src/lib/commentWaitingAlert.js");
const { admitOutbound, noteOutboundUndelivered, MAX_MESSAGES_WITHOUT_INBOUND } = await import("../src/lib/outboundShield.js");

/**
 * «БОТ ОТВЕЧАЕТ САМ» НА БАЗЕ СТЕНДА (18.11.2026): дверь «клиент ждёт», «бот передал разговор», сводка комментариев —
 * в обоих положениях настройки; щит исходящих — в счёт «подряд» только доставленные. Пуши и журнал подменены.
 */
const runId = `self-${randomUUID().slice(0, 8)}`;
const convIds: string[] = [];
const clientIds: string[] = [];
const commentIds: string[] = [];
let agentId = "";
let saved: { botAnswersItself: boolean; workHoursStart: string | null; workHoursEnd: string | null; botLeadOnlyMode: boolean } | null = null;

async function chat(opts: { card?: "agent" | "no_agent" } = {}) {
  let clientId: string | null = null;
  if (opts.card) {
    const client = await prisma.client.create({ data: { fullName: `Клиент ${runId}-${convIds.length}`, source: "INSTAGRAM",
      phone: `+99294${String(Date.now() + convIds.length).slice(-7)}`, assignedAgentId: opts.card === "agent" ? agentId : null } });
    clientId = client.id; clientIds.push(client.id);
  }
  const conv = await prisma.botConversation.create({ data: { channel: "INSTAGRAM", subscriberId: `${runId}-${convIds.length}`,
    lastMessageAt: new Date(), messages: [{ role: "user", content: "Документы в порядке?", at: new Date(Date.now() - 60_000).toISOString() }],
    ...(clientId ? { clientId } : {}) } });
  convIds.push(conv.id);
  return conv.id;
}
const directorAlerts = (convId: string) => prisma.pendingDirectorAlert.count({ where: { tag: `client-waiting-${convId}` } });
const setOn = (on: boolean) => prisma.settings.update({ where: { id: "singleton" }, data: { botAnswersItself: on } });

beforeAll(async () => {
  saved = await prisma.settings.findUnique({ where: { id: "singleton" }, select: { botAnswersItself: true, workHoursStart: true, workHoursEnd: true, botLeadOnlyMode: true } });
  // Режим «только заявки» глушит часть сигналов сам — здесь проверяется только новая настройка.
  await prisma.settings.update({ where: { id: "singleton" }, data: { workHoursStart: "00:00", workHoursEnd: "24:00", botLeadOnlyMode: false } });
  agentId = (await prisma.agent.create({ data: { fullName: `Агент ${runId}`, phone: `+99295${String(Date.now()).slice(-7)}`, role: "AGENT", passwordHash: "x" } })).id;
});
beforeEach(() => { vi.clearAllMocks(); });
afterAll(async () => {
  if (saved) await prisma.settings.update({ where: { id: "singleton" }, data: saved });
  await prisma.pendingDirectorAlert.deleteMany({ where: { tag: { in: convIds.map((id) => `client-waiting-${id}`) } } });
  await prisma.botConversation.deleteMany({ where: { id: { in: convIds } } });
  await prisma.client.deleteMany({ where: { id: { in: clientIds } } });
  await prisma.agent.deleteMany({ where: { id: agentId } });
  await prisma.instagramComment.deleteMany({ where: { commentId: { in: commentIds } } });
  await prisma.processedMessage.deleteMany({ where: { messageId: { in: commentIds } } });
  await prisma.outboundShieldState.deleteMany({ where: { subscriberId: { startsWith: runId } } });
});

describe("«клиент ждёт» (clientWaitingAlert) — таблица сигналов", () => {
  it("ВЫКЛ: «агент уточнит» по чату без карточки — руководству, как раньше", async () => {
    await setOn(false);
    const id = await chat();
    expect(await alertClientWaiting({ conversationId: id, trigger: "follow_up" })).toBe("director");
    expect(await directorAlerts(id)).toBe(1);
  });

  it("ВКЛ: «агент уточнит» / «передал» по чату без карточки — никого, без журнала", async () => {
    await setOn(true);
    for (const trigger of ["follow_up", "handover"] as const) {
      const id = await chat();
      expect(await alertClientWaiting({ conversationId: id, trigger })).toBe("self");
      expect(await directorAlerts(id)).toBe(0);
    }
    expect(mocks.log).not.toHaveBeenCalled();
  });

  it("ВКЛ: клиент совсем без ответа (escalate/молчание 30 мин) — это сбой: сигнал как раньше, один на эпизод разговора (ревью 1b, №1)", async () => {
    await setOn(true);
    const first = await chat(), second = await chat();
    expect(await alertClientWaiting({ conversationId: first, trigger: "silence" })).toBe("director");
    // Второй неотвеченный клиент не теряется за первым (ключ — разговор, а не общий).
    expect(await alertClientWaiting({ conversationId: second, trigger: "silence" })).toBe("director");
    expect(await directorAlerts(first)).toBe(1);
    expect(await directorAlerts(second)).toBe(1);
    // Тот же эпизод следующим тиком — уже сказали.
    expect(await alertClientWaiting({ conversationId: first, trigger: "escalate" })).toBe("already");
  });

  it("ВКЛ: остаётся — техсбой, аварийный рубильник, агент своего клиента, карточка без агента, вакансия", async () => {
    await setOn(true);
    const failed = await chat();
    expect(await alertClientWaiting({ conversationId: failed, trigger: "failed", why: "ход сломался" })).toBe("director");
    const channelOff = await chat();
    expect(await alertClientWaiting({ conversationId: channelOff, trigger: "handover", alwaysTell: true })).toBe("director");
    const own = await chat({ card: "agent" });
    expect(await alertClientWaiting({ conversationId: own, trigger: "follow_up" })).toBe("agent");
    expect(mocks.push).toHaveBeenCalledWith(agentId, expect.objectContaining({ tag: `client-waiting-${own}` }));
    const unassigned = await chat({ card: "no_agent" });
    expect(await alertClientWaiting({ conversationId: unassigned, trigger: "follow_up" })).toBe("director");
    const job = await chat();
    expect(await alertClientWaiting({ conversationId: job, trigger: "escalate", jobTopic: true })).toBe("director");
  });
});

describe("«бот передал разговор человеку» (ядро Meta, notifyEscalatedCustomerTurn)", () => {
  it("ВКЛ, без карточки: клиенту ушла строка — пуша нет; клиент без ответа — сбой, пуш как раньше", async () => {
    await setOn(true);
    const answered = await chat();
    expect(await notifyEscalatedCustomerTurn({ conversationId: answered, channel: "INSTAGRAM", text: "?", answered: true })).toBe("skipped");
    expect(mocks.pushMany).not.toHaveBeenCalled();
    const silent = await chat();
    expect(await notifyEscalatedCustomerTurn({ conversationId: silent, channel: "INSTAGRAM", text: "?" })).toBe("sent");
    expect(mocks.pushMany).toHaveBeenCalledTimes(1);
  });

  it("ВКЛ, карточка с агентом — агенту, как раньше", async () => {
    await setOn(true);
    const own = await chat({ card: "agent" });
    expect(await notifyEscalatedCustomerTurn({ conversationId: own, channel: "INSTAGRAM", text: "?", answered: true })).toBe("sent");
  });
});

describe("сводка «комментарий ждёт человека»", () => {
  it("ВКЛ: «бот передал вопрос человеку» не идёт; техсбой (ИИ недоступен) — идёт", async () => {
    await setOn(true);
    const old = new Date(Date.now() - 10 * 60_000);
    const human = `${runId}-c-human`, tech = `${runId}-c-tech`; commentIds.push(human, tech);
    for (const [commentId, status, note] of [[human, "ESCALATED", "документы"], [tech, "FAILED", "ai_down"]] as const) {
      await prisma.instagramComment.create({ data: { channel: "INSTAGRAM", commentId, mediaId: `${runId}-m`, authorId: `${runId}-a`,
        text: "Вопрос", status, note, replyDueAt: old, createdAt: old } });
    }
    // @updatedAt ставит Prisma сама: сторож берёт финалы старше трёх минут — сдвигаем прямым запросом.
    await prisma.$executeRaw`UPDATE "InstagramComment" SET "updatedAt"=${old} WHERE "commentId" IN (${human}, ${tech})`;
    const result = await runCommentNeedsHumanSweep();
    const bodies = mocks.pushMany.mock.calls.map(([, payload]) => JSON.stringify(payload));
    expect(bodies.some((b) => b.includes("ИИ был недоступен"))).toBe(true);
    expect(bodies.some((b) => b.includes("бот передал вопрос человеку"))).toBe(false);
    expect(result.alerted).toBeGreaterThanOrEqual(1);
  });
});

describe("щит исходящих: в счёт «бот написал N подряд» — только доставленные (Арван 17.11, Meta 368)", () => {
  it("три отказа провайдера подряд не копят «монолог»: счёт возвращается, пятое сообщение не режется", async () => {
    const peer = `${runId}-shield-1`;
    for (let i = 0; i < MAX_MESSAGES_WITHOUT_INBOUND + 2; i++) {
      const verdict = await admitOutbound({ channel: "TELEGRAM", subscriberId: peer, text: `Попытка ${i} ${randomUUID()}` });
      expect(verdict.allowed, `попытка ${i}`).toBe(true);
      await noteOutboundUndelivered(verdict); // провайдер отказал — клиент этого не видел
    }
    const state = await prisma.outboundShieldState.findFirst({ where: { channel: "TELEGRAM", subscriberId: peer } });
    expect(state?.botSentSinceInbound).toBe(0);
    expect(state?.pausedUntil ?? null).toBeNull();
  });

  it("доставленные считаются как раньше: на пятом подряд щит останавливает инициативу", async () => {
    const peer = `${runId}-shield-2`;
    for (let i = 0; i < MAX_MESSAGES_WITHOUT_INBOUND; i++) {
      expect((await admitOutbound({ channel: "TELEGRAM", subscriberId: peer, text: `Сообщение ${i} ${randomUUID()}` })).allowed).toBe(true);
    }
    const state = await prisma.outboundShieldState.findFirst({ where: { channel: "TELEGRAM", subscriberId: peer } });
    expect(state?.botSentSinceInbound).toBe(MAX_MESSAGES_WITHOUT_INBOUND);
    expect((await admitOutbound({ channel: "TELEGRAM", subscriberId: peer, text: `Пятое ${randomUUID()}` })).allowed).toBe(false);
  });

  it("недоставленный текст не считается «уже сказанным»: его можно отправить снова", async () => {
    const peer = `${runId}-shield-3`;
    const text = "Ташаккур, рақамро қабул кардем. Агенти мо ба зудӣ бо шумо тамос мегирад.";
    await noteOutboundUndelivered(await admitOutbound({ channel: "TELEGRAM", subscriberId: peer, text }));
    expect((await admitOutbound({ channel: "TELEGRAM", subscriberId: peer, text })).allowed).toBe(true);
  });
});
