import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import bcrypt from "bcrypt";

/**
 * E1 глубокой проверки 02.10.2026: подметалка живых исходящих закрывала
 * разговор длиннее 10 минут, даже если он ещё шёл. finishCall запись не
 * забирает, а настоящий ChannelDestroyed после этого выходил по «уже ended» —
 * в карточке оставалось ~10 минут без записи, расшифровки и разбора.
 *
 * Теперь подметалка спрашивает станцию, жив ли канал, и закрывает только
 * мёртвый; закрыв, забирает запись тем же путём, что и ChannelDestroyed.
 * Станция не ответила — закрывается только то, что висит часами.
 * То же для сверки после переподписки (reconcileOrphanedOutgoingCalls).
 */

const ingested: Array<{ interactionId: string; channelId?: string }> = [];
vi.mock("../src/lib/telephony/callRecordings.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/lib/telephony/callRecordings.js")>()),
  ingestCallRecording: vi.fn(async (params: { interactionId: string; channelId?: string }) => {
    ingested.push({ interactionId: params.interactionId, channelId: params.channelId });
    return { ok: false as const, reason: "тест" };
  }),
}));

const { prisma } = await import("../src/db.js");
const { hasLiveCall, resetCalls, trackCall, sweepStaleLiveCalls, reconcileOrphanedOutgoingCalls, getCall } =
  await import("../src/lib/telephony/callTracker.js");

const runId = Date.now();
let agentId: string;
let clientId: string;

beforeAll(async () => {
  const passwordHash = await bcrypt.hash("testpass123", 10);
  agentId = (
    await prisma.agent.create({
      data: { fullName: `Агент долгого звонка ${runId}`, phone: `+992971${runId}`, role: "AGENT", passwordHash },
    })
  ).id;
  clientId = (
    await prisma.client.create({
      data: { fullName: `Клиент долгого звонка ${runId}`, phone: `+992972${runId}`, source: "PHONE_CALL", assignedAgentId: agentId },
    })
  ).id;
});

afterEach(() => {
  resetCalls();
  ingested.length = 0;
});

afterAll(async () => {
  await prisma.interaction.deleteMany({ where: { clientId } });
  await prisma.client.deleteMany({ where: { id: clientId } });
  await prisma.agent.deleteMany({ where: { id: agentId } });
  await prisma.$disconnect();
});

async function talkingCall(channelId: string, minutesAgo: number) {
  const interaction = await prisma.interaction.create({
    data: { clientId, agentId, type: "CALL", notes: "Звонок инициирован из CRM" },
  });
  const call = trackCall({
    channelId,
    agentId,
    clientId,
    clientShortId: 1,
    clientName: "Клиент долгого звонка",
    dialingTo: "1001",
    interactionId: interaction.id,
    agentExtension: "1001",
    clientPhone: "+992900000000",
  });
  call.startedAt = new Date(Date.now() - minutesAgo * 60_000);
  call.state = "talking";
  call.answeredAt = new Date(Date.now() - (minutesAgo - 1) * 60_000);
  call.clientRang = true;
  return { call, interactionId: interaction.id };
}

describe("подметалка живых исходящих — только по слову станции", () => {
  it("разговор 25 минут, станция говорит «канал жив» — не закрывается", async () => {
    const channelId = `long-live-${runId}`;
    await talkingCall(channelId, 25);
    const closed = await sweepStaleLiveCalls({ liveChannelIds: async () => new Set([channelId]) });
    expect(closed).toBe(0);
    expect(hasLiveCall(agentId)).toBe(true);
    expect(getCall(channelId)?.state).toBe("talking");
  });

  it("станция не ответила — разговор 25 минут не закрывается, висящий 5 часов закрывается", async () => {
    const live = `unknown-live-${runId}`;
    await talkingCall(live, 25);
    expect(await sweepStaleLiveCalls({ liveChannelIds: async () => null })).toBe(0);
    expect(hasLiveCall(agentId)).toBe(true);
    resetCalls();

    const ghost = `unknown-ghost-${runId}`;
    await talkingCall(ghost, 5 * 60);
    expect(await sweepStaleLiveCalls({ liveChannelIds: async () => null })).toBe(1);
    expect(hasLiveCall(agentId)).toBe(false);
  });

  it("станция не знает канал — звонок закрыт и запись разговора забирается", async () => {
    const channelId = `dead-${runId}`;
    const { interactionId } = await talkingCall(channelId, 25);
    const closed = await sweepStaleLiveCalls({ liveChannelIds: async () => new Set() });
    expect(closed).toBe(1);
    expect(hasLiveCall(agentId)).toBe(false);
    expect(ingested).toEqual([{ interactionId, channelId }]);
  });

  it("сверка после переподписки тоже забирает запись состоявшегося разговора", async () => {
    const channelId = `orphan-${runId}`;
    const { interactionId } = await talkingCall(channelId, 3);
    const closed = await reconcileOrphanedOutgoingCalls(new Set());
    expect(closed).toBe(1);
    expect(ingested).toEqual([{ interactionId, channelId }]);
  });
});
