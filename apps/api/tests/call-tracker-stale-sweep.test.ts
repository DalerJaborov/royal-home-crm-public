import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import bcrypt from "bcrypt";
import { prisma } from "../src/db.js";
import { hasLiveCall, resetCalls, trackCall, sweepStaleLiveCalls } from "../src/lib/telephony/callTracker.js";

/**
 * Второй уровень подстраховки потерянного ChannelDestroyed (найдено ревью
 * 19.08.2026): reconcileOrphanedOutgoingCalls закрывает дыру только при
 * ПЕРЕПОДПИСКЕ на события АТС — если Asterisk уронит канал без разрыва самого
 * websocket-соединения, переподписки не будет никогда, и запись в `calls`
 * висит до перезапуска процесса. sweepStaleLiveCalls закрывает эту дыру по
 * расписанию, не по событию.
 *
 * startedAt сдвигается напрямую на объекте, который возвращает trackCall —
 * это проще и надёжнее фейковых таймеров: sweepStaleLiveCalls внутри пишет в
 * реальную БД, и подменённые часы событийного цикла тут только мешают.
 */

const runId = Date.now();
let agentId: string;
let clientId: string;
let interactionId: string;

beforeAll(async () => {
  const passwordHash = await bcrypt.hash("testpass123", 10);
  agentId = (
    await prisma.agent.create({
      data: { fullName: `Агент зависшего звонка ${runId}`, phone: `+992975${runId}`, role: "AGENT", passwordHash },
    })
  ).id;
  clientId = (
    await prisma.client.create({
      data: { fullName: `Клиент зависшего звонка ${runId}`, phone: `+992976${runId}`, source: "PHONE_CALL", assignedAgentId: agentId },
    })
  ).id;
  interactionId = (
    await prisma.interaction.create({ data: { clientId, agentId, type: "CALL", notes: "Звонок инициирован из CRM" } })
  ).id;
});

afterEach(() => resetCalls());

afterAll(async () => {
  await prisma.interaction.deleteMany({ where: { clientId } });
  await prisma.client.deleteMany({ where: { id: clientId } });
  await prisma.agent.deleteMany({ where: { id: agentId } });
  await prisma.$disconnect();
});

describe("sweepStaleLiveCalls", () => {
  it("канал висит дольше 10 минут без события, станция его не знает — закрывается", async () => {
    const call = trackCall({
      channelId: `stale-${runId}`,
      agentId,
      clientId,
      clientShortId: 1,
      clientName: "Клиент зависшего звонка",
      dialingTo: "1001",
      interactionId,
    });
    call.startedAt = new Date(Date.now() - 11 * 60_000);
    expect(hasLiveCall(agentId)).toBe(true);

    // С 02.10.2026 (E1) закрывается только канал, которого нет у станции:
    // живой длинный разговор подметалка больше не обрывает.
    const closed = await sweepStaleLiveCalls({ liveChannelIds: async () => new Set() });
    expect(closed).toBe(1);
    expect(hasLiveCall(agentId)).toBe(false);
  });

  it("свежий звонок (меньше 10 минут) — не трогается", async () => {
    trackCall({
      channelId: `fresh-${runId}`,
      agentId,
      clientId,
      clientShortId: 1,
      clientName: "Клиент зависшего звонка",
      dialingTo: "1001",
      interactionId,
    });

    const closed = await sweepStaleLiveCalls({ liveChannelIds: async () => new Set() });
    expect(closed).toBe(0);
    expect(hasLiveCall(agentId)).toBe(true);
  });

  it("канал в процессе замены на мобильный (retiring) — не трогается, даже если завис", async () => {
    const call = trackCall({
      channelId: `retiring-${runId}`,
      agentId,
      clientId,
      clientShortId: 1,
      clientName: "Клиент зависшего звонка",
      dialingTo: "1001",
      interactionId,
    });
    call.retiring = true;
    call.startedAt = new Date(Date.now() - 15 * 60_000);

    const closed = await sweepStaleLiveCalls({ liveChannelIds: async () => new Set() });
    expect(closed).toBe(0);
  });
});
