import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { prisma } from "../src/db.js";
import {
  computeAgentSilenceStats,
  findMostProvableCase,
  SILENCE_MIN_CASES,
  SILENCE_MIN_SHOWINGS,
} from "../src/lib/postShowingSilencePattern.js";

/**
 * ПОРОГ 4 — ЗАКОНОМЕРНОСТЬ ПРОТИВ ОСТАЛЬНЫХ (пороги утверждены владельцем 12.09).
 *
 * Здесь проверяется главное свойство порога: он молчит на шуме. Агент с тремя
 * показами и «100% тишины» — это три человека, а не картина; сравнение идёт с
 * ОСТАЛЬНЫМИ, без самого агента, иначе сильный агент сам себе поднимает планку.
 */

const runId = Date.now();
const DAY = 24 * 60 * 60 * 1000;
const NOW = new Date("2026-09-16T07:00:00Z");
const FROM = new Date(NOW.getTime() - 30 * DAY);

let suspectId: string;
let peerId: string;
let clientId: string;
let districtId: string;
let propertyId: string;
let phoneSeq = 0;

function phone(): string {
  phoneSeq++;
  return `+9926${String(runId).slice(-6)}${String(phoneSeq).padStart(2, "0")}`;
}

/** n показов, из них silent кончившихся тишиной. */
async function addCalls(agentId: string, n: number, silent: number) {
  for (let i = 0; i < n; i++) {
    const showing = await prisma.interaction.create({
      data: {
        clientId,
        agentId,
        type: "SHOWING",
        propertyId,
        notes: "Показ",
        nextActionDate: new Date(NOW.getTime() - (i + 2) * DAY),
      },
    });
    await prisma.postShowingCall.create({
      data: {
        showingId: showing.id,
        clientId,
        agentId,
        propertyId,
        scheduledFor: new Date(NOW.getTime() - (i + 2) * DAY),
        createdAt: new Date(NOW.getTime() - (i + 2) * DAY),
        ...(i < silent
          ? { status: "GIVEN_UP" as const, attempts: 2 }
          : { status: "DONE" as const, outcome: "NOT_SUITABLE" as const, talkedAt: new Date() }),
      },
    });
  }
}

beforeAll(async () => {
  districtId = (await prisma.district.create({ data: { name: `Тест-район-порог4-${runId}` } })).id;
  suspectId = (
    await prisma.agent.create({ data: { fullName: "Агент Подозрев", phone: phone(), role: "AGENT", passwordHash: "x" } })
  ).id;
  peerId = (
    await prisma.agent.create({ data: { fullName: "Агент Обычный", phone: phone(), role: "AGENT", passwordHash: "x" } })
  ).id;
  clientId = (
    await prisma.client.create({
      data: {
        fullName: `Клиент порога ${runId}`,
        phone: phone(),
        source: "PHONE_CALL",
        kind: "BUYER",
        assignedAgentId: suspectId,
        acceptedAt: new Date(),
      },
    })
  ).id;
  propertyId = (
    await prisma.property.create({
      data: {
        title: `Объект порога ${runId}`,
        type: "APARTMENT",
        areaSqm: 50,
        price: 45000,
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
  await prisma.property.deleteMany({ where: { id: propertyId } });
  await prisma.client.deleteMany({ where: { id: clientId } });
  await prisma.agent.deleteMany({ where: { id: { in: [suspectId, peerId] } } });
  await prisma.district.deleteMany({ where: { id: districtId } });
  await prisma.$disconnect();
});

beforeEach(async () => {
  await prisma.postShowingCall.deleteMany({ where: { clientId } });
  await prisma.interaction.deleteMany({ where: { clientId } });
});

function statOf(stats: Awaited<ReturnType<typeof computeAgentSilenceStats>>, agentId: string) {
  return stats.find((s) => s.agentId === agentId);
}

describe("доля тишины по агентам", () => {
  it("мало показов — не считаем вовсе, сколько бы тишины ни было", async () => {
    await addCalls(suspectId, SILENCE_MIN_SHOWINGS - 3, SILENCE_MIN_SHOWINGS - 3);
    await addCalls(peerId, 25, 2);

    const stats = await computeAgentSilenceStats(FROM, NOW);
    expect(statOf(stats, suspectId)?.ratePercent).toBe(100);
    expect(statOf(stats, suspectId)?.suspicious).toBe(false);
  });

  it("мало базы сравнения — тоже молчим", async () => {
    await addCalls(suspectId, 10, 9);
    await addCalls(peerId, 5, 0);

    expect(statOf(await computeAgentSilenceStats(FROM, NOW), suspectId)?.suspicious).toBe(false);
  });

  it("разрыв есть и все пороги сошлись — вот теперь это картина", async () => {
    await addCalls(suspectId, 10, 9);
    await addCalls(peerId, 25, 3);

    const stat = statOf(await computeAgentSilenceStats(FROM, NOW), suspectId);
    expect(stat?.silent).toBeGreaterThanOrEqual(SILENCE_MIN_CASES);
    expect(stat?.ratePercent).toBe(90);
    expect(stat?.peerRatePercent).toBe(12);
    expect(stat?.suspicious).toBe(true);
  });

  it("сравнение идёт с ОСТАЛЬНЫМИ, а не со средней по агентству", async () => {
    await addCalls(suspectId, 10, 10);
    await addCalls(peerId, 20, 0);

    const stat = statOf(await computeAgentSilenceStats(FROM, NOW), suspectId);
    // Средняя по агентству была бы 33%, и разрыв «100 против 33» выглядел бы
    // втрое меньше настоящего. Против остальных он честный: 100 против 0.
    expect(stat?.peerRatePercent).toBe(0);
    expect(stat?.peerShowings).toBe(20);
  });

  it("показ, по которому клиент всё объяснил, тишиной не считается", async () => {
    await addCalls(suspectId, 10, 0);

    expect(statOf(await computeAgentSilenceStats(FROM, NOW), suspectId)?.silent).toBe(0);
  });
});

describe("самый доказуемый случай", () => {
  it("без единого красного исхода — случая нет, и это нормально", async () => {
    await addCalls(suspectId, 10, 9);
    expect(await findMostProvableCase(FROM, NOW)).toBeNull();
  });

  it("берётся тот, где есть дословная фраза человека", async () => {
    await addCalls(suspectId, 3, 0);
    const call = await prisma.postShowingCall.findFirstOrThrow({ where: { agentId: suspectId } });
    await prisma.postShowingCall.update({
      where: { id: call.id },
      data: { outcome: "BYPASS", quote: "он сказал, давайте напрямую, без агентства", outcomeConfidence: 0.95 },
    });

    const found = await findMostProvableCase(FROM, NOW);
    expect(found?.quote).toContain("напрямую");
    expect(found?.clientShortId).toBeGreaterThan(0);
    expect(found?.what).toContain("мимо компании");
  });
});
