import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { prisma } from "../src/db.js";
import { changeClientAgent } from "../src/lib/changeClientAgent.js";
import { recordNamedAssignmentDeclaration } from "../src/lib/clientWorkflowObservations.js";
import { deleteAgentsWithTraces } from "./helpers/cleanupAgents.js";
const ids: string[] = []; let clientId: string;
beforeAll(async () => {
  expect(await prisma.workflowCheckpoint.findUnique({ where: { key: "client-workflow-observations-v1" } })).not.toBeNull();
  for (const role of ["ADMIN", "AGENT", "AGENT"] as const) {
    const agent = await prisma.agent.create({ data: { fullName: `Workflow fixture ${randomUUID()}`, phone: `workflow-${randomUUID()}`, role, passwordHash: "unused" } });
    ids.push(agent.id);
  }
  const client = await prisma.client.create({ data: { fullName: "Workflow source fixture", phone: `workflow-client-${randomUUID()}`, kind: "BUYER", source: "PHONE_CALL" } });
  clientId = client.id;
});
afterAll(async () => {
  if (clientId) {
    await prisma.clientWorkflowObservation.deleteMany({ where: { clientId } });
    await prisma.investigationCase.deleteMany({ where: { clientId } });
    await prisma.interaction.deleteMany({ where: { clientId } });
    await prisma.auditLog.deleteMany({ where: { entityType: "Client", entityId: clientId } });
    await prisma.client.deleteMany({ where: { id: clientId } });
  }
  await deleteAgentsWithTraces(ids); await prisma.$disconnect();
});
describe("future assignment observation central transaction", () => {
  it("captures actual new ownership once, excludes no-op, and retains a later return to the same owner", async () => {
    const change = (toAgentId: string) => changeClientAgent({ clientId, toAgentId, actorId: ids[0], actorName: "Workflow fixture",
      reason: "Isolated ownership fixture", source: "manual.assign", skipInteraction: true, skipProperties: true });
    expect((await change(ids[1])).ok).toBe(true);
    expect(await prisma.clientWorkflowObservation.count({ where: { clientId, kind: "ASSIGNMENT_SNAPSHOT" } })).toBe(1);
    expect((await change(ids[1])).ok).toBe(true);
    expect(await prisma.clientWorkflowObservation.count({ where: { clientId, kind: "ASSIGNMENT_SNAPSHOT" } })).toBe(1);
    expect((await change(ids[2])).ok).toBe(true);
    expect((await change(ids[1])).ok).toBe(true);
    const rows = await prisma.clientWorkflowObservation.findMany({ where: { clientId, kind: "ASSIGNMENT_SNAPSHOT" } });
    expect(rows).toHaveLength(3); expect(new Set(rows.map(row => row.sourceId)).size).toBe(3);
    expect(rows.every(row => row.executionMode === "PREVIEW")).toBe(true);
    expect(await prisma.investigationCase.count({ where: { clientId } })).toBe(0);
    const current = await prisma.client.findUniqueOrThrow({ where: { id: clientId } });
    const reassignmentAt = new Date(current.assignedAt.getTime() + 1000);
    expect((await changeClientAgent({ clientId, toAgentId: ids[1], actorId: ids[0], actorName: "Workflow fixture",
      reason: "Explicit same-owner new assignment", source: "manual.assign", skipInteraction: true, skipProperties: true,
      data: { assignedAt: reassignmentAt } })).ok).toBe(true);
    expect(await prisma.clientWorkflowObservation.count({ where: { clientId, kind: "ASSIGNMENT_SNAPSHOT" } })).toBe(4);
  });
  it("a declared agent name stays unverified and cannot mutate ownership, status or scores", async () => {
    const before = await prisma.client.findUniqueOrThrow({ where: { id: clientId } });
    const scoreEvents = await prisma.royalScoreEvent.count({ where: { agentId: { in: ids } } });
    await prisma.$transaction(tx => recordNamedAssignmentDeclaration(tx, clientId, ids[2]));
    await prisma.$transaction(tx => recordNamedAssignmentDeclaration(tx, clientId, ids[2]));
    const after = await prisma.client.findUniqueOrThrow({ where: { id: clientId } });
    expect(after.assignedAgentId).toBe(before.assignedAgentId); expect(after.status).toBe(before.status); expect(after.securityReview).toBe(before.securityReview);
    const rows = await prisma.clientWorkflowObservation.findMany({ where: { clientId, kind: "NAMED_ASSIGNMENT" } });
    expect(rows).toHaveLength(1); expect(rows[0].subjectAgentId).toBe(before.assignedAgentId);
    expect(rows[0].payload).toMatchObject({ verification: "UNVERIFIED", requestedAgentId: ids[2] });
    expect(await prisma.investigationCase.count({ where: { clientId } })).toBe(0);
    expect(await prisma.royalScoreEvent.count({ where: { agentId: { in: ids } } })).toBe(scoreEvents);
  });
});
