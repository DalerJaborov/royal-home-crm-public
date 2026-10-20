import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { prisma } from "../src/db.js";
import { closeSettledCallbackRequests } from "../src/lib/callbackRequests.js";

/**
 * CALL-01 (аудит 04.10.2026): просьбу «перезвоните» закрывал ЛЮБОЙ звонок агента
 * после неё, в том числе несостоявшийся: AGENT_NO_PICKUP (агент не снял свою
 * трубку, клиенту не звонили) и CANCELLED (отбой до ответа клиента). Клиент
 * оставался без звонка, а плашка гасла.
 */
const runId = Date.now();
const HOUR = 60 * 60 * 1000;

let agentId: string;
const clientIds: string[] = [];
const requestIds: string[] = [];

async function setup(callAttempt: string | null) {
  const client = await prisma.client.create({
    data: {
      fullName: `Просьба ${callAttempt ?? "ручной"} ${runId}`,
      phone: `+992948${runId}${clientIds.length}`,
      source: "PHONE_CALL",
      assignedAgentId: agentId,
    },
  });
  clientIds.push(client.id);
  const req = await prisma.callbackRequest.create({
    data: {
      clientId: client.id,
      channel: "INSTAGRAM",
      topic: `Тест CALL-01 ${runId}`,
      requestedAt: new Date(Date.now() - 3 * HOUR),
    },
  });
  requestIds.push(req.id);
  await prisma.interaction.create({
    data: {
      clientId: client.id,
      agentId,
      type: "CALL",
      notes: "Звонок агента",
      callAttempt,
      createdAt: new Date(Date.now() - 1 * HOUR),
    },
  });
  return req;
}

beforeAll(async () => {
  agentId = (
    await prisma.agent.create({
      data: { fullName: `Агент CALL-01 ${runId}`, phone: `+992947${runId}`, role: "AGENT", passwordHash: "x" },
    })
  ).id;
});

afterAll(async () => {
  await prisma.callbackRequest.deleteMany({ where: { id: { in: requestIds } } });
  await prisma.interaction.deleteMany({ where: { clientId: { in: clientIds } } });
  await prisma.client.deleteMany({ where: { id: { in: clientIds } } });
  await prisma.agent.deleteMany({ where: { id: agentId } });
  await prisma.$disconnect();
});

describe("closeSettledCallbackRequests: несостоявшийся звонок не закрывает просьбу (CALL-01)", () => {
  it("AGENT_NO_PICKUP и CANCELLED оставляют просьбу открытой; TALKED, NO_ANSWER и ручная запись закрывают", async () => {
    const noPickup = await setup("AGENT_NO_PICKUP");
    const cancelled = await setup("CANCELLED");
    const talked = await setup("TALKED");
    const noAnswer = await setup("NO_ANSWER");
    const manual = await setup(null);

    await closeSettledCallbackRequests();

    const done = async (id: string) => (await prisma.callbackRequest.findUnique({ where: { id } }))?.doneAt != null;
    expect(await done(noPickup.id)).toBe(false);
    expect(await done(cancelled.id)).toBe(false);
    expect(await done(talked.id)).toBe(true);
    expect(await done(noAnswer.id)).toBe(true);
    expect(await done(manual.id)).toBe(true);
  });
});
