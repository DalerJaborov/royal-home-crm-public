import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createCustomerMessengerFixture, type CustomerMessengerFixture } from "./helpers/customerMessengerFixture.js";
import { drainBackgroundTasks } from "../src/lib/shutdownState.js";

/**
 * КЛИЕНТ ПРОСИТ ЖИВОГО АГЕНТА — ОТДЕЛЬНЫЙ ПУШ ЗАКРЕПЛЁННОМУ АГЕНТУ, А НЕ
 * РУКОВОДСТВУ (владелец 18.09.2026, попутно с отменой hasActiveAssignedAgent).
 *
 * Особенно важно для клиента, которого агент реально забросил (LOST/ARCHIVED/
 * workStatus=INACTIVE), но карточка всё ещё числится за ним — бот продолжает
 * вести разговор сам и знает всю историю, а такую просьбу нужно вынести из
 * общего потока сообщений. Метка на карточке (Client.agentAttentionRequestedAt)
 * — по ней список «Сообщения» сортирует диалог первым и красным.
 */
const { sendPushToAgent, sendPushToAgents } = vi.hoisted(() => ({
  sendPushToAgent: vi.fn(async () => 1),
  sendPushToAgents: vi.fn(async () => 1),
}));
vi.mock("../src/push.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/push.js")>()),
  sendPushToAgent, sendPushToAgents }));

const { callAi } = vi.hoisted(() => ({ callAi: vi.fn(async () => ({ reply: "Хуб, сейчас узнаю.", ready: false, confident: true, topic: "other", openQuestion: "", clientAnsweredOpenQuestion: false })) }));
vi.mock("../src/ai/client.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/ai/client.js")>()),
  callAiText: callAi,
}));

const { prisma } = await import("../src/db.js");
const { processMessengerTurn: actualProcessMessengerTurn } = await import("../src/messengers/conversation.js");
let fixture: CustomerMessengerFixture | undefined;
function processMessengerTurn(input: Parameters<typeof actualProcessMessengerTurn>[0]) {
  return actualProcessMessengerTurn({ ...input, ...fixture!.turnInput(input.subscriberId) });
}

const runId = Date.now().toString(36);
const clientIds: string[] = [];
let savedSettings: { botReplyDelaySec: number; botReplyMaxWaitSec: number } | null = null;

/** Ждать, пока фоновая (`void (async () => {...})()`) escalация долетит до базы. */
const settle = () => new Promise((resolve) => setTimeout(resolve, 150));

beforeAll(async () => { fixture = await createCustomerMessengerFixture("INSTAGRAM"); });

beforeEach(() => {
  sendPushToAgent.mockClear();
  sendPushToAgents.mockClear();
  callAi.mockClear();
});

async function withFastReplies<T>(fn: () => Promise<T>): Promise<T> {
  const settings = await prisma.settings.upsert({
    where: { id: "singleton" },
    update: {},
    create: { id: "singleton" },
    select: { botReplyDelaySec: true, botReplyMaxWaitSec: true },
  });
  savedSettings = settings;
  await prisma.settings.upsert({
    where: { id: "singleton" },
    update: { botReplyDelaySec: 0, botReplyMaxWaitSec: 5 },
    create: { id: "singleton", botReplyDelaySec: 0, botReplyMaxWaitSec: 5 },
  });
  try {
    return await fn();
  } finally {
    if (savedSettings) {
      await prisma.settings.upsert({ where: { id: "singleton" }, update: savedSettings, create: { id: "singleton", ...savedSettings } });
    }
  }
}

async function makeAcceptedClient(assignedAgentId: string | null, phoneSuffix: string) {
  const c = await prisma.client.create({
    data: {
      fullName: `Клиент просьбы ${runId}-${phoneSuffix}`,
      phone: `+9929${phoneSuffix}${runId}`.slice(0, 13),
      source: "PHONE_CALL",
      acceptedAt: new Date(),
      assignedAgentId,
    },
  });
  clientIds.push(c.id);
  return c;
}

afterAll(async () => {
  await drainBackgroundTasks(2000);
  await prisma.client.deleteMany({ where: { id: { in: clientIds } } });
  await fixture?.dispose();
});

describe("Просьба живого агента — метка на карточке и отдельный пуш", () => {
  it("клиент с закреплённым агентом просит живого человека — метка ставится, пуш уходит ИМЕННО ему", async () => {
    const agent = await prisma.agent.create({
      data: { fullName: `Агент просьбы ${runId}`, phone: `+99295${runId}`, role: "AGENT", passwordHash: "x" },
    });
    const client = await makeAcceptedClient(agent.id, "1");
    const subscriberId = `attn-${runId}-1`;
    await prisma.botConversation.update({
      where: { id: (await fixture!.ensureConversation(subscriberId)).id },
      data: { clientId: client.id, leadDraft: { stage: "accepted" } as never },
    });

    await withFastReplies(() =>
      processMessengerTurn({
        channel: "INSTAGRAM",
        subscriberId,
        text: "Соедините меня с агентом, пожалуйста",
      })
    );
    await settle();

    const saved = await prisma.client.findUnique({ where: { id: client.id }, select: { agentAttentionRequestedAt: true } });
    expect(saved?.agentAttentionRequestedAt).toBeInstanceOf(Date);
    expect(sendPushToAgent).toHaveBeenCalledWith(agent.id, expect.objectContaining({ tag: `agent-attention-${client.id}` }));
    expect(sendPushToAgents).not.toHaveBeenCalled();

    await prisma.agent.deleteMany({ where: { id: agent.id } });
  });

  it("метка уже стоит — повторная просьба не шлёт второй пуш", async () => {
    const agent = await prisma.agent.create({
      data: { fullName: `Агент повтора-просьбы ${runId}`, phone: `+99296${runId}`, role: "AGENT", passwordHash: "x" },
    });
    const client = await makeAcceptedClient(agent.id, "2");
    await prisma.client.update({ where: { id: client.id }, data: { agentAttentionRequestedAt: new Date() } });
    const subscriberId = `attn-${runId}-2`;
    await prisma.botConversation.update({
      where: { id: (await fixture!.ensureConversation(subscriberId)).id },
      data: { clientId: client.id, leadDraft: { stage: "accepted" } as never },
    });

    await withFastReplies(() =>
      processMessengerTurn({ channel: "INSTAGRAM", subscriberId, text: "Хочу поговорить с человеком снова" })
    );
    await settle();

    // notifyAgentOfClientMessage шлёт СВОЙ, обычный пуш «клиент написал» на
    // КАЖДОЕ сообщение (kind: "message", тег client-message-...) — это другой,
    // не связанный с эскалацией механизм. Здесь проверяем только отсутствие
    // ВТОРОГО, отдельного пуша с тегом agent-attention-*.
    expect(sendPushToAgent).not.toHaveBeenCalledWith(agent.id, expect.objectContaining({ tag: `agent-attention-${client.id}` }));

    await prisma.agent.deleteMany({ where: { id: agent.id } });
  });

  it("у клиента нет закреплённого агента — метка не ставится, слать некому", async () => {
    const client = await makeAcceptedClient(null, "3");
    const subscriberId = `attn-${runId}-3`;
    await prisma.botConversation.update({
      where: { id: (await fixture!.ensureConversation(subscriberId)).id },
      data: { clientId: client.id, leadDraft: { stage: "accepted" } as never },
    });

    await withFastReplies(() =>
      processMessengerTurn({ channel: "INSTAGRAM", subscriberId, text: "Дайте живого агента" })
    );
    await settle();

    const saved = await prisma.client.findUnique({ where: { id: client.id }, select: { agentAttentionRequestedAt: true } });
    expect(saved?.agentAttentionRequestedAt).toBeNull();
    expect(sendPushToAgent).not.toHaveBeenCalled();
  });
});
