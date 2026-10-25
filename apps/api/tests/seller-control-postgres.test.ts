import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import bcrypt from "bcrypt";
import request from "supertest";
import { app } from "../src/app.js";
import { invalidateAgentAccess } from "../src/auth/middleware.js";
import { deleteAgentsWithTraces } from "./helpers/cleanupAgents.js";
import { prisma } from "../src/db.js";
import { commandSellerControl, runSellerControlTick, startSellerControl, enrollDueBuyerCandidates, enrollDueSellerIntakes } from "../src/lib/sellerControlEpisodes.js";
import { bindSellerIntakeControl } from "../src/lib/sellerIntakeReschedule.js";
import { previewWorkflowAgentCounts } from "../src/lib/workflowAgentPreview.js";

const clientIds: string[] = [];
const agentIds: string[] = [];
let agentId: string, ropId: string, districtId: string;
let savedConfig: unknown;
const password = "seller-control-isolated-password";
beforeAll(async () => {
  const settings = await prisma.settings.findUniqueOrThrow({ where: { id: "singleton" } });
  savedConfig = settings.sellerControlConfig;
  await prisma.settings.update({ where: { id: "singleton" }, data: { sellerControlConfig: {
    agentDueWorkingDays: 1, ropReceiptDueWorkingDays: 1, ropActionDueWorkingDays: 1,
  } } });
  const passwordHash = await bcrypt.hash(password, 4);
  for (const role of ["AGENT", "DIRECTOR", "ADMIN"] as const) {
    const agent = await prisma.agent.create({ data: { fullName: `Seller control ${role}`, phone: `seller-control-${randomUUID()}`,
      role, passwordHash, ...(role === "ADMIN" ? { permissions: { granted: [], revoked: ["clients.securityReview"] } } : {}) } });
    agentIds.push(agent.id);
  }
  [agentId, ropId] = agentIds;
  districtId = (await prisma.district.create({ data: { name: `Seller control ${randomUUID()}` } })).id;
});
afterAll(async () => {
  vi.unstubAllEnvs();
  const episodes = await prisma.sellerControlEpisode.findMany({ where: { clientId: { in: clientIds } }, select: { id: true } });
  await prisma.notification.deleteMany({ where: { tag: { in: episodes.map(row => `investigation-seller-control-${row.id}`) } } });
  await prisma.sellerControlEpisode.deleteMany({ where: { clientId: { in: clientIds } } });
  await prisma.buyerShowingCandidate.deleteMany({ where: { clientId: { in: clientIds } } });
  await prisma.sellerIntakeAppointmentEvidence.deleteMany({ where: { clientId: { in: clientIds } } });
  await prisma.deal.deleteMany({ where: { clientId: { in: clientIds } } });
  await prisma.interaction.deleteMany({ where: { clientId: { in: clientIds } } });
  await prisma.property.deleteMany({ where: { sellerClientId: { in: clientIds } } });
  await prisma.auditLog.deleteMany({ where: { entityType: "Client", entityId: { in: clientIds } } });
  await prisma.client.deleteMany({ where: { id: { in: clientIds } } });
  await prisma.district.delete({ where: { id: districtId } });
  await deleteAgentsWithTraces(agentIds);
  await prisma.settings.update({ where: { id: "singleton" }, data: { sellerControlConfig: savedConfig as object } });
  await prisma.$disconnect();
});
async function fixture(dual = false) {
  const at = new Date();
  const client = await prisma.client.create({ data: { fullName: "Isolated seller control", phone: `seller-${randomUUID()}`,
    source: "PHONE_CALL", kind: dual ? "BUYER" : "SELLER", dualIntent: dual, dualIntentConfirmedAt: dual ? at : null,
    assignedAgentId: agentId, assignedAt: at, acceptedAt: at, sellerDeclaredPropertyCount: 3, sellerDeclaredPropertyCountAt: at } });
  clientIds.push(client.id);
  const property = await prisma.property.create({ data: { title: "Isolated property", type: "APARTMENT", areaSqm: 50, price: 100,
    currency: "TJS", districtId, address: "Fixture", condition: "GOOD", status: "AVAILABLE", sellerClientId: client.id,
    assignedAgentId: agentId, intakeAgentId: agentId } });
  return { client, property, at };
}

describe("seller control real transactions", () => {
  it("frozen agent and absent ROP pause only supplemental deadlines; return grants a fresh SLA without instant escalation", async () => {
    vi.stubEnv("SELLER_CONTROL_INTERNAL_LIVE", "explicitly-approved");
    const { client, at } = await fixture();
    const initial = await startSellerControl({ clientId: client.id, ropAgentId: ropId, actorId: ropId, requestKey: randomUUID(), live: true }, at);
    const pauseAt = new Date(initial.agentDueAt!.getTime() + 1000);
    try {
      await prisma.agent.update({ where: { id: agentId }, data: { frozenAt: at } });
      const another = await fixture();
      await expect(startSellerControl({ clientId: another.client.id, ropAgentId: ropId, actorId: ropId, requestKey: randomUUID(), live: true }, pauseAt)).rejects.toThrow("недоступен");
      const paused = await commandSellerControl(initial.id, { action: "TICK", revision: 1, requestKey: randomUUID() }, null, {}, pauseAt);
      expect(paused.event).toBe("CONTROL_PAUSED"); expect(paused.episode.status).toBe("AGENT_TASK");
      const oldTask = await prisma.interaction.findUniqueOrThrow({ where: { id: initial.agentTaskId! } });
      expect(oldTask.nextActionDate).toEqual(initial.agentDueAt); expect(oldTask.taskCancelledAt).toEqual(pauseAt); expect(oldTask.completedAt).toBeNull();
      expect(paused.episode.ropTaskId).toBeNull();
      await prisma.agent.update({ where: { id: agentId }, data: { frozenAt: null } });
      const resumeAt = new Date(pauseAt.getTime() + 5 * 86400_000);
      const resumed = await commandSellerControl(initial.id, { action: "TICK", revision: paused.episode.revision, requestKey: randomUUID() }, null, {}, resumeAt);
      expect(resumed.event).toBe("CONTROL_RESUMED"); expect(resumed.episode.agentDueAt!.getTime()).toBeGreaterThan(resumeAt.getTime());
      expect(resumed.episode.agentTaskId).not.toBe(initial.agentTaskId);
      const newTask = await prisma.interaction.findUniqueOrThrow({ where: { id: resumed.episode.agentTaskId! } });
      expect(newTask.nextActionDate!.getTime()).toBeGreaterThan(resumeAt.getTime()); expect(newTask.taskCancelledAt).toBeNull();
      expect((await prisma.interaction.findUniqueOrThrow({ where: { id: initial.agentTaskId! } })).taskCancelledAt).toEqual(pauseAt);
      expect(resumed.episode.status).toBe("AGENT_TASK"); expect(resumed.episode.ropTaskId).toBeNull();
      const transferAt = new Date(resumed.episode.agentDueAt!.getTime() + 1000);
      await prisma.agent.update({ where: { id: ropId }, data: { absenceUntil: new Date(transferAt.getTime() + 7 * 86400_000) } });
      const held = await commandSellerControl(initial.id, { action: "TICK", revision: resumed.episode.revision, requestKey: randomUUID() }, null, {}, transferAt);
      expect(held.event).toBe("ROP_TEMPORARILY_UNAVAILABLE"); expect(held.episode.agentDueAt).toEqual(resumed.episode.agentDueAt);
      expect((await prisma.interaction.findUniqueOrThrow({ where: { id: newTask.id } })).taskCancelledAt).toBeNull();
      await prisma.agent.update({ where: { id: ropId }, data: { absenceUntil: null } });
      const transfer = await commandSellerControl(initial.id, { action: "TICK", revision: resumed.episode.revision, requestKey: randomUUID() }, null, {}, transferAt);
      expect(transfer.episode.status).toBe("ROP_RECEIPT");
      const ropPauseAt = new Date(transfer.episode.ropReceiptDueAt!.getTime() + 1000);
      await prisma.agent.update({ where: { id: ropId }, data: { absenceUntil: new Date(ropPauseAt.getTime() + 7 * 86400_000) } });
      const ropPaused = await commandSellerControl(initial.id, { action: "TICK", revision: transfer.episode.revision, requestKey: randomUUID() }, null, {}, ropPauseAt);
      expect(ropPaused.event).toBe("CONTROL_PAUSED"); expect(ropPaused.episode.status).toBe("ROP_RECEIPT");
      expect((await prisma.interaction.findUniqueOrThrow({ where: { id: newTask.id } })).taskCancelledAt).toBeNull();
      expect(await prisma.notification.count({ where: { tag: `investigation-seller-control-${initial.id}` } })).toBe(0);
      await prisma.agent.update({ where: { id: ropId }, data: { absenceUntil: null } });
      const ropResumed = await commandSellerControl(initial.id, { action: "TICK", revision: ropPaused.episode.revision, requestKey: randomUUID() }, null, {}, new Date(ropPauseAt.getTime() + 1000));
      expect(ropResumed.episode.ropReceiptDueAt!.getTime()).toBeGreaterThan(ropPauseAt.getTime() + 1000);
      expect(ropResumed.episode.status).toBe("ROP_RECEIPT");
    } finally {
      await prisma.agent.update({ where: { id: agentId }, data: { frozenAt: null } });
      await prisma.agent.update({ where: { id: ropId }, data: { absenceUntil: null } });
    }
  });
  it("future intake automatic control enrolls once; PREVIEW, not-due and deferred stay untouched; genuine reschedule replaces only supplemental work", async () => {
    const from = new Date();
    vi.stubEnv("SELLER_CONTROL_INTERNAL_LIVE", "explicitly-approved"); vi.stubEnv("SELLER_CONTROL_LIVE_FROM", from.toISOString());
    await prisma.settings.update({ where: { id: "singleton" }, data: { sellerControlConfig: {
      agentDueWorkingDays: 1, ropReceiptDueWorkingDays: 1, ropActionDueWorkingDays: 1, defaultRopAgentId: ropId,
    } } });
    const base = await fixture(); const tick = new Date(base.at.getTime() + 10 * 86400_000);
    const createSource = (client: typeof base.client, sourceOccurredAt: Date, proposedAt: Date, executionMode = "LIVE") => prisma.sellerIntakeAppointmentEvidence.create({ data: {
      sourceKey: randomUUID(), sourceInteractionId: randomUUID(), clientId: client.id, agentId, assignmentAt: client.assignedAt,
      sourceOccurredAt, proposedAt, sourceExcerpt: "Synthetic recorded appointment fixture", executionMode,
    } });
    const firstSource = await createSource(base.client, base.at, base.at);
    const preview = await fixture(); await createSource(preview.client, preview.at, preview.at, "PREVIEW");
    const waiting = await fixture(); await createSource(waiting.client, waiting.at, new Date(tick.getTime() + 5 * 86400_000));
    const deferred = await fixture(); await prisma.client.update({ where: { id: deferred.client.id }, data: { workStatus: "DEFERRED" } });
    await createSource(deferred.client, deferred.at, deferred.at);
    expect((await enrollDueSellerIntakes(tick)).created).toBe(1);
    expect((await enrollDueSellerIntakes(tick)).created).toBe(0);
    const episode = await prisma.sellerControlEpisode.findUniqueOrThrow({ where: { sellerIntakeEvidenceId: firstSource.id } });
    expect(episode.agentDueAt!.getTime()).toBeGreaterThan(tick.getTime());
    expect(await prisma.interaction.count({ where: { clientId: { in: [preview.client.id, waiting.client.id, deferred.client.id] } } })).toBe(0);
    const repeated = await createSource(base.client, new Date(tick.getTime() + 1000), firstSource.proposedAt);
    await prisma.$transaction(async tx => { await tx.$queryRaw`SELECT id FROM "Client" WHERE id=${base.client.id} FOR UPDATE`; await bindSellerIntakeControl(tx, repeated, new Date(tick.getTime() + 1000)); });
    expect((await prisma.sellerControlEpisode.findUniqueOrThrow({ where: { id: episode.id } })).agentDueAt).toEqual(episode.agentDueAt);
    expect((await prisma.sellerIntakeAppointmentEvidence.findUniqueOrThrow({ where: { id: repeated.id } })).controlEpisodeId).toBe(episode.id);
    const replacementAt = new Date(tick.getTime() + 2000);
    const replacement = await createSource(base.client, replacementAt, new Date(tick.getTime() + 5 * 86400_000));
    await prisma.$transaction(async tx => { await tx.$queryRaw`SELECT id FROM "Client" WHERE id=${base.client.id} FOR UPDATE`; await bindSellerIntakeControl(tx, replacement, replacementAt); });
    expect((await prisma.sellerControlEpisode.findUniqueOrThrow({ where: { id: episode.id } })).status).toBe("CANCELLED");
    expect((await prisma.interaction.findUniqueOrThrow({ where: { id: episode.agentTaskId! } })).taskCancelledAt).not.toBeNull();
    expect((await enrollDueSellerIntakes(replacementAt)).created).toBe(0);
    expect(await prisma.interaction.count({ where: { clientId: base.client.id } })).toBe(1);
    const later = new Date(tick.getTime() + 10 * 86400_000);
    await enrollDueSellerIntakes(later);
    const replacementEpisode = await prisma.sellerControlEpisode.findUniqueOrThrow({ where: { sellerIntakeEvidenceId: replacement.id } });
    expect(replacementEpisode.id).not.toBe(episode.id); expect(replacementEpisode.status).toBe("AGENT_TASK");
    expect(await prisma.interaction.count({ where: { clientId: base.client.id, taskCancelledAt: null } })).toBe(1);
    vi.stubEnv("SELLER_CONTROL_LIVE_FROM", "");
  });
  it("does not create a supplemental task when the exact showing was booked before the confirmation source", async () => {
    vi.stubEnv("SELLER_CONTROL_INTERNAL_LIVE", "explicitly-approved"); vi.stubEnv("BUYER_CANDIDATE_INTERNAL_LIVE", "explicitly-approved");
    const { client, property, at } = await fixture();
    await prisma.client.update({where:{id:client.id},data:{kind:"BUYER"}});
    await prisma.settings.update({where:{id:"singleton"},data:{sellerControlConfig:{agentDueWorkingDays:1,ropReceiptDueWorkingDays:1,ropActionDueWorkingDays:1,buyerCandidateFollowupWorkingDays:1}}});
    const proposedAt = new Date(at.getTime()+86400000), now = new Date(at.getTime()+5000);
    await prisma.interaction.create({data:{clientId:client.id,agentId,type:"SHOWING",notes:"Existing booked showing before confirmation",propertyId:property.id,nextActionDate:proposedAt,createdAt:new Date(at.getTime()+500)}});
    const candidate=await prisma.buyerShowingCandidate.create({data:{sourceKey:randomUUID(),sourceType:"CALL",sourceId:randomUUID(),clientId:client.id,agentId,assignmentAt:client.assignedAt,propertyId:property.id,proposedAt,sourceOccurredAt:new Date(at.getTime()+1000),reviewDueAt:new Date(at.getTime()+2000),executionMode:"LIVE"}});
    await expect(startSellerControl({clientId:client.id,ropAgentId:ropId,actorId:ropId,requestKey:randomUUID(),live:true,buyerCandidateId:candidate.id,candidateRevision:candidate.revision},now)).rejects.toThrow();
    expect(await prisma.sellerControlEpisode.count({where:{clientId:client.id}})).toBe(0);
    expect(await prisma.interaction.count({where:{clientId:client.id,type:"SYSTEM"}})).toBe(0);
  });
  it.each(["unknown-property","unknown-date","not-due"])("%s cannot create a public task even with LIVE gates",async variant=>{
    vi.stubEnv("SELLER_CONTROL_INTERNAL_LIVE", "explicitly-approved");vi.stubEnv("BUYER_CANDIDATE_INTERNAL_LIVE", "explicitly-approved");
    const {client,property,at}=await fixture();
    await prisma.client.update({where:{id:client.id},data:{kind:"BUYER"}});
    await prisma.settings.update({where:{id:"singleton"},data:{sellerControlConfig:{agentDueWorkingDays:1,ropReceiptDueWorkingDays:1,ropActionDueWorkingDays:1,buyerCandidateFollowupWorkingDays:1}}});
    const candidate=await prisma.buyerShowingCandidate.create({data:{sourceKey:randomUUID(),sourceType:"CALL",sourceId:randomUUID(),clientId:client.id,agentId,assignmentAt:client.assignedAt,propertyId:variant==="unknown-property"?null:property.id,proposedAt:variant==="unknown-date"?null:new Date(at.getTime()+86400000),sourceOccurredAt:at,reviewDueAt:variant==="not-due"?new Date(at.getTime()+86400000):at,executionMode:"LIVE"}});
    await expect(startSellerControl({clientId:client.id,ropAgentId:ropId,actorId:ropId,requestKey:randomUUID(),live:true,buyerCandidateId:candidate.id,candidateRevision:candidate.revision},at)).rejects.toThrow();
    expect(await prisma.interaction.count({where:{clientId:client.id}})).toBe(0);
    expect(await prisma.sellerControlEpisode.count({where:{clientId:client.id}})).toBe(0);
  });
  it("automatically enrolls only due future LIVE candidates once, with a configured ROP and system actor", async () => {
    vi.stubEnv("SELLER_CONTROL_INTERNAL_LIVE", "explicitly-approved"); vi.stubEnv("BUYER_CANDIDATE_INTERNAL_LIVE", "explicitly-approved");
    const { client, property, at } = await fixture();
    await prisma.client.update({ where: { id: client.id }, data: { kind: "BUYER" } });
    vi.stubEnv("BUYER_CANDIDATE_LIVE_FROM", at.toISOString());
    const config = { agentDueWorkingDays: 1, ropReceiptDueWorkingDays: 1, ropActionDueWorkingDays: 1, buyerCandidateFollowupWorkingDays: 1 };
    await prisma.settings.update({ where: { id: "singleton" }, data: { sellerControlConfig: config } });
    for (const [executionMode, offset] of [["LIVE", 0], ["PREVIEW", 0], ["LIVE", -1]] as const) {
      await prisma.buyerShowingCandidate.create({ data: { sourceKey: randomUUID(), sourceType: "CALL", sourceId: randomUUID(),
        clientId: client.id, agentId, assignmentAt: client.assignedAt, propertyId: property.id, executionMode,
        sourceOccurredAt: new Date(at.getTime() + offset), reviewDueAt: at, proposedAt: new Date(at.getTime() + 86400_000) } });
    }
    expect(await enrollDueBuyerCandidates(at)).toEqual({ state: "NOT_CONFIGURED", created: 0 });
    expect(await prisma.interaction.count({ where: { clientId: client.id } })).toBe(0);
    await prisma.settings.update({ where: { id: "singleton" }, data: { sellerControlConfig: { ...config, defaultRopAgentId: ropId } } });
    const delayedTick = new Date(at.getTime() + 20 * 86400_000);
    expect((await enrollDueBuyerCandidates(delayedTick)).created).toBe(1);
    expect((await enrollDueBuyerCandidates(delayedTick)).created).toBe(0);
    const episodes = await prisma.sellerControlEpisode.findMany({ where: { clientId: client.id }, include: { events: true } });
    expect(episodes).toHaveLength(1); expect(episodes[0].events[0].actorId).toBeNull();
    expect(episodes[0].agentDueAt!.getTime()).toBeGreaterThan(delayedTick.getTime());
    const sameTick = await commandSellerControl(episodes[0].id, { action: "TICK", revision: 1, requestKey: randomUUID() }, null, {}, delayedTick);
    expect(sameTick.episode.status).toBe("AGENT_TASK");
    expect(sameTick.episode.ropTaskId).toBeNull();
    const tasks = await prisma.interaction.findMany({ where: { clientId: client.id } });
    expect(tasks).toHaveLength(1); expect(tasks[0].notes).toBe("Уточнить и записать договорённость о показе");
    vi.stubEnv("BUYER_CANDIDATE_INTERNAL_LIVE", "");
  });
  it("buyer candidate tasks need future persisted LIVE plus both gates; confirmed booking closes only its supplemental tasks", async () => {
    vi.stubEnv("SELLER_CONTROL_INTERNAL_LIVE", "explicitly-approved"); vi.stubEnv("BUYER_CANDIDATE_INTERNAL_LIVE", "");
    const { client, property, at } = await fixture();
    vi.stubEnv("BUYER_CANDIDATE_LIVE_FROM", at.toISOString());
    await prisma.client.update({ where: { id: client.id }, data: { kind: "BUYER" } });
    await prisma.settings.update({ where: { id: "singleton" }, data: { sellerControlConfig: {
      agentDueWorkingDays: 1, ropReceiptDueWorkingDays: 1, ropActionDueWorkingDays: 1, buyerCandidateFollowupWorkingDays: 1,
    } } });
    const candidate = await prisma.buyerShowingCandidate.create({ data: { sourceKey: randomUUID(), sourceType: "CALL", sourceId: randomUUID(),
      clientId: client.id, agentId, assignmentAt: client.assignedAt, proposedAt: new Date(at.getTime() + 86400_000), propertyId: property.id,
      sourceOccurredAt: at, reviewDueAt: at, executionMode: "PREVIEW" } });
    const start = { clientId: client.id, ropAgentId: ropId, actorId: ropId, requestKey: randomUUID(), live: true, buyerCandidateId: candidate.id, candidateRevision: 1 };
    await expect(startSellerControl(start, at)).rejects.toThrow();
    vi.stubEnv("BUYER_CANDIDATE_INTERNAL_LIVE", "explicitly-approved");
    await expect(startSellerControl(start, at)).rejects.toThrow();
    expect(await prisma.interaction.count({ where: { clientId: client.id } })).toBe(0);
    // A separately collected future LIVE row, never promotion of the PREVIEW row.
    const live = await prisma.buyerShowingCandidate.create({ data: { sourceKey: randomUUID(), sourceType: "CALL", sourceId: randomUUID(),
      clientId: client.id, agentId, assignmentAt: client.assignedAt, proposedAt: candidate.proposedAt, propertyId: property.id,
      sourceOccurredAt: at, reviewDueAt: at, executionMode: "LIVE" } });
    const started = await startSellerControl({ ...start, buyerCandidateId: live.id }, at);
    expect((await startSellerControl({ ...start, buyerCandidateId: live.id }, at)).id).toBe(started.id);
    const task = await prisma.interaction.findUniqueOrThrow({ where: { id: started.agentTaskId! } });
    expect(task.notes).toBe("Уточнить и записать договорённость о показе"); expect(task.investigationOnly).toBe(false);
    const showing = await prisma.interaction.create({ data: { clientId: client.id, agentId, subjectAgentId: agentId, type: "SHOWING", notes: "Isolated actual booking",
      propertyId: property.id, nextActionDate: candidate.proposedAt, showingEvidenceVersion: 1 } });
    const closed = await commandSellerControl(started.id, { action: "TICK", revision: 1, requestKey: randomUUID() }, null, {}, new Date(Date.now() + 1000));
    expect(closed.episode.status).toBe("RESOLVED");
    expect((await prisma.interaction.findUniqueOrThrow({ where: { id: task.id } })).taskCancelledAt).not.toBeNull();
    expect((await prisma.interaction.findUniqueOrThrow({ where: { id: showing.id } })).taskCancelledAt).toBeNull();
    expect((await prisma.buyerShowingCandidate.findUniqueOrThrow({ where: { id: candidate.id } })).executionMode).toBe("PREVIEW");
    expect((await previewWorkflowAgentCounts()).coverage).toBe("UNKNOWN");
  });
  it("returned same owner/date creates a distinct episode and old control cancels without escalation", async () => {
    const { client, at } = await fixture();
    const first = await startSellerControl({ clientId: client.id, ropAgentId: ropId, actorId: ropId, requestKey: randomUUID() }, at);
    const bAt = new Date(first.createdAt.getTime() + 1000), aAt = new Date(bAt.getTime() + 1000), now = new Date(aAt.getTime() + 1000);
    await prisma.auditLog.createMany({ data: [
      { action: "CLIENT_AGENT_CHANGE", agentName: "Isolated epoch fixture", entityType: "Client", entityId: client.id, createdAt: bAt, meta: { fromAgentId: agentId, toAgentId: ropId } },
      { action: "CLIENT_AGENT_CHANGE", agentName: "Isolated epoch fixture", entityType: "Client", entityId: client.id, createdAt: aAt, meta: { fromAgentId: ropId, toAgentId: agentId } },
    ] });
    const second = await startSellerControl({ clientId: client.id, ropAgentId: ropId, actorId: ropId, requestKey: randomUUID() }, now);
    expect(second.id).not.toBe(first.id);
    const closed = await commandSellerControl(first.id, { action: "TICK", revision: 1, requestKey: randomUUID() }, ropId, { simulated: true }, now);
    expect(closed.episode.status).toBe("CANCELLED");
    expect(closed.event).toBe("SIMULATED_ASSIGNMENT_ENDED");
    expect(await prisma.interaction.count({ where: { clientId: client.id } })).toBe(0);
  });
  it("director transition records one private inbox receipt; demoted recipient cannot list/count/read it and director stage still closes", async () => {
    vi.stubEnv("SELLER_CONTROL_INTERNAL_LIVE", "explicitly-approved");
    const { client, at } = await fixture();
    const episode = await startSellerControl({ clientId: client.id, ropAgentId: ropId, actorId: ropId, requestKey: randomUUID(), live: true }, at);
    const later = new Date(at.getTime() + 10 * 86_400_000), deadline = new Date(at.getTime() + 20 * 86_400_000);
    await commandSellerControl(episode.id, { requestKey: randomUUID(), revision: 1, action: "TICK" }, null, {}, later);
    const command = { requestKey: randomUUID(), revision: 2, action: "TICK" as const };
    await commandSellerControl(episode.id, command, null, {}, deadline);
    const tag = `investigation-seller-control-${episode.id}`;
    const notices = await prisma.notification.findMany({ where: { tag } });
    const notice = notices.find(row => row.agentId === ropId)!;
    expect(notice).toBeDefined(); expect(notices.some(row => row.agentId === agentId || row.agentId === agentIds[2])).toBe(false);
    const event = await prisma.sellerControlEvent.findUniqueOrThrow({ where: { requestKey: command.requestKey } });
    expect(event.payload).toMatchObject({ directorNotices: expect.arrayContaining([{ agentId: ropId, notificationId: notice.id }]) });
    await prisma.notification.update({ where: { id: notice.id }, data: { read: true } });
    await commandSellerControl(episode.id, command, null, {}, deadline);
    expect(await prisma.notification.count({ where: { tag } })).toBe(notices.length);
    expect(await prisma.notification.findUniqueOrThrow({ where: { id: notice.id } })).toMatchObject({ read: true, count: 1, createdAt: notice.createdAt });
    expect(await prisma.investigationCase.count({ where: { clientId: client.id } })).toBe(0);
    await prisma.notification.update({ where: { id: notice.id }, data: { read: false } });
    // A stored recipient ID cannot preserve access after role demotion, even with raw grants.
    const rop = await prisma.agent.update({ where: { id: ropId }, data: { role: "AGENT", permissions: { granted: ["clients.securityReview", "clients.viewAll"], revoked: [] } } });
    invalidateAgentAccess(ropId);
    try {
      const login = await request(app).post("/api/v1/auth/login").send({ phone: rop.phone, password });
      expect(login.status).toBe(200);
      const auth = `Bearer ${login.body.accessToken}`;
      const feed = await request(app).get("/api/v1/me/notifications").set("Authorization", auth);
      expect(feed.status).toBe(200); expect(feed.body.items).toEqual([]); expect(feed.body.hasMore).toBe(false); expect(feed.body.unreadCount).toBe(0);
      expect((await request(app).post(`/api/v1/me/notifications/${notice.id}/read`).set("Authorization", auth)).status).toBe(404);
      // DIRECTOR cases must be inspected even if their former ROP is no longer eligible.
      await prisma.client.update({ where: { id: client.id }, data: { assignedAt: deadline } });
      await runSellerControlTick(deadline);
      expect((await prisma.sellerControlEpisode.findUniqueOrThrow({ where: { id: episode.id } })).status).toBe("CANCELLED");
      expect(await prisma.interaction.count({ where: { clientId: client.id, taskCancelledAt: null } })).toBe(0);
    } finally {
      await prisma.agent.update({ where: { id: ropId }, data: { role: "DIRECTOR", permissions: {} } });
      invalidateAgentAccess(ropId); vi.unstubAllEnvs();
    }
  });
  it("confirmed dual-role seller with open deal is previewed without changing work or adding public tasks", async () => {
    const { client, property, at } = await fixture(true);
    const deal = await prisma.deal.create({ data: { clientId: client.id, propertyId: property.id, agentId, stage: "NEGOTIATION" } });
    const episode = await startSellerControl({ clientId: client.id, ropAgentId: ropId, actorId: ropId, requestKey: randomUUID() }, at);
    await commandSellerControl(episode.id, { requestKey: randomUUID(), revision: 1, action: "TICK" }, ropId, { simulated: true }, new Date(at.getTime() + 10 * 86_400_000));
    await commandSellerControl(episode.id, { requestKey: randomUUID(), revision: 2, action: "TICK" }, ropId, { simulated: true }, new Date(at.getTime() + 20 * 86_400_000));
    expect((await prisma.sellerControlEpisode.findUniqueOrThrow({ where: { id: episode.id } })).status).toBe("DIRECTOR");
    expect(await prisma.notification.count({ where: { tag: `investigation-seller-control-${episode.id}` } })).toBe(0);
    const after = await prisma.client.findUniqueOrThrow({ where: { id: client.id } });
    expect(after).toMatchObject({ assignedAgentId: agentId, assignmentCompletedAt: null, workStatus: "ACTIVE", dualIntent: true });
    expect((await prisma.deal.findUniqueOrThrow({ where: { id: deal.id } })).stage).toBe("NEGOTIATION");
    expect(episode.executionMode).toBe("PREVIEW");
    expect(await prisma.interaction.count({ where: { clientId: client.id } })).toBe(0);
    expect(await prisma.investigationCase.count({ where: { clientId: client.id } })).toBe(0);
  });

  it("concurrent commands claim one revision and a replaced assignment cancels without touching its owner", async () => {
    const { client, at } = await fixture();
    const episode = await startSellerControl({ clientId: client.id, ropAgentId: ropId, actorId: ropId, requestKey: randomUUID() }, at);
    const later = new Date(at.getTime() + 10 * 86_400_000);
    const results = await Promise.allSettled([1, 2].map(() => commandSellerControl(episode.id,
      { requestKey: randomUUID(), revision: 1, action: "TICK" }, ropId, { simulated: true }, later)));
    expect(results.filter(result => result.status === "fulfilled")).toHaveLength(1);
    expect((await prisma.sellerControlEpisode.findUniqueOrThrow({ where: { id: episode.id } })).status).toBe("ROP_RECEIPT");
    await prisma.client.update({ where: { id: client.id }, data: { assignedAgentId: ropId, assignedAt: later } });
    const result = await commandSellerControl(episode.id, { requestKey: randomUUID(), revision: 2, action: "TICK" }, ropId, { simulated: true }, later);
    expect(result.episode.status).toBe("CANCELLED");
    expect((await prisma.client.findUniqueOrThrow({ where: { id: client.id } })).assignedAgentId).toBe(ropId);
    expect(await prisma.interaction.count({ where: { clientId: client.id } })).toBe(0);
  });

  it("isolated gated execution cancels its tasks durably; later reassignment never revives them", async () => {
    vi.stubEnv("SELLER_CONTROL_INTERNAL_LIVE", "explicitly-approved");
    const { client, at } = await fixture();
    const episode = await startSellerControl({ clientId: client.id, ropAgentId: ropId, actorId: ropId, requestKey: randomUUID(), live: true }, at);
    const later = new Date(at.getTime() + 10 * 86_400_000);
    await commandSellerControl(episode.id, { requestKey: randomUUID(), revision: 1, action: "TICK" }, null, {}, later);
    await commandSellerControl(episode.id, { requestKey: randomUUID(), revision: 2, action: "CANCEL", note: "Isolated cancellation" }, ropId, {}, later);
    const tasks = await prisma.interaction.findMany({ where: { clientId: client.id } });
    expect(tasks).toHaveLength(2);
    expect(tasks.every(task => task.taskCancelledAt?.getTime() === later.getTime() && task.investigationOnly === false)).toBe(true);
    expect(tasks.every(task => !/СБ|провер|подозр/i.test(task.notes))).toBe(true);
    await prisma.client.update({ where: { id: client.id }, data: { assignedAt: later } });
    expect(await prisma.interaction.count({ where: { clientId: client.id, taskCancelledAt: null } })).toBe(0);
    vi.unstubAllEnvs();
  });
});
