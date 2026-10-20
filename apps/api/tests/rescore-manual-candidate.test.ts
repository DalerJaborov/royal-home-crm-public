import { afterAll, describe, expect, it } from "vitest";
import { prisma } from "../src/db.js";
import { convertClientToJobApplication } from "../src/lib/clientToCandidate.js";
import { rescoreJobApplications } from "../src/lib/rescoreJobApplications.js";
import { createTestAgent } from "./helpers/ownAgent.js";
import { deleteAgentsWithTraces } from "./helpers/cleanupAgents.js";

/**
 * ПЕРЕВЕДЁННОГО РУКАМИ ПЕРЕСЧЁТ НЕ ПРЯЧЕТ (02.10.2026).
 *
 * rescoreJobApplications переводит в NOT_CANDIDATE анкеты NEW, чей разговор был
 * не про работу. Но «В кандидаты» на карточке жмут ровно тогда, когда разговор
 * шёл «про покупку», а человек оказался соискателем, — и пересчёт прятал такого
 * кандидата обратно. Прогон — БЕЗ записи (apply=false): с записью он прошёлся
 * бы по анкетам соседних файлов на общей базе.
 */

const runId = Date.now();
const clientIds: string[] = [];
const conversationIds: string[] = [];
const agentIds: string[] = [];

afterAll(async () => {
  await prisma.jobApplication.deleteMany({ where: { conversationId: { in: conversationIds } } });
  await prisma.interaction.deleteMany({ where: { clientId: { in: clientIds } } });
  await prisma.botConversation.deleteMany({ where: { id: { in: conversationIds } } });
  await prisma.client.deleteMany({ where: { id: { in: clientIds } } });
  await deleteAgentsWithTraces(agentIds);
});

async function buyConversation(tag: string, clientId: string | null) {
  const id = `rescore-manual-${runId}-${tag}`;
  conversationIds.push(id);
  await prisma.botConversation.create({
    data: {
      id,
      channel: "WHATSAPP",
      subscriberId: `rescore-manual-sub-${runId}-${tag}`,
      clientId,
      lastMessageAt: new Date(),
      leadDraft: { intent: "buy" },
      messages: [{ role: "user", content: "Ман кор мекобам" }],
    },
  });
  return id;
}

describe("пересчёт отбора и ручной перевод в кандидаты", () => {
  it("анкета, переведённая руководителем, остаётся NEW; обычная «про покупку» уходит в NOT_CANDIDATE", async () => {
    const agentId = await createTestAgent(`Пересчёт-ручной ${runId}`);
    agentIds.push(agentId);
    const client = await prisma.client.create({
      data: {
        fullName: `Пересчёт-ручной ${runId}`,
        phone: `+9929${String(runId).slice(-7)}9`,
        source: "WHATSAPP",
        kind: "BUYER",
        currency: "TJS",
        assignedAgentId: agentId,
        acceptedAt: new Date(),
      },
    });
    clientIds.push(client.id);
    const manualConv = await buyConversation("manual", client.id);
    const converted = await convertClientToJobApplication({ clientId: client.id, actorId: agentId });
    expect(converted.ok).toBe(true);

    const plainConv = await buyConversation("plain", null);
    const plain = await prisma.jobApplication.create({
      data: { conversationId: plainConv, channel: "WHATSAPP", name: `Пересчёт-обычный ${runId}`, status: "NEW" },
    });
    const manual = await prisma.jobApplication.findUnique({ where: { conversationId: manualConv } });
    expect(manual?.status).toBe("NEW");

    const result = await rescoreJobApplications(false);
    const hidden = new Set(result.notCandidate.map((r) => r.id));
    expect(hidden.has(plain.id)).toBe(true);
    expect(hidden.has(manual!.id)).toBe(false);
  });
});
