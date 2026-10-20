import { afterAll, beforeAll, describe, expect, it } from "vitest";

const { prisma } = await import("../src/db.js");
const { hasNewerContactSince } = await import("../src/lib/clientWorkStatus.js");

/**
 * hasNewerContactSince (ПР-000381, 24.09.2026) — три независимых источника
 * «клиент снова на связи» после момента `since`, любой из них достаточен.
 * Разбор звонка (ai/callAnalysis.ts) вызывает это ПЕРЕД deactivateClient,
 * чтобы устаревший разбор не перечеркнул более свежее событие.
 */

const runId = Date.now();
let agentId: string;
const clientIds: string[] = [];
const interactionIds: string[] = [];
const contactProfileIds: string[] = [];

async function makeClient(suffix: string) {
  const c = await prisma.client.create({
    data: {
      fullName: `hasNewerContactSince ${runId}-${suffix}`,
      phone: `+992967${runId}${suffix}`,
      source: "PHONE_CALL",
      kind: "BUYER",
      assignedAgentId: agentId,
      workStatus: "ACTIVE",
    },
  });
  clientIds.push(c.id);
  return c;
}

beforeAll(async () => {
  agentId = (
    await prisma.agent.create({
      data: { fullName: `Агент hasNewerContactSince ${runId}`, phone: `+992968${runId}`, role: "AGENT", passwordHash: "x" },
    })
  ).id;
});

afterAll(async () => {
  await prisma.contactProfile.deleteMany({ where: { id: { in: contactProfileIds } } });
  await prisma.interaction.deleteMany({ where: { id: { in: interactionIds } } });
  await prisma.client.deleteMany({ where: { id: { in: clientIds } } });
  await prisma.agent.deleteMany({ where: { id: agentId } });
});

const since = new Date("2026-09-20T11:00:00.000Z");
const after = new Date("2026-09-20T11:02:00.000Z");
const before = new Date("2026-09-20T10:00:00.000Z");

describe("hasNewerContactSince", () => {
  it("нет контакта позже `since` — false", async () => {
    const client = await makeClient("none");
    expect(await hasNewerContactSince(client.id, since)).toBe(false);
  });

  it("Client.returnedAt позже `since` (реактивация) — true", async () => {
    const client = await makeClient("returned");
    await prisma.client.update({ where: { id: client.id }, data: { returnedAt: after } });
    expect(await hasNewerContactSince(client.id, since)).toBe(true);
  });

  it("Client.returnedAt РАНЬШЕ `since` — не считается, false", async () => {
    const client = await makeClient("returned-before");
    await prisma.client.update({ where: { id: client.id }, data: { returnedAt: before } });
    expect(await hasNewerContactSince(client.id, since)).toBe(false);
  });

  it("более поздний состоявшийся звонок (есть запись) — true", async () => {
    const client = await makeClient("call-recorded");
    const i = await prisma.interaction.create({
      data: {
        clientId: client.id,
        agentId,
        type: "CALL",
        notes: "Звонок через CRM",
        createdAt: after,
        recordingDurationSec: 45,
      },
    });
    interactionIds.push(i.id);
    expect(await hasNewerContactSince(client.id, since)).toBe(true);
  });

  it("более поздний звонок, но НЕДОЗВОН (NO_ANSWER, без записи) — не считается контактом, false", async () => {
    const client = await makeClient("call-no-answer");
    const i = await prisma.interaction.create({
      data: {
        clientId: client.id,
        agentId,
        type: "CALL",
        notes: "Звонок через CRM",
        createdAt: after,
        outcome: "NO_ANSWER",
      },
    });
    interactionIds.push(i.id);
    expect(await hasNewerContactSince(client.id, since)).toBe(false);
  });

  it("более позднее входящее сообщение (ContactProfile.lastSeenAt) — true", async () => {
    const client = await makeClient("message");
    const p = await prisma.contactProfile.create({
      data: { clientId: client.id, lastSeenAt: after },
    });
    contactProfileIds.push(p.id);
    expect(await hasNewerContactSince(client.id, since)).toBe(true);
  });
});
