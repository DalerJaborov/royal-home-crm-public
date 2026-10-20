import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import bcrypt from "bcrypt";
import { prisma } from "../src/db.js";
import { hasLiveCall, resetCalls, trackCall, reconcileOrphanedOutgoingCalls } from "../src/lib/telephony/callTracker.js";

/**
 * «Нажимаю позвонить — звонок не идёт» (владелец 19.08.2026): найденная причина —
 * `calls` (память процесса) снимается ТОЛЬКО событием ChannelDestroyed с АТС; если
 * подписка на события рвётся ровно на время разговора, событие теряется навсегда,
 * hasLiveCall(agentId) остаётся true, и агент блокируется на «У вас уже идёт
 * звонок» до перезапуска процесса. Фикс — reconcileOrphanedOutgoingCalls,
 * вызывается из resyncActiveChannels при каждой переподписке.
 */

const runId = Date.now();
let agentId: string;
let clientId: string;
let interactionId: string;

beforeAll(async () => {
  const passwordHash = await bcrypt.hash("testpass123", 10);
  agentId = (
    await prisma.agent.create({
      data: { fullName: `Агент осиротевшего звонка ${runId}`, phone: `+992971${runId}`, role: "AGENT", passwordHash },
    })
  ).id;
  clientId = (
    await prisma.client.create({
      data: { fullName: `Клиент осиротевшего звонка ${runId}`, phone: `+992972${runId}`, source: "PHONE_CALL", assignedAgentId: agentId },
    })
  ).id;
  interactionId = (
    await prisma.interaction.create({
      data: { clientId, agentId, type: "CALL", notes: "Звонок инициирован из CRM" },
    })
  ).id;
});

afterEach(() => resetCalls());

afterAll(async () => {
  await prisma.interaction.deleteMany({ where: { clientId } });
  await prisma.client.deleteMany({ where: { id: clientId } });
  await prisma.agent.deleteMany({ where: { id: agentId } });
  await prisma.$disconnect();
});

describe("reconcileOrphanedOutgoingCalls", () => {
  it("канал, которого станция больше не называет живым, закрывается и снимает блокировку", async () => {
    trackCall({
      channelId: `orphan-${runId}`,
      agentId,
      clientId,
      clientShortId: 1,
      clientName: "Клиент осиротевшего звонка",
      dialingTo: "1001",
      interactionId,
    });
    expect(hasLiveCall(agentId)).toBe(true);

    // Станция сейчас называет ноль живых каналов — наш висит только в памяти.
    const closed = await reconcileOrphanedOutgoingCalls(new Set());
    expect(closed).toBe(1);
    expect(hasLiveCall(agentId)).toBe(false);

    const interaction = await prisma.interaction.findUniqueOrThrow({ where: { id: interactionId } });
    expect(interaction.notes).not.toBe("Звонок инициирован из CRM");
  });

  it("канал, который станция всё ещё называет живым, не трогается", async () => {
    const channelId = `still-live-${runId}`;
    trackCall({
      channelId,
      agentId,
      clientId,
      clientShortId: 1,
      clientName: "Клиент осиротевшего звонка",
      dialingTo: "1001",
      interactionId,
    });

    const closed = await reconcileOrphanedOutgoingCalls(new Set([channelId]));
    expect(closed).toBe(0);
    expect(hasLiveCall(agentId)).toBe(true);
  });
});
