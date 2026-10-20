import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { prisma } from "../src/db.js";
import { closeSettledCallbackRequests } from "../src/lib/callbackRequests.js";

/**
 * Плашка «Клиент просит звонок» гаснет сама (18.08.2026): по факту состоявшегося
 * звонка и по истечении двух суток. Проверяем ровно границы — звонок ДО просьбы её
 * не закрывает, а свежая просьба без звонка обязана остаться на экране.
 */

const runId = Date.now();
const HOUR = 60 * 60 * 1000;

let agentId: string;
const clientIds: string[] = [];
const requestIds: string[] = [];

async function makeClient(name: string, phone: string) {
  const c = await prisma.client.create({
    data: { fullName: `${name} ${runId}`, phone, source: "PHONE_CALL", assignedAgentId: agentId },
  });
  clientIds.push(c.id);
  return c;
}

async function makeRequest(data: { clientId?: string; phone?: string; ageMs: number }) {
  const row = await prisma.callbackRequest.create({
    data: {
      clientId: data.clientId ?? null,
      phone: data.phone ?? null,
      channel: "INSTAGRAM",
      topic: `Тест самозакрытия ${runId}`,
      requestedAt: new Date(Date.now() - data.ageMs),
    },
  });
  requestIds.push(row.id);
  return row;
}

async function makeCall(clientId: string, ageMs: number) {
  return prisma.interaction.create({
    data: { clientId, agentId, type: "CALL", notes: "Звонок агента", createdAt: new Date(Date.now() - ageMs) },
  });
}

beforeAll(async () => {
  agentId = (
    await prisma.agent.create({
      data: {
        fullName: `Агент обратных звонков ${runId}`,
        phone: `+992949${runId}`,
        role: "AGENT",
        passwordHash: "x",
      },
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

describe("Самозакрытие просьб о звонке", () => {
  it("звонок ПОСЛЕ просьбы закрывает её автором звонка", async () => {
    const client = await makeClient("Ему позвонили", `+992948${runId}`);
    const req = await makeRequest({ clientId: client.id, ageMs: 3 * HOUR });
    await makeCall(client.id, 1 * HOUR);

    await closeSettledCallbackRequests();

    const after = await prisma.callbackRequest.findUnique({ where: { id: req.id } });
    expect(after?.doneAt).not.toBeNull();
    expect(after?.doneById).toBe(agentId);
  });

  it("сопоставление по телефону работает, когда у просьбы нет клиента", async () => {
    const phone = `+992947${runId}`;
    const client = await makeClient("Только номер", phone);
    const req = await makeRequest({ phone, ageMs: 3 * HOUR });
    await makeCall(client.id, 1 * HOUR);

    await closeSettledCallbackRequests();

    const after = await prisma.callbackRequest.findUnique({ where: { id: req.id } });
    expect(after?.doneAt).not.toBeNull();
    expect(after?.doneById).toBe(agentId);
  });

  it("звонок ДО просьбы её не закрывает — он и есть повод для просьбы", async () => {
    const client = await makeClient("Звонили раньше", `+992946${runId}`);
    const req = await makeRequest({ clientId: client.id, ageMs: 1 * HOUR });
    await makeCall(client.id, 5 * HOUR);

    await closeSettledCallbackRequests();

    const after = await prisma.callbackRequest.findUnique({ where: { id: req.id } });
    expect(after?.doneAt).toBeNull();
  });

  it("просьба старше двух суток закрывается как протухшая, без автора и со следом в хронологии", async () => {
    const client = await makeClient("Протухшая просьба", `+992945${runId}`);
    const req = await makeRequest({ clientId: client.id, ageMs: 50 * HOUR });

    await closeSettledCallbackRequests();

    const after = await prisma.callbackRequest.findUnique({ where: { id: req.id } });
    expect(after?.doneAt).not.toBeNull();
    expect(after?.doneById).toBeNull();

    const note = await prisma.interaction.findFirst({ where: { clientId: client.id, type: "SYSTEM" } });
    expect(note?.notes).toContain("истекли двое суток");
  });

  it("свежая просьба без звонка остаётся открытой", async () => {
    const client = await makeClient("Ещё ждёт", `+992944${runId}`);
    const req = await makeRequest({ clientId: client.id, ageMs: 2 * HOUR });

    await closeSettledCallbackRequests();

    const after = await prisma.callbackRequest.findUnique({ where: { id: req.id } });
    expect(after?.doneAt).toBeNull();
    expect(after?.doneById).toBeNull();
  });

  it("повторный прогон не переписывает уже закрытую просьбу", async () => {
    const client = await makeClient("Идемпотентность", `+992943${runId}`);
    const req = await makeRequest({ clientId: client.id, ageMs: 3 * HOUR });
    await makeCall(client.id, 1 * HOUR);

    await closeSettledCallbackRequests();
    const first = await prisma.callbackRequest.findUnique({ where: { id: req.id } });
    await closeSettledCallbackRequests();
    const second = await prisma.callbackRequest.findUnique({ where: { id: req.id } });

    expect(second?.doneAt?.getTime()).toBe(first?.doneAt?.getTime());
    expect(second?.doneById).toBe(first?.doneById);
  });
});
