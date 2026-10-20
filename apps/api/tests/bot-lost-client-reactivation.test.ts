import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createCustomerMessengerFixture, type CustomerMessengerFixture } from "./helpers/customerMessengerFixture.js";
import { drainBackgroundTasks } from "../src/lib/shutdownState.js";
import bcrypt from "bcrypt";

/**
 * СНЯТИЕ LOST СООБЩЕНИЕМ КЛИЕНТА (18.09.2026, решение владельца: «пусть
 * возвращается — он же сам обратился»).
 *
 * До этой правки только входящий ЗВОНОК снимал LOST (lib/telephony/
 * inboundRouting.ts, аудит 02.09.2026, баг B3). Клиент, у которого уже есть
 * карточка (conversation.clientId), но статус LOST, писавший в чат, уходил
 * прямиком в ветку короткого ответа «агент свяжется» и статус никогда не
 * пересчитывался — карточка оставалась потерянной навсегда, даже когда
 * человек явно обратился сам.
 */

const { callAi } = vi.hoisted(() => ({ callAi: vi.fn() }));
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

let activeAgentId = "";
let frozenAgentId = "";
let pausedAgentId = "";
const clientIds: string[] = [];

async function makeLostClient(lastAgentId: string | null) {
  const c = await prisma.client.create({
    data: {
      fullName: `LOST чат-клиент ${runId}-${clientIds.length}`,
      phone: `+992974${runId}${clientIds.length}`,
      source: "INSTAGRAM",
      kind: "BUYER",
      status: "LOST",
      lostAt: new Date(),
      assignedAgentId: null,
      lastAgentId,
      acceptedAt: new Date(Date.now() - 30 * 24 * 60 * 60 * 1000),
    },
  });
  clientIds.push(c.id);
  return c;
}

async function makeConversation(subscriberId: string, clientId: string) {
  await prisma.botConversation.update({
    where: { id: (await fixture!.ensureConversation(subscriberId)).id },
    data: {
      clientId,
      channel: "INSTAGRAM",
      subscriberId,
      messages: [],
    },
  });
}

beforeAll(async () => {
  fixture = await createCustomerMessengerFixture("INSTAGRAM");
  const passwordHash = await bcrypt.hash("testpass123", 10);
  activeAgentId = (
    await prisma.agent.create({
      data: { fullName: `Агент LOST-чат ${runId}`, phone: `+992975${runId}1`, role: "AGENT", passwordHash, isActive: true },
    })
  ).id;
  frozenAgentId = (
    await prisma.agent.create({
      data: {
        fullName: `Замороженный LOST-чат ${runId}`,
        phone: `+992975${runId}2`,
        role: "AGENT",
        passwordHash,
        isActive: true,
        frozenAt: new Date(),
      },
    })
  ).id;
  pausedAgentId = (
    await prisma.agent.create({
      data: {
        fullName: `На паузе LOST-чат ${runId}`,
        phone: `+992975${runId}3`,
        role: "AGENT",
        passwordHash,
        isActive: true,
        leadsPausedUntil: new Date(Date.now() + 24 * 3600_000),
      },
    })
  ).id;
});

afterAll(async () => {
  await drainBackgroundTasks(2000);
  await prisma.interaction.deleteMany({ where: { clientId: { in: clientIds } } });
  await prisma.auditLog.deleteMany({ where: { entityId: { in: clientIds } } });
  await prisma.client.deleteMany({ where: { id: { in: clientIds } } });
  await fixture?.dispose();
  await prisma.agent.deleteMany({ where: { id: { in: [activeAgentId, frozenAgentId, pausedAgentId] } } });
  await prisma.$disconnect();
});

describe("Сообщение потерянного клиента снимает LOST", () => {
  it("прежний агент ещё активен — карточка возвращается ему", async () => {
    callAi.mockResolvedValue({ reply: ["Хуб, раҳмат!"], ready: false, confident: true, topic: "other", openQuestion: "", clientAnsweredOpenQuestion: false });
    const client = await makeLostClient(activeAgentId);
    const subscriberId = `lost-chat-${runId}-1`;
    await makeConversation(subscriberId, client.id);

    await processMessengerTurn({ channel: "INSTAGRAM", subscriberId, text: "Здравствуйте, я снова ищу квартиру" });

    const reloaded = await prisma.client.findUniqueOrThrow({ where: { id: client.id } });
    expect(reloaded.status).not.toBe("LOST");
    expect(reloaded.lostAt).toBeNull();
    expect(reloaded.assignedAgentId).toBe(activeAgentId);

    const interactions = await prisma.interaction.findMany({
      where: { clientId: client.id, type: "SYSTEM" },
    });
    expect(interactions.some((i) => i.notes?.includes("[lifecycle]"))).toBe(true);
  });

  /**
   * B1 глубокой проверки 02.10.2026: раньше карточка возвращалась агенту
   * НЕпринятой (acceptedAt: null) и без пуша — через 15 минут карусель
   * разносила её или штрафовала агента lead_ignored. Звонок в той же ситуации
   * оставляет её принятой, заявка — ставит таймер возврата Р-5. Теперь сообщение
   * даёт тот же исход: принята, отметка «вернулся», таймер возврата.
   */
  it("возвращается прежнему агенту принятой, с таймером возврата (как звонок и заявка)", async () => {
    callAi.mockResolvedValue({ reply: ["Хуб, раҳмат!"], ready: false, confident: true, topic: "other", openQuestion: "", clientAnsweredOpenQuestion: false });
    const client = await makeLostClient(activeAgentId);
    const subscriberId = `lost-chat-${runId}-4`;
    await makeConversation(subscriberId, client.id);
    const before = Date.now();

    await processMessengerTurn({ channel: "INSTAGRAM", subscriberId, text: "Ещё актуально?" });

    const reloaded = await prisma.client.findUniqueOrThrow({ where: { id: client.id } });
    expect(reloaded.assignedAgentId).toBe(activeAgentId);
    expect(reloaded.acceptedAt).not.toBeNull();
    expect(reloaded.acceptedAt!.getTime()).toBeGreaterThanOrEqual(before - 1000);
    expect(reloaded.returnedAt).not.toBeNull();
    expect(reloaded.returnAcceptDueAt).not.toBeNull();
    expect(reloaded.returnAcceptDueAt!.getTime()).toBeGreaterThan(Date.now());
  });

  it("прежний агент на паузе лидов — свой вернувшийся клиент всё равно к нему", async () => {
    callAi.mockResolvedValue({ reply: ["Хуб, раҳмат!"], ready: false, confident: true, topic: "other", openQuestion: "", clientAnsweredOpenQuestion: false });
    const client = await makeLostClient(pausedAgentId);
    const subscriberId = `lost-chat-${runId}-5`;
    await makeConversation(subscriberId, client.id);

    await processMessengerTurn({ channel: "INSTAGRAM", subscriberId, text: "Здравствуйте, я снова ищу квартиру" });

    const reloaded = await prisma.client.findUniqueOrThrow({ where: { id: client.id } });
    expect(reloaded.status).not.toBe("LOST");
    expect(reloaded.assignedAgentId).toBe(pausedAgentId);
    expect(reloaded.acceptedAt).not.toBeNull();
  });

  it("прежний агент заморожен — карточка уходит в очередь руководителя", async () => {
    callAi.mockResolvedValue({ reply: ["Хуб, раҳмат!"], ready: false, confident: true, topic: "other", openQuestion: "", clientAnsweredOpenQuestion: false });
    const client = await makeLostClient(frozenAgentId);
    const subscriberId = `lost-chat-${runId}-2`;
    await makeConversation(subscriberId, client.id);

    await processMessengerTurn({ channel: "INSTAGRAM", subscriberId, text: "Здравствуйте, актуальна ли квартира?" });

    const reloaded = await prisma.client.findUniqueOrThrow({ where: { id: client.id } });
    expect(reloaded.status).not.toBe("LOST");
    expect(reloaded.assignedAgentId).toBeNull();
    expect(reloaded.escalatedAt).not.toBeNull();
  });

  it("клиент не LOST — реактивация не трогает карточку", async () => {
    callAi.mockResolvedValue({ reply: ["Хуб"], ready: false, confident: true, topic: "other", openQuestion: "", clientAnsweredOpenQuestion: false });
    const client = await prisma.client.create({
      data: {
        fullName: `Активный чат-клиент ${runId}`,
        phone: `+992976${runId}`,
        source: "INSTAGRAM",
        kind: "BUYER",
        status: "HOT",
        assignedAgentId: activeAgentId,
        lastAgentId: activeAgentId,
        acceptedAt: new Date(),
      },
    });
    clientIds.push(client.id);
    const subscriberId = `lost-chat-${runId}-3`;
    await makeConversation(subscriberId, client.id);

    await processMessengerTurn({ channel: "INSTAGRAM", subscriberId, text: "Ещё вопрос по объекту" });

    const reloaded = await prisma.client.findUniqueOrThrow({ where: { id: client.id } });
    expect(reloaded.status).toBe("HOT");
    const lifecycleInteractions = await prisma.interaction.findMany({
      where: { clientId: client.id, notes: { contains: "[lifecycle]" } },
    });
    expect(lifecycleInteractions).toHaveLength(0);
  });
});
