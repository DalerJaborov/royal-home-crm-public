import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { prisma } from "../src/db.js";
import { previewWorkflowAgentCounts } from "../src/lib/workflowAgentPreview.js";
import { deleteAgentsWithTraces } from "./helpers/cleanupAgents.js";
const agents: string[] = [], clients: string[] = [];
const now = new Date(), old = new Date(now.getTime() - 31 * 86400_000), yesterday = new Date(now.getTime() - 86400_000);
beforeAll(async () => {
  for (const suffix of ["A", "B"]) agents.push((await prisma.agent.create({ data: { fullName: `Aggregate ${suffix}`, phone: randomUUID(), passwordHash: "isolated-no-login", role: "AGENT" } })).id);
});
afterAll(async () => {
  await prisma.smsMessage.deleteMany({ where: { clientId: { in: clients } } });
  await prisma.auditLog.deleteMany({ where: { entityType: "Client", entityId: { in: clients } } });
  await prisma.interaction.deleteMany({ where: { clientId: { in: clients } } });
  await prisma.client.deleteMany({ where: { id: { in: clients } } });
  await deleteAgentsWithTraces(agents); await prisma.$disconnect();
});
async function manual(agentId: string, assignedAt = old) {
  const client = await prisma.client.create({ data: { fullName: "Manual aggregate fixture", phone: randomUUID(), source: "PHONE_CALL", kind: "BUYER", assignedAgentId: agentId, assignedAt } });
  clients.push(client.id);
  await prisma.interaction.create({ data: { clientId: client.id, agentId, type: "CALL", actorKind: "AGENT", notes: "Manual declaration", createdAt: yesterday } });
  return client;
}
describe("whole-cohort manual-only aggregate actual SQL", () => {
  it("counts four A versus three B; excludes station, accepted SMS, young assignment and reused-date ABA, ignores private calls", async () => {
    const a = await Promise.all(Array.from({ length: 4 }, () => manual(agents[0])));
    await Promise.all(Array.from({ length: 3 }, () => manual(agents[1])));
    const station = await manual(agents[0]);
    await prisma.interaction.create({ data: { clientId: station.id, agentId: agents[0], type: "CALL", notes: "Provider attempt", callAttempt: "NO_ANSWER", createdAt: yesterday } });
    const message = await manual(agents[0]);
    await prisma.smsMessage.create({ data: { clientId: message.id, phone: "isolated", purpose: "TEST", text: "Synthetic receipt only", status: "SENT", providerMessageId: randomUUID(), createdAt: yesterday } });
    await manual(agents[0], yesterday);
    const aba = await manual(agents[0]);
    await prisma.auditLog.createMany({ data: [
      { agentName: "Fixture", action: "CLIENT_AGENT_CHANGE", entityType: "Client", entityId: aba.id, createdAt: yesterday, meta: { fromAgentId: agents[0], toAgentId: agents[1] } },
      { agentName: "Fixture", action: "CLIENT_AGENT_CHANGE", entityType: "Client", entityId: aba.id, createdAt: new Date(yesterday.getTime() + 1), meta: { fromAgentId: agents[1], toAgentId: agents[0] } },
    ] });
    await prisma.interaction.create({ data: { clientId: a[0].id, agentId: agents[0], type: "CALL", notes: "Private robot call", investigationOnly: true, callAttempt: "TALKED", recordingUrl: "private", createdAt: yesterday } });
    const result = await previewWorkflowAgentCounts(now);
    expect(result.manual.find(row => row.subjectAgentId === agents[0])).toMatchObject({ eligibleLocalCards: 4, reviewSuggested: true });
    expect(result.manual.find(row => row.subjectAgentId === agents[1])).toMatchObject({ eligibleLocalCards: 3, reviewSuggested: false });
    expect(result).toMatchObject({ coverage: "UNKNOWN", assessment: "NOT_A_VERDICT" });
  });
});
