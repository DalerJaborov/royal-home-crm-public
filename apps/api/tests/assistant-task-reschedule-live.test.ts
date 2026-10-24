import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";

const { noteTaskRescheduleAndAlarmIfAnomalous } = vi.hoisted(() => ({
  noteTaskRescheduleAndAlarmIfAnomalous: vi.fn(async () => undefined),
}));
// Select/update use the real PostgreSQL database. Keep the unrelated background
// anomaly notification out of this selection regression; no model is invoked.
vi.mock("../src/lib/taskRescheduleAnomalyAlarm.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/lib/taskRescheduleAnomalyAlarm.js")>()),
  noteTaskRescheduleAndAlarmIfAnomalous,
}));

const { prisma } = await import("../src/db.js");
const { runTool } = await import("../src/ai/assistant.js");
const runId = randomUUID();
const clients: string[] = [];
const oldAt = new Date("2031-06-10T10:00:00.000Z");
const laterAt = new Date("2031-06-11T10:00:00.000Z");
const declinedAt = new Date("2031-06-09T10:00:00.000Z");
const newDate = "2031-06-15T15:00";
const newAt = new Date("2031-06-15T10:00:00.000Z");
let ownerId: string;
let otherId: string;
let districtId: string;
let propertyId: string;

const actor = () => ({ id: ownerId, role: "AGENT", canViewAllClients: false, canViewPhone: false,
  canViewReports: false, canViewFinance: false, canViewAllDeals: false });
async function client(assignedAgentId = ownerId, extra = {}) {
  const row = await prisma.client.create({ data: {
    fullName: "Synthetic task client", phone: `test-client-${randomUUID()}`, source: "WEBSITE",
    assignedAgentId, acceptedAt: new Date(), ...extra,
  } });
  clients.push(row.id);
  return row;
}
async function task(clientId: string, extra: Record<string, unknown> = {}) {
  return prisma.interaction.create({ data: {
    clientId, agentId: ownerId, type: "CALL", notes: "Synthetic task",
    nextAction: "Call back", nextActionDate: oldAt, ...extra,
  } });
}
async function cancelled(clientId: string, at = oldAt) {
  return task(clientId, { type: "SHOWING", propertyId, nextAction: null,
    nextActionDate: at, completedAt: null, declinedAt, notes: "Synthetic showing cancelled with reason" });
}
const reschedule = (clientId: string) => runTool("reschedule_task", { clientId, newDate }, actor());

beforeAll(async () => {
  const agent = async (label: string) => (await prisma.agent.create({ data: {
    fullName: `Synthetic ${label}`, phone: `test-agent-${randomUUID()}`, role: "AGENT", passwordHash: "test-unused-hash",
  } })).id;
  ownerId = await agent("task owner");
  otherId = await agent("other owner");
  districtId = (await prisma.district.create({ data: { name: `task-reschedule-${runId}` } })).id;
  propertyId = (await prisma.property.create({ data: {
    title: "Synthetic showing property", districtId, type: "APARTMENT", areaSqm: 50,
    price: 100, currency: "TJS", condition: "GOOD", address: "Synthetic address",
  } })).id;
});
afterAll(async () => {
  await prisma.interaction.deleteMany({ where: { clientId: { in: clients } } });
  await prisma.client.deleteMany({ where: { id: { in: clients } } });
  await prisma.property.delete({ where: { id: propertyId } });
  await prisma.district.delete({ where: { id: districtId } });
  await prisma.agent.deleteMany({ where: { id: { in: [ownerId, otherId] } } });
  await prisma.$disconnect();
});

describe("assistant reschedule_task selects a live task", () => {
  it("cancelled-only history returns no planned task and keeps its historical appointment", async () => {
    const c = await client();
    const old = await cancelled(c.id);
    expect(await reschedule(c.id)).toEqual({ error: "У клиента нет запланированных задач для переноса" });
    expect(await prisma.interaction.findUnique({ where: { id: old.id } })).toMatchObject({
      nextAction: null, nextActionDate: oldAt, declinedAt, completedAt: null, notes: old.notes,
    });
  });

  it("a cancelled later showing cannot consume the request for an existing live CALL", async () => {
    const c = await client();
    const live = await task(c.id);
    const old = await cancelled(c.id, laterAt);
    expect(await reschedule(c.id)).toMatchObject({ ok: true, task: "Call back", newDate });
    expect(await prisma.interaction.findUnique({ where: { id: live.id } })).toMatchObject({ nextActionDate: newAt });
    expect(await prisma.interaction.findUnique({ where: { id: old.id } })).toMatchObject({
      nextAction: null, nextActionDate: laterAt, declinedAt, completedAt: null,
    });
  });

  it.each(["CALL", "SHOWING"] as const)("an ordinary live %s still moves without changing its other state", async (type) => {
    const c = await client();
    const live = await task(c.id, { type, ...(type === "SHOWING" ? { propertyId } : {}),
      remindersSent: ["1h"], reminderSentAt: declinedAt });
    expect(await reschedule(c.id)).toMatchObject({ ok: true, task: "Call back", newDate });
    expect(await prisma.interaction.findUnique({ where: { id: live.id } })).toMatchObject({
      nextActionDate: newAt, completedAt: null, remindersSent: ["1h"], reminderSentAt: declinedAt,
    });
  });

  it("completed tasks remain excluded even when they have the later date", async () => {
    const c = await client();
    const live = await task(c.id);
    const done = await task(c.id, { completedAt: declinedAt, nextActionDate: laterAt });
    expect(await reschedule(c.id)).toMatchObject({ ok: true });
    expect(await prisma.interaction.findUnique({ where: { id: live.id } })).toMatchObject({ nextActionDate: newAt });
    expect(await prisma.interaction.findUnique({ where: { id: done.id } })).toMatchObject({ nextActionDate: laterAt, completedAt: declinedAt });
  });

  it("another agent's client cannot be moved", async () => {
    const c = await client(otherId);
    const live = await task(c.id, { agentId: otherId });
    expect(await reschedule(c.id)).toEqual({ error: "Нет доступа: клиент закреплён за другим агентом" });
    expect(await prisma.interaction.findUnique({ where: { id: live.id } })).toMatchObject({ nextActionDate: oldAt });
  });

  it.each([{ acceptedAt: null }, { deletedAt: declinedAt }])("unaccepted/deleted client is still unavailable: %j", async (extra) => {
    const c = await client(ownerId, extra);
    const live = await task(c.id);
    expect(await reschedule(c.id)).toEqual({ error: "Клиент не найден" });
    expect(await prisma.interaction.findUnique({ where: { id: live.id } })).toMatchObject({ nextActionDate: oldAt });
  });
});
