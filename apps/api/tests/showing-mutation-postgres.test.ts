import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { prisma } from "../src/db.js";
import { createShowingTx, rescheduleShowingTx, cancelShowingTx, lockShowingClientTx } from "../src/lib/showingMutation.js";
import { assertCustomerShowingAgentTx } from "../src/lib/customerShowing.js";

/** Real local transaction boundaries. No provider, model or notification mocks:
 * these kernels must not initiate any delivery or their own transaction. */
const run = randomUUID();
let agentId: string;
let districtId: string;
const clientIds: string[] = [];
const propertyIds: string[] = [];
const now = new Date("2026-10-15T05:00:00Z");
const at = new Date("2026-10-16T10:00:00Z");
const later = new Date("2026-10-17T11:00:00Z");

async function fixture() {
  const client = await prisma.client.create({ data: { fullName: `showing-kernel-${run}-${clientIds.length}`,
    phone: `+9929${Date.now()}${clientIds.length}`, source: "WHATSAPP", assignedAgentId: agentId } });
  clientIds.push(client.id);
  const property = await prisma.property.create({ data: { title: `showing-kernel-${run}-${propertyIds.length}`,
    type: "APARTMENT", areaSqm: 60, price: 500000, currency: "TJS", districtId, address: "Synthetic kernel fixture",
    condition: "GOOD", status: "AVAILABLE", assignedAgentId: agentId } });
  propertyIds.push(property.id);
  return { client, property };
}
async function book(clientId: string, propertyId: string) {
  return prisma.$transaction((tx) => createShowingTx(tx, { clientId, propertyId, at, now, notes: "Original booking",
    actor: { kind: "bot", channel: "INSTAGRAM" } }));
}

beforeAll(async () => {
  agentId = (await prisma.agent.create({ data: { fullName: `Kernel agent ${run}`, phone: `kernel-${run}`, passwordHash: "x", role: "AGENT" } })).id;
  districtId = (await prisma.district.create({ data: { name: `Kernel district ${run}` } })).id;
});
afterAll(async () => {
  await prisma.investigationCase.deleteMany({ where: { clientId: { in: clientIds } } });
  const interactions = await prisma.interaction.findMany({ where: { clientId: { in: clientIds } }, select: { id: true } });
  await prisma.pendingSummary.deleteMany({ where: { subjectId: { in: interactions.map((row) => row.id) }, kind: "meeting" } });
  await prisma.interaction.deleteMany({ where: { clientId: { in: clientIds } } });
  await prisma.client.deleteMany({ where: { id: { in: clientIds } } });
  await prisma.property.deleteMany({ where: { id: { in: propertyIds } } });
  if (districtId) await prisma.district.delete({ where: { id: districtId } });
  if (agentId) await prisma.agent.delete({ where: { id: agentId } });
});

describe("shared showing transaction kernel", () => {
  it("late cancellation records one private fact, early cancellation none, without completed KPI or extra timeline task", async () => {
    for (const late of [false, true]) {
      const { client, property } = await fixture();
      const showing = await book(client.id, property.id);
      const cancellation = { clientId: client.id, interactionId: showing.id, actorKind: "agent" as const,
        now: new Date(at.getTime() + (late ? 1000 : -1000)), notes: (row: { notes: string }) => `${row.notes}\nCancelled` };
      await prisma.$transaction(tx => cancelShowingTx(tx, cancellation));
      await expect(prisma.$transaction(tx => cancelShowingTx(tx, cancellation))).rejects.toThrow("stale_showing");
      const facts = await prisma.investigationEvidence.findMany({ where: { case: { clientId: client.id }, kind: "late-cancellation" } });
      expect(facts).toHaveLength(late ? 1 : 0);
      expect(await prisma.interaction.count({ where: { clientId: client.id } })).toBe(1);
      const row = await prisma.interaction.findUniqueOrThrow({ where: { id: showing.id } });
      expect(row.completedAt).toBeNull();
      expect(row.nextAction).toBeNull();
      expect(row.declinedAt).not.toBeNull();
    }
  });
  it("cannot reschedule a task cancelled by final refusal even after a new assignment", async () => {
    const { client, property } = await fixture();
    const showing = await book(client.id, property.id);
    await prisma.interaction.update({ where: { id: showing.id }, data: { taskCancelledAt: now } });
    await expect(prisma.$transaction(tx => rescheduleShowingTx(tx, {
      clientId: client.id, interactionId: showing.id, at: later, now,
      meetingSummaryAfterShowingMinutes: 90, actorKind: "agent", notes: () => "Must not replace history",
    }))).rejects.toMatchObject({ reason: "stale_showing" });
    expect(await prisma.interaction.findUniqueOrThrow({ where: { id: showing.id } }))
      .toMatchObject({ nextActionDate: at, completedAt: null, taskCancelledAt: now, notes: "Original booking" });
  });
  it("customer eligibility refuses an unaccepted assigned lead without accepting it or changing legacy booking policy", async () => {
    const { client, property } = await fixture();
    expect(client.acceptedAt).toBeNull();
    await expect(prisma.$transaction(async (tx) => {
      await lockShowingClientTx(tx, client.id);
      await assertCustomerShowingAgentTx(tx, client.id);
      throw new Error("Unaccepted lead passed the customer precondition");
    })).rejects.toMatchObject({ reason: "no_agent" });
    expect(await prisma.interaction.count({ where: { clientId: client.id } })).toBe(0);
    expect((await prisma.property.findUniqueOrThrow({ where: { id: property.id } })).viewsCount).toBe(0);
    expect((await prisma.client.findUniqueOrThrow({ where: { id: client.id } })).acceptedAt).toBeNull();
    // Legacy kernel retains the previously accepted business policy. A negative
    // customer gate must not silently become a global lead-acceptance change.
    const legacy = await book(client.id, property.id);
    expect(await prisma.interaction.findUniqueOrThrow({ where: { id: legacy.id } })).toMatchObject({ nextAction: "Показ объекта" });
  });
  it("refuses a root client rather than silently committing outside the caller transaction", async () => {
    const { client, property } = await fixture();
    await expect(createShowingTx(prisma, { clientId: client.id, propertyId: property.id, at, now, notes: "Must not exist", actor: { kind: "bot" } }))
      .rejects.toThrow("active transaction");
    expect(await prisma.interaction.count({ where: { clientId: client.id } })).toBe(0);
    expect((await prisma.property.findUniqueOrThrow({ where: { id: property.id } })).viewsCount).toBe(0);
  });
  it("keeps actual bot authorship and the existing effective agent, without impersonating that agent", async () => {
    const { client, property } = await fixture();
    const created = await book(client.id, property.id);
    expect(await prisma.interaction.findUniqueOrThrow({ where: { id: created.id } })).toMatchObject({
      actorKind: "BOT", agentId: null, subjectAgentId: agentId, clientId: client.id, propertyId: property.id,
      nextAction: "Показ объекта", nextActionDate: at,
    });
  });
  it("rolls back timeline, Client contact time and views when its caller aborts the surrounding transaction", async () => {
    const { client, property } = await fixture();
    await expect(prisma.$transaction(async (tx) => {
      await createShowingTx(tx, { clientId: client.id, propertyId: property.id, at, now, notes: "Rolled back", actor: { kind: "bot" } });
      throw new Error("caller aborts receipt");
    })).rejects.toThrow("caller aborts receipt");
    expect(await prisma.interaction.count({ where: { clientId: client.id } })).toBe(0);
    expect((await prisma.client.findUniqueOrThrow({ where: { id: client.id } })).lastContactAt).toEqual(client.lastContactAt);
    expect((await prisma.property.findUniqueOrThrow({ where: { id: property.id } })).viewsCount).toBe(0);
  });
  it("rereads availability under the local locks instead of trusting a preflight property", async () => {
    const { client, property } = await fixture();
    await prisma.property.update({ where: { id: property.id }, data: { status: "SOLD" } });
    await expect(book(client.id, property.id)).rejects.toMatchObject({ reason: "unavailable" });
    expect(await prisma.interaction.count({ where: { clientId: client.id } })).toBe(0);
  });
  it("resets the same resource confirmation and summary on reschedule, retaining actor and unrelated history", async () => {
    const { client, property } = await fixture();
    const created = await book(client.id, property.id);
    await prisma.interaction.update({ where: { id: created.id }, data: { notes: "Original booking\nStaff note", confirmedAt: now,
      confirmAskedAt: now, remindersSent: ["two-hours"], reminderSentAt: now, noShowNotifiedAt: now } });
    const summary = await prisma.pendingSummary.create({ data: { kind: "meeting", subjectId: created.id, subjectName: "Synthetic showing",
      agentId, dueAt: at, dismissedAt: now, snoozedUntil: at, snoozeCount: 3 } });
    await prisma.$transaction((tx) => rescheduleShowingTx(tx, { clientId: client.id, interactionId: created.id, at: later, now,
      actorKind: "client", meetingSummaryAfterShowingMinutes: 30, notes: (row) => `${row.notes}\nMoved once` }));
    expect(await prisma.interaction.findUniqueOrThrow({ where: { id: created.id } })).toMatchObject({
      notes: "Original booking\nStaff note\nMoved once", nextActionDate: later, confirmAskedAt: null, confirmedAt: null,
      declinedAt: null, remindersSent: [], reminderSentAt: null, noShowNotifiedAt: null, agentId: null, subjectAgentId: agentId,
    });
    expect((await prisma.property.findUniqueOrThrow({ where: { id: property.id } })).viewsCount).toBe(1);
    expect(await prisma.interaction.count({ where: { clientId: client.id, type: "SHOWING" } })).toBe(1);
    expect(await prisma.pendingSummary.findUniqueOrThrow({ where: { id: summary.id } })).toMatchObject({
      dueAt: new Date(later.getTime() + 30 * 60_000), dismissedAt: null, snoozedUntil: null, snoozeCount: 0, doneAt: null,
    });
  });
  it("never cancels a different client's resource or searches for a replacement", async () => {
    const own = await fixture(); const foreign = await fixture();
    const ownBooking = await book(own.client.id, own.property.id); const foreignBooking = await book(foreign.client.id, foreign.property.id);
    await expect(prisma.$transaction((tx) => cancelShowingTx(tx, { clientId: own.client.id, interactionId: foreignBooking.id, now,
      actorKind: "client", notes: () => "Must not be applied" }))).rejects.toMatchObject({ reason: "no_showing" });
    for (const id of [ownBooking.id, foreignBooking.id]) expect(await prisma.interaction.findUniqueOrThrow({ where: { id } }))
      .toMatchObject({ nextAction: "Показ объекта", declinedAt: null, notes: "Original booking" });
  });
  it("rolls back a change of property and both view counters when the enclosing operation aborts", async () => {
    const own = await fixture(); const other = await fixture();
    const created = await book(own.client.id, own.property.id);
    await expect(prisma.$transaction(async (tx) => {
      await rescheduleShowingTx(tx, { clientId: own.client.id, interactionId: created.id, propertyId: other.property.id,
        at: later, now, actorKind: "client", meetingSummaryAfterShowingMinutes: 30, notes: (row) => `${row.notes}\nDifferent property` });
      throw new Error("receipt failed");
    })).rejects.toThrow("receipt failed");
    expect(await prisma.interaction.findUniqueOrThrow({ where: { id: created.id } })).toMatchObject({
      propertyId: own.property.id, nextActionDate: at, notes: "Original booking",
    });
    expect((await prisma.property.findUniqueOrThrow({ where: { id: own.property.id } })).viewsCount).toBe(1);
    expect((await prisma.property.findUniqueOrThrow({ where: { id: other.property.id } })).viewsCount).toBe(0);
  });
  it("a late staff reschedule preserves the overdue summary instead of erasing its history", async () => {
    const { client, property } = await fixture(); const created = await book(client.id, property.id);
    const summary = await prisma.pendingSummary.create({ data: { kind: "meeting", subjectId: created.id, subjectName: "Late showing",
      agentId, dueAt: at, snoozedUntil: at, snoozeCount: 3, dismissedAt: now } });
    await prisma.$transaction((tx) => rescheduleShowingTx(tx, { clientId: client.id, interactionId: created.id, at: later,
      now: new Date(at.getTime() + 1000), actorKind: "agent", meetingSummaryAfterShowingMinutes: 30, notes: (row) => `${row.notes}\nLate move` }));
    expect(await prisma.pendingSummary.findUniqueOrThrow({ where: { id: summary.id } })).toMatchObject({
      dueAt: at, snoozedUntil: at, snoozeCount: 3, dismissedAt: now, doneAt: null,
    });
  });
  it("rolls back cancellation and its follow-up together; committed cancellation retains history without completed KPI", async () => {
    const { client, property } = await fixture(); const created = await book(client.id, property.id);
    const input = { clientId: client.id, interactionId: created.id, now, actorKind: "agent" as const,
      notes: (row: { notes: string }) => `${row.notes}\nCancelled`, followUp: { actor: { kind: "agent" as const, agentId }, notes: "Agree another date" } };
    await expect(prisma.$transaction(async (tx) => { await cancelShowingTx(tx, input); throw new Error("receipt failed"); })).rejects.toThrow("receipt failed");
    expect(await prisma.interaction.count({ where: { clientId: client.id } })).toBe(1);
    expect(await prisma.interaction.findUniqueOrThrow({ where: { id: created.id } })).toMatchObject({ nextAction: "Показ объекта", declinedAt: null });
    await prisma.$transaction((tx) => cancelShowingTx(tx, input));
    expect(await prisma.interaction.findUniqueOrThrow({ where: { id: created.id } })).toMatchObject({
      nextAction: null, nextActionDate: at, declinedAt: now, completedAt: null, notes: "Original booking\nCancelled",
    });
    expect(await prisma.interaction.count({ where: { clientId: client.id, type: "SYSTEM", nextAction: "Согласовать новую дату показа" } })).toBe(1);
  });
});
