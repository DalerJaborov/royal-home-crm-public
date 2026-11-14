import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const { sendDevicePushToAgents } = vi.hoisted(() => ({ sendDevicePushToAgents: vi.fn(async (_ids: string[], _payload: unknown) => 1) }));
vi.mock("../src/push.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/push.js")>()),
  sendDevicePushToAgents,
}));

import { prisma } from "../src/db.js";
import { isClientWaitingJob, notifyStuckWorkGivenUp } from "../src/lib/stuckWork.js";

/**
 * Задание, где ждёт клиент, сдалось: хозяину карточки идёт звонок телефона
 * (14.11.2026, охота на тихие поломки, №11). Раньше только строка в ленте, и
 * клиент, чей ответ так и не ушёл, ждал до утренней сводки.
 */

const runId = `cw-${Date.now()}`;
let ownerId = "";
let clientId = "";
const convIds: string[] = [];
const jobIds: string[] = [];

beforeAll(async () => {
  ownerId = (await prisma.agent.create({ data: { fullName: `Агент ${runId}`, phone: `+992930${runId.slice(-6)}`, role: "AGENT", passwordHash: "x", isActive: true } })).id;
  clientId = (await prisma.client.create({ data: { fullName: `Клиент ${runId}`, phone: `+992931${runId.slice(-6)}`, source: "PHONE_CALL", kind: "BUYER", assignedAgentId: ownerId } })).id;
});

beforeEach(() => sendDevicePushToAgents.mockClear());

afterAll(async () => {
  await prisma.notification.deleteMany({ where: { tag: { in: jobIds.map((id) => `background-job-given-up:${id}`) } } });
  await prisma.backgroundJob.deleteMany({ where: { id: { in: jobIds } } });
  await prisma.botConversation.deleteMany({ where: { id: { in: convIds } } });
  await prisma.client.deleteMany({ where: { id: clientId } });
  await prisma.agent.deleteMany({ where: { id: ownerId } });
});

async function givenUpJob(type: string, conversationClientId: string | null) {
  const conv = await prisma.botConversation.create({
    data: { channel: "INSTAGRAM", subscriberId: `${runId}-${convIds.length}`, messages: [] as object[], ...(conversationClientId ? { clientId: conversationClientId } : {}) },
  });
  convIds.push(conv.id);
  const job = await prisma.backgroundJob.create({
    data: { type, payload: { conversationId: conv.id }, status: "GIVEN_UP", attempts: 3, maxAttempts: 3, lastError: "тест" },
  });
  jobIds.push(job.id);
  return job;
}

describe("сдавшееся задание: клиент ждёт ответа", () => {
  it("какие типы считаются «клиент ждёт»", () => {
    for (const type of ["ai-reply-retry", "ai-turn-blocked-followup", "telegram-reply-retry", "telegram-dm-reply-retry", "customer-anything"]) {
      expect(isClientWaitingJob(type)).toBe(true);
    }
    for (const type of ["geocode", "site-resync", "clip-compress", "tiktok-publish-retry"]) expect(isClientWaitingJob(type)).toBe(false);
  });

  it("ответ бота клиенту не ушёл: лента и звонок телефона хозяину карточки", async () => {
    const job = await givenUpJob("ai-reply-retry", clientId);
    await notifyStuckWorkGivenUp(job);
    const bell = await prisma.notification.findFirst({ where: { agentId: ownerId, tag: `background-job-given-up:${job.id}` } });
    expect(bell).not.toBeNull();
    expect(sendDevicePushToAgents).toHaveBeenCalledTimes(1);
    const [ids, payload] = sendDevicePushToAgents.mock.calls[0] as unknown as [string[], { title: string; body: string; tag: string }];
    expect(ids).toEqual([ownerId]);
    expect(payload.title).toContain("без ответа");
    expect(payload.tag).toBe(`client-waiting-given-up:${job.id}`);
  });

  it("задание не про клиента (картинка, карта) — без звонка, как и было", async () => {
    // Тип без ожидающего клиента, но с тем же хозяином через диалог: звонка быть не должно.
    const conv = await prisma.botConversation.create({ data: { channel: "INSTAGRAM", subscriberId: `${runId}-x`, messages: [] as object[], clientId } });
    convIds.push(conv.id);
    const job = await prisma.backgroundJob.create({ data: { type: "geocode", payload: { propertyId: "none" }, status: "GIVEN_UP", attempts: 3, maxAttempts: 3 } });
    jobIds.push(job.id);
    await notifyStuckWorkGivenUp(job);
    expect(sendDevicePushToAgents).not.toHaveBeenCalled();
  });

  it("у диалога нет хозяина карточки — без звонка (директору только лента)", async () => {
    const job = await givenUpJob("ai-reply-retry", null);
    await notifyStuckWorkGivenUp(job);
    expect(sendDevicePushToAgents).not.toHaveBeenCalled();
  });
});
