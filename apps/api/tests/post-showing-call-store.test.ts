import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { prisma } from "../src/db.js";
import {
  duePostShowingCalls,
  findPostShowingCallByChannel,
  hasRecentPostShowingCall,
  markPostShowingCallNoAnswer,
  markPostShowingCallSkipped,
  markPostShowingCallStarted,
  savePostShowingCallOutcome,
  schedulePostShowingCall,
} from "../src/lib/postShowingCalls.js";

/**
 * ХРАНИЛИЩЕ РОБОЗВОНКОВ ПОСЛЕ ПОКАЗА (13.09.2026).
 *
 * Проверяется только форма хранения — часы, лимиты и разбор разговора живут в
 * расписании и покрываются отдельно. Главное здесь одно: **перенос показа
 * уводит звонок вместе с ним**. Ради этого свойства расписание и построено на
 * кроне, а не на очереди заданий (задание несёт `runAt`, снятый при постановке,
 * и перепостановка с тем же ключом, пока оно `PENDING`, — no-op, то есть звонок
 * ушёл бы по старому часу к перенесённому показу).
 */

const runId = Date.now();
let agentId: string;
let clientId: string;
let propertyId: string;
let districtId: string;
const showingIds: string[] = [];

async function makeShowing(at: Date): Promise<string> {
  const showing = await prisma.interaction.create({
    data: {
      clientId,
      agentId,
      type: "SHOWING",
      propertyId,
      notes: "Показ",
      nextAction: "Показ объекта",
      nextActionDate: at,
    },
  });
  showingIds.push(showing.id);
  return showing.id;
}

beforeAll(async () => {
  districtId = (await prisma.district.create({ data: { name: `Тест-район-звонок-${runId}` } })).id;
  agentId = (
    await prisma.agent.create({
      data: { fullName: "Агент звонка", phone: `+992944${runId}`, role: "AGENT", passwordHash: "x" },
    })
  ).id;
  clientId = (
    await prisma.client.create({
      data: {
        fullName: `Покупатель звонка ${runId}`,
        phone: `+992945${runId}`,
        source: "PHONE_CALL",
        kind: "BUYER",
        assignedAgentId: agentId,
        acceptedAt: new Date(),
      },
    })
  ).id;
  propertyId = (
    await prisma.property.create({
      data: {
        title: `Объект звонка ${runId}`,
        type: "APARTMENT",
        areaSqm: 45,
        price: 50000,
        currency: "TJS",
        districtId,
        address: "Тест",
        condition: "GOOD",
        status: "AVAILABLE",
      },
    })
  ).id;
});

afterAll(async () => {
  await prisma.postShowingCall.deleteMany({ where: { clientId } });
  await prisma.interaction.deleteMany({ where: { clientId } });
  await prisma.client.deleteMany({ where: { id: clientId } });
  await prisma.property.deleteMany({ where: { id: propertyId } });
  await prisma.agent.deleteMany({ where: { id: agentId } });
  await prisma.district.deleteMany({ where: { id: districtId } });
  await prisma.$disconnect();
});

function schedule(showingId: string, at: Date) {
  return schedulePostShowingCall({ showingId, clientId, agentId, propertyId, scheduledFor: at });
}

describe("постановка звонка", () => {
  it("первый раз заводит запись, второй — не заводит вторую", async () => {
    const showingId = await makeShowing(new Date());
    const at = new Date("2026-09-16T09:00:00Z");

    expect(await schedule(showingId, at)).toBe("created");
    expect(await schedule(showingId, at)).toBe("kept");
    expect(await prisma.postShowingCall.count({ where: { showingId } })).toBe(1);
  });

  it("показ перенесли — звонок уехал вместе с ним", async () => {
    const showingId = await makeShowing(new Date());
    await schedule(showingId, new Date("2026-09-16T09:00:00Z"));

    const moved = new Date("2026-09-17T11:30:00Z");
    expect(await schedule(showingId, moved)).toBe("moved");

    const row = await prisma.postShowingCall.findUnique({ where: { showingId } });
    expect(row?.scheduledFor.toISOString()).toBe(moved.toISOString());
  });

  it("уже набранный звонок задним числом не двигают", async () => {
    const showingId = await makeShowing(new Date());
    await schedule(showingId, new Date("2026-09-16T09:00:00Z"));
    const row = await prisma.postShowingCall.findUniqueOrThrow({ where: { showingId } });
    await markPostShowingCallStarted(row.id, `chan-${runId}-started`, new Date());

    expect(await schedule(showingId, new Date("2026-09-18T09:00:00Z"))).toBe("kept");
    const after = await prisma.postShowingCall.findUniqueOrThrow({ where: { showingId } });
    expect(after.scheduledFor.toISOString()).toBe(new Date("2026-09-16T09:00:00Z").toISOString());
  });
});

describe("очередь набора", () => {
  it("берёт только те, чей час настал, и только ждущие", async () => {
    const past = await makeShowing(new Date());
    const future = await makeShowing(new Date());
    const done = await makeShowing(new Date());
    const now = new Date("2026-09-16T12:00:00Z");

    await schedule(past, new Date("2026-09-16T10:00:00Z"));
    await schedule(future, new Date("2026-09-16T18:00:00Z"));
    await schedule(done, new Date("2026-09-16T08:00:00Z"));
    const doneRow = await prisma.postShowingCall.findUniqueOrThrow({ where: { showingId: done } });
    await savePostShowingCallOutcome(doneRow.id, {
      outcome: "NOT_SUITABLE",
      confidence: 0.9,
      quote: null,
      redFlags: [],
      summary: "Не подошла планировка",
      talkedAt: now,
    });

    const due = await duePostShowingCalls(now);
    const ids = due.map((d) => d.showingId);
    expect(ids).toContain(past);
    expect(ids).not.toContain(future);
    expect(ids).not.toContain(done);
  });

  it("недозвон возвращает запись в очередь, но только пока есть попытки", async () => {
    const showingId = await makeShowing(new Date());
    await schedule(showingId, new Date("2026-09-16T10:00:00Z"));
    const row = await prisma.postShowingCall.findUniqueOrThrow({ where: { showingId } });

    await markPostShowingCallStarted(row.id, `chan-${runId}-1`, new Date("2026-09-16T10:01:00Z"));
    await markPostShowingCallNoAnswer(row.id, new Date("2026-09-16T15:00:00Z"));
    let due = await duePostShowingCalls(new Date("2026-09-16T16:00:00Z"));
    expect(due.map((d) => d.showingId)).toContain(showingId);
    expect(due.find((d) => d.showingId === showingId)?.attempts).toBe(1);

    await markPostShowingCallStarted(row.id, `chan-${runId}-2`, new Date("2026-09-16T16:01:00Z"));
    await markPostShowingCallNoAnswer(row.id, null);
    due = await duePostShowingCalls(new Date("2026-09-17T09:00:00Z"));
    expect(due.map((d) => d.showingId)).not.toContain(showingId);
    expect((await prisma.postShowingCall.findUniqueOrThrow({ where: { showingId } })).status).toBe("GIVEN_UP");
  });

  it("пропущенный звонок уносит с собой причину — иначе покрытие опроса не посчитать", async () => {
    const showingId = await makeShowing(new Date());
    await schedule(showingId, new Date("2026-09-16T10:00:00Z"));
    const row = await prisma.postShowingCall.findUniqueOrThrow({ where: { showingId } });

    await markPostShowingCallSkipped(row.id, "client_answered");

    const after = await prisma.postShowingCall.findUniqueOrThrow({ where: { showingId } });
    expect(after.status).toBe("SKIPPED");
    expect(after.skipReason).toBe("client_answered");
    expect((await duePostShowingCalls(new Date("2026-09-16T12:00:00Z"))).map((d) => d.showingId)).not.toContain(
      showingId
    );
  });
});

describe("связь с разговором и недельный лимит", () => {
  it("канал ARI находит свой звонок", async () => {
    const showingId = await makeShowing(new Date());
    await schedule(showingId, new Date("2026-09-16T10:00:00Z"));
    const row = await prisma.postShowingCall.findUniqueOrThrow({ where: { showingId } });
    const channelId = `chan-${runId}-lookup`;

    await markPostShowingCallStarted(row.id, channelId, new Date());

    expect((await findPostShowingCallByChannel(channelId))?.showingId).toBe(showingId);
    expect(await findPostShowingCallByChannel(`chan-${runId}-nobody`)).toBeNull();
  });

  it("лимит считает набранные номера, а не заведённые записи", async () => {
    const week = new Date(Date.now() - 7 * 24 * 3600_000);
    await prisma.postShowingCall.deleteMany({ where: { clientId } });

    const showingId = await makeShowing(new Date());
    await schedule(showingId, new Date("2026-09-16T10:00:00Z"));
    // Запись есть, но человека никто не побеспокоил — права на тишину она не тратит.
    expect(await hasRecentPostShowingCall(clientId, week)).toBe(false);

    const row = await prisma.postShowingCall.findUniqueOrThrow({ where: { showingId } });
    await markPostShowingCallStarted(row.id, `chan-${runId}-limit`, new Date());
    expect(await hasRecentPostShowingCall(clientId, week)).toBe(true);
  });
});
