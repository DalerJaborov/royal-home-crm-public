import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { prisma } from "../src/db.js";
import { qualifyIncomingCall } from "../src/lib/telephony/qualifyIncoming.js";
import { transferPropertyNumber } from "../src/lib/telephony/liveVoiceTransfer.js";
import { newPropertyCallMemory } from "../src/lib/telephony/liveVoicePropertyTools.js";
import { deleteAgentsWithTraces } from "./helpers/cleanupAgents.js";

/**
 * P0-4 аудита docs/audit-bots-2026-10-10-object-routing.md — звонок по объекту.
 *  1. «Кто снял трубку» больше не сильнее «чей объект»: если объект звонка назван
 *     прямо (узнан роботом), новый лид уходит хозяину объекта, непринятым, а
 *     ответившему — запись в хронологии. Без объекта — как раньше: ответившему,
 *     сразу принятым. Ответил сам хозяин — ему, принятым.
 *  2. Робот: модель вызвала перевод без номера объекта — резервом берётся объект,
 *     узнанный в звонке (identifiedPropertyId).
 */
const runId = Date.now();
const tail = String(runId).slice(-6);
let districtId: string;
let ownerId: string;
let answererId: string;
let propertyId: string;
let propertyShortId: number;
const clientIds: string[] = [];
const callIds: string[] = [];

async function qualify(label: string, input: { answeredByAgentId: string; knownPropertyId?: string | null }) {
  const client = await prisma.client.create({
    data: { fullName: `Входящий ${label} ${runId}`, phone: `+99299${tail}${clientIds.length}`, source: "PHONE_CALL", kind: "BUYER" },
  });
  clientIds.push(client.id);
  const call = await prisma.incomingCall.create({
    data: { channelId: `orc-${runId}-${callIds.length}`, phone: client.phone, clientId: client.id, answered: true },
  });
  callIds.push(call.id);
  const delegate = prisma.settings;
  const real = delegate.findUnique.bind(delegate);
  const spy = vi.spyOn(delegate, "findUnique").mockImplementation((async (args: Parameters<typeof real>[0]) => {
    const row = await real(args);
    return row ? { ...row, leadDistributionStrategy: "fair", incomingAssignOnQualify: true } : row;
  }) as never);
  try {
    const result = await qualifyIncomingCall({
      callId: call.id,
      operatorId: null,
      answeredByAgentId: input.answeredByAgentId,
      knownPropertyId: input.knownPropertyId ?? null,
      data: { kind: "BUYER", fullName: "Фарход" },
    });
    expect("error" in result).toBe(false);
  } finally {
    spy.mockRestore();
  }
  return prisma.client.findUniqueOrThrow({ where: { id: client.id } });
}

beforeAll(async () => {
  districtId = (await prisma.district.create({ data: { name: `Район-звонок-объект-${runId}` } })).id;
  const mk = (fullName: string, n: number) =>
    prisma.agent.create({ data: { fullName, role: "AGENT", phone: `+99290${tail}${n}`, passwordHash: "x" } });
  ownerId = (await mk("Хозяин объекта (звонок)", 1)).id;
  answererId = (await mk("Снял трубку (звонок)", 2)).id;
  const p = await prisma.property.create({
    data: {
      title: `Объект звонка ${runId}`,
      type: "APARTMENT",
      areaSqm: 65,
      rooms: 2,
      price: 350_000,
      currency: "TJS",
      districtId,
      address: "Тестовая, 5",
      condition: "GOOD",
      status: "AVAILABLE",
      intakeAgentId: ownerId,
    },
  });
  propertyId = p.id;
  propertyShortId = p.shortId;
});

afterAll(async () => {
  await prisma.interaction.deleteMany({ where: { clientId: { in: clientIds } } });
  await prisma.auditLog.deleteMany({ where: { entityId: { in: clientIds } } });
  await prisma.incomingCall.deleteMany({ where: { id: { in: callIds } } });
  await prisma.client.deleteMany({ where: { id: { in: clientIds } } });
  await prisma.property.deleteMany({ where: { id: propertyId } });
  await deleteAgentsWithTraces([ownerId, answererId]);
  await prisma.district.deleteMany({ where: { id: districtId } });
  await prisma.$disconnect();
});

describe("P0-4: звонок по объекту — хозяину объекта", () => {
  it("объект узнан роботом, трубку снял другой — лид хозяину, непринятым; ответившему запись", async () => {
    const after = await qualify("объект", { answeredByAgentId: answererId, knownPropertyId: propertyId });
    expect(after.assignedAgentId).toBe(ownerId);
    expect(after.acceptedAt).toBeNull();
    expect(after.assignReason).toBe("own_property_explicit");
    expect(after.matchedPropertyId).toBe(propertyId);
    const note = await prisma.interaction.findFirst({ where: { clientId: after.id, notes: { contains: "Трубку снял" } } });
    expect(note).not.toBeNull();
  });

  it("объекта нет — лид ответившему, сразу принятым (как раньше)", async () => {
    const after = await qualify("без объекта", { answeredByAgentId: answererId });
    expect(after.assignedAgentId).toBe(answererId);
    expect(after.acceptedAt).not.toBeNull();
  });

  it("трубку снял сам хозяин объекта — ему, сразу принятым", async () => {
    const after = await qualify("хозяин снял", { answeredByAgentId: ownerId, knownPropertyId: propertyId });
    expect(after.assignedAgentId).toBe(ownerId);
    expect(after.acceptedAt).not.toBeNull();
  });
});

describe("P0-4: перевод роботом без номера объекта", () => {
  it("номера нет — резервом объект, узнанный в звонке", async () => {
    const memory = newPropertyCallMemory({ callerPhone: null, clientId: null });
    memory.identifiedPropertyId = propertyId;
    expect(await transferPropertyNumber(memory, undefined)).toBe(propertyShortId);
  });

  it("номер назван и обсуждался — он и берётся; не обсуждался и объекта нет — нет номера", async () => {
    const memory = newPropertyCallMemory({ callerPhone: null, clientId: null });
    memory.discussedShortIds.push(777001);
    expect(await transferPropertyNumber(memory, 777001)).toBe(777001);
    expect(await transferPropertyNumber(memory, 777002)).toBeNull();
  });
});
