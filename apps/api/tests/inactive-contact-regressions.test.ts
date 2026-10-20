import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { prisma } from "../src/db.js";
import { runSilentClientAutoDeactivate } from "../src/lib/silentClientAutoDeactivate.js";
import { checkNoAnswerStreakForTrafficLight } from "../src/lib/noAnswerTrafficLight.js";
import { deactivateClient, hasNewerContactSince, reactivateClient } from "../src/lib/clientWorkStatus.js";
import { classifyInactiveLevelByDepth, lastRealContactAt, runInactiveTrafficLightTick } from "../src/lib/inactiveTrafficLight.js";
import { collectFacts } from "../src/lib/clientAutoStatus.js";
import { decideStatus } from "../src/lib/clientAutoStatus.js";
import { computeHiddenReason, presentClient } from "../src/routes/clients/shared.js";
import { runDeferredClientsReturnTick } from "../src/lib/deferredClients.js";
import { runLostInactiveTrashSweep } from "../src/lib/lostInactiveTrashSweep.js";

const NOW = new Date("2026-10-20T07:00:00Z");
const DAY = 86_400_000;
const OLD = new Date(NOW.getTime() - 30 * DAY);
const RECENT = new Date(NOW.getTime() - DAY);
const runId = `inactive-contact-${Date.now()}`;
let agentId: string;
const ids: string[] = [];

beforeAll(async () => {
  agentId = (await prisma.agent.create({ data: {
    fullName: runId, phone: `test-${runId}`, passwordHash: "test-only", role: "ADMIN",
  } })).id;
});
afterAll(async () => {
  await prisma.contactProfile.deleteMany({ where: { clientId: { in: ids } } });
  await prisma.botConversation.deleteMany({ where: { clientId: { in: ids } } });
  await prisma.notification.deleteMany({ where: { agentId } });
  await prisma.royalScoreEvent.deleteMany({ where: { agentId } });
  await prisma.interaction.deleteMany({ where: { clientId: { in: ids } } });
  await prisma.client.deleteMany({ where: { id: { in: ids } } });
  await prisma.agent.delete({ where: { id: agentId } });
  await prisma.$disconnect();
});

async function client() {
  const row = await prisma.client.create({ data: {
    fullName: runId, phone: `test-${runId}-${ids.length}`, source: "INSTAGRAM",
    kind: "BUYER", assignedAgentId: agentId, acceptedAt: OLD,
    status: "CONTACTED", workStatus: "ACTIVE", lastClientMessageAt: OLD,
  } });
  ids.push(row.id);
  await prisma.botConversation.create({ data: {
    channel: "INSTAGRAM", subscriberId: `${runId}-${ids.length}`, clientId: row.id,
    messages: [{ role: "assistant", content: "Актуально?", at: OLD.toISOString() }], lastMessageAt: OLD,
  } });
  return row;
}
async function call(clientId: string, data: Record<string, unknown> = {}) {
  return prisma.interaction.create({ data: {
    clientId, agentId, type: "CALL", notes: "test contact", createdAt: RECENT, ...data,
  } });
}
async function streak(clientId: string) {
  for (let n = 3; n > 0; n--) await call(clientId, {
    callAttempt: "NO_ANSWER", outcome: "NO_ANSWER", createdAt: new Date(RECENT.getTime() - n * 3600_000),
  });
}
async function state(id: string) { return prisma.client.findUniqueOrThrow({ where: { id } }); }
async function deactivate(clientId: string) {
  return deactivateClient({ clientId, actor: { kind: "system", source: "test" },
    reason: "THINKING", initiator: "CLIENT", actualNeeds: "test pause" });
}

describe("all contact channels protect the inactive lifecycle", () => {
  it.each([
    { callAttempt: "TALKED" },
    { recordingDurationSec: 12 },
    { outsideCrm: true, outcome: "POSITIVE" },
  ])("night sweep preserves an answered call without an AI outcome: %j", async (data) => {
    const c = await client(); await call(c.id, data);
    await runSilentClientAutoDeactivate(NOW);
    expect((await state(c.id)).workStatus).toBe("ACTIVE");
  });
  it("night sweep sees incoming messages even when the dialog snapshot is old", async () => {
    const c = await client();
    await prisma.client.update({ where: { id: c.id }, data: { lastClientMessageAt: RECENT } });
    await runSilentClientAutoDeactivate(NOW);
    expect((await state(c.id)).workStatus).toBe("ACTIVE");
  });
  it.each(["manual", "meeting"])("no-answer worker sees a newer %s contact", async (kind) => {
    const c = await client(); await streak(c.id);
    if (kind === "manual") await call(c.id, { outsideCrm: true, outcome: "POSITIVE" });
    else await prisma.interaction.create({ data: {
      clientId: c.id, agentId, type: "SHOWING", notes: "test held showing",
      createdAt: OLD, completedAt: RECENT, nextActionDate: RECENT,
    } });
    await checkNoAnswerStreakForTrafficLight(c.id, NOW);
    expect((await state(c.id)).workStatus).toBe("ACTIVE");
  });
  it.each(["LOST", "ARCHIVED", "DEAL_CLOSED"] as const)("central deactivation rejects %s", async (status) => {
    const c = await client(); await prisma.client.update({ where: { id: c.id }, data: { status } });
    expect((await deactivate(c.id)).ok).toBe(false);
    expect((await state(c.id)).workStatus).toBe("ACTIVE");
  });
  it("repeated deactivation preserves the original traffic clock", async () => {
    const c = await client();
    await prisma.client.update({ where: { id: c.id }, data: {
      workStatus: "INACTIVE", inactiveSince: OLD, inactiveLevel: "YELLOW", inactivePingCount: 2,
    } });
    await deactivate(c.id);
    expect((await state(c.id)).inactiveSince).toEqual(OLD);
    expect((await state(c.id)).inactivePingCount).toBe(2);
  });
  it.each(["TALKED", "message", "meeting"])("stale AI decision sees a newer %s", async (kind) => {
    const c = await client();
    if (kind === "TALKED") await call(c.id, { callAttempt: "TALKED" });
    if (kind === "message") await prisma.client.update({ where: { id: c.id }, data: { lastClientMessageAt: RECENT } });
    if (kind === "meeting") await prisma.interaction.create({ data: {
      clientId: c.id, agentId, type: "SHOWING", notes: "test", createdAt: OLD,
      nextActionDate: RECENT, completedAt: RECENT,
    } });
    expect(await hasNewerContactSince(c.id, OLD)).toBe(true);
  });
  it("legacy call recording resets the traffic clock", async () => {
    const c = await client(); await call(c.id, { recordingDurationSec: 12 });
    expect((await lastRealContactAt([{ id: c.id, inactiveSince: OLD }])).get(c.id)).toEqual(RECENT);
  });
  it("the very call that caused a pause does not reset its clock", async () => {
    const c = await client(); await call(c.id, { callAttempt: "TALKED", createdAt: OLD });
    expect((await lastRealContactAt([{ id: c.id, inactiveSince: OLD }])).has(c.id)).toBe(false);
  });
  it("manual answered calls produce yellow depth", async () => {
    const c = await client();
    await prisma.client.update({ where: { id: c.id }, data: { lastClientMessageAt: null } });
    await call(c.id, { outsideCrm: true, outcome: "POSITIVE" });
    expect(await classifyInactiveLevelByDepth(c.id, "BUYER", 30)).toBe("YELLOW");
  });
  it.each(["ARCHIVED", "DEAL_CLOSED"] as const)("traffic light never turns %s into LOST", async (status) => {
    const c = await client();
    await prisma.client.update({ where: { id: c.id }, data: {
      status, workStatus: "INACTIVE", inactiveLevel: "RED", inactiveSince: OLD, inactivePingCount: 2,
    } });
    await runInactiveTrafficLightTick(NOW);
    expect((await state(c.id)).status).toBe(status);
  });
  it("status facts see answered station calls and current incoming messages", async () => {
    const c = await client(); await call(c.id, { callAttempt: "TALKED" });
    await prisma.client.update({ where: { id: c.id }, data: { lastClientMessageAt: NOW } });
    const facts = await collectFacts(c.id);
    expect(facts.talked).toBe(true);
    expect(facts.lastClientActivityAt).toEqual(NOW);
    expect(facts.lastEventAt).toEqual(NOW);
  });
  it("a newer client reply breaks an unanswered telephone streak in status facts", async () => {
    const c = await client(); await streak(c.id);
    await prisma.client.update({ where: { id: c.id }, data: { lastClientMessageAt: NOW } });
    expect((await collectFacts(c.id)).noAnswerStreak).toBe(0);
  });
  it("an automatically closed future showing is not a held meeting or hot signal", async () => {
    const c = await client();
    await prisma.interaction.create({ data: {
      clientId: c.id, agentId, type: "SHOWING", notes: "test cancelled task", createdAt: OLD,
      nextActionDate: NOW, completedAt: RECENT,
    } });
    expect((await collectFacts(c.id)).showing).toBe(false);
  });
  it("an archived status is not silently reopened by the temperature engine", () => {
    expect(decideStatus({ id: "test", status: "ARCHIVED", createdAt: OLD, acceptedAt: OLD,
      statusSetManuallyAt: null, hotSince: null }, {
      talked: true, clientReplied: true, showing: true, activeDeal: false, dealClosed: false,
      noAnswerStreak: 0, lastEventAt: NOW, lastClientActivityAt: NOW,
    }, NOW)).toBeNull();
  });
  it("a closed deferred client does not return to active work on a timer", async () => {
    const c = await client();
    await prisma.client.update({ where: { id: c.id }, data: {
      workStatus: "DEFERRED", status: "LOST", deferredUntil: OLD,
    } });
    await runDeferredClientsReturnTick(NOW);
    expect((await state(c.id)).workStatus).toBe("DEFERRED");
  });
  it.each(["LOST", "DEAL_CLOSED", "ARCHIVED"])("%s never claims to await acceptance or reveals its email", (status) => {
    const c = presentClient({ phone: "test-phone", email: "test@example.test", acceptedAt: null,
      kind: "BUYER" as const, workStatus: "INACTIVE", status }, false);
    expect(c.pendingAcceptance).toBe(false);
    expect(c.email).toBeNull();
  });
  it("a completed security review no longer claims that the client is under review", () => {
    expect(computeHiddenReason({ deletedAt: null, kind: "BUYER", status: "CONTACTED", workStatus: "ACTIVE",
      acceptedAt: OLD, securityReview: "CLEARED" })).toBeNull();
  });
  it("missing traffic fields start a complete, safe cycle", async () => {
    const c = await client();
    await prisma.client.update({ where: { id: c.id }, data: { workStatus: "INACTIVE", inactivePingCount: 99 } });
    await runInactiveTrafficLightTick(NOW);
    const after = await state(c.id);
    expect(after.status).not.toBe("LOST");
    expect(after.inactiveLevel).toBe("YELLOW");
    expect(after.inactiveSince).toEqual(NOW);
    expect(after.inactivePingCount).toBe(0);
  });
  it("manual return clears cooldown and blocks a delayed decision from the previous cycle", async () => {
    const c = await client();
    await prisma.client.update({ where: { id: c.id }, data: {
      workStatus: "INACTIVE", inactiveSince: OLD, inactiveLevel: "RED", inactiveEnteredAt: OLD,
    } });
    expect((await reactivateClient({ clientId: c.id, agentId })).ok).toBe(true);
    const after = await state(c.id);
    expect(after.inactiveEnteredAt).toBeNull();
    expect(after.inactiveLevel).toBeNull();
    expect(await hasNewerContactSince(c.id, OLD)).toBe(true);
  });
  it("retention never trashes a client with recent real contact", async () => {
    const c = await client();
    const ancient = new Date(NOW.getTime() - 180 * DAY);
    await prisma.client.update({ where: { id: c.id }, data: {
      workStatus: "INACTIVE", inactiveLevel: "RED", inactiveSince: ancient, lastClientMessageAt: ancient,
    } });
    await call(c.id, { callAttempt: "TALKED" });
    await runLostInactiveTrashSweep(NOW);
    expect((await state(c.id)).deletedAt).toBeNull();
  });
  it("concurrent ticks advance the same traffic snapshot once", async () => {
    const c = await client();
    const settings = await prisma.settings.findUniqueOrThrow({ where: { id: "singleton" } });
    const since = new Date(NOW.getTime() - settings.inactiveRedPingHours * 0.75 * 1.2 * 3600_000);
    await prisma.client.update({ where: { id: c.id }, data: {
      workStatus: "INACTIVE", inactiveSince: since, inactiveLevel: "RED", inactivePingCount: 0,
    } });
    await Promise.all([runInactiveTrafficLightTick(NOW), runInactiveTrafficLightTick(NOW)]);
    expect((await state(c.id)).inactivePingCount).toBe(1);
  });
  it("traffic checks reach clients past the first 500 non-due rows", async () => {
    const prefix = `${runId}-page-`;
    const rows = Array.from({ length: 501 }, (_, n) => ({
      id: `${prefix}${String(n).padStart(4, "0")}`, fullName: "test pagination", phone: `test-${prefix}${n}`,
      source: "INSTAGRAM" as const, kind: "BUYER" as const, assignedAgentId: agentId,
      status: "CONTACTED" as const, workStatus: "INACTIVE" as const, inactiveLevel: "RED" as const,
      inactiveSince: n === 500 ? OLD : NOW, inactivePingCount: n === 500 ? 2 : 0,
    }));
    ids.push(...rows.map((row) => row.id));
    await prisma.client.createMany({ data: rows });
    const result = await runInactiveTrafficLightTick(NOW);
    const after = await state(rows[500].id);
    expect(after.status, JSON.stringify({ result, count: after.inactivePingCount, since: after.inactiveSince })).toBe("LOST");
  });
  it("the silent sweep reaches clients after 500 dialogs whose last word is the client's", async () => {
    const prefix = `${runId}-silent-page-`;
    const rows = Array.from({ length: 501 }, (_, n) => ({
      id: `${prefix}${String(n).padStart(4, "0")}`, fullName: "test silent pagination", phone: `test-${prefix}${n}`,
      source: "INSTAGRAM" as const, kind: "BUYER" as const, assignedAgentId: agentId,
      status: "CONTACTED" as const, workStatus: "ACTIVE" as const, lastClientMessageAt: OLD,
    }));
    ids.push(...rows.map((row) => row.id));
    await prisma.client.createMany({ data: rows });
    await prisma.botConversation.createMany({ data: rows.map((row, n) => ({
      channel: "INSTAGRAM" as const, subscriberId: row.id, clientId: row.id, lastMessageAt: OLD,
      messages: [{ role: n === 500 ? "assistant" : "user", content: "test", at: OLD.toISOString() }],
    })) });
    await runSilentClientAutoDeactivate(NOW);
    const after = await state(rows[500].id);
    expect(after.workStatus).toBe("INACTIVE");
    expect(after.inactiveSince).toEqual(NOW);
    expect((await state(rows[0].id)).workStatus).toBe("ACTIVE");
  });
});
