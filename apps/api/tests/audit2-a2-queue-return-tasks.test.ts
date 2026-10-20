import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { prisma } from "../src/db.js";
import { changeClientAgent } from "../src/lib/changeClientAgent.js";

/**
 * CRM-02 (аудит 04.10.2026): клиент А с открытой задачей уходит в очередь (А → null),
 * затем назначается Б (null → Б). transferOpenTasks срабатывал только при
 * непустом прежнем агенте, поэтому карточка оказывалась у Б, а календарная задача
 * оставалась у А. Теперь при выходе из очереди задачи последнего держателя
 * (lastAgentId) переезжают к новому владельцу; задачи третьего агента не трогаются.
 */
const runId = Date.now();
let aId = "";
let bId = "";
let vId = "";
let dId = "";
const clientIds: string[] = [];

async function agent(name: string, tail: string) {
  return (await prisma.agent.create({ data: { fullName: `${name} ${runId}`, phone: `+9929${tail}${runId}`, role: "AGENT", passwordHash: "x" } })).id;
}
async function makeClient(assignedAgentId: string) {
  const c = await prisma.client.create({
    data: { fullName: `Клиент очереди ${clientIds.length} ${runId}`, phone: `+99281${clientIds.length}${runId}`, source: "PHONE_CALL", assignedAgentId },
  });
  clientIds.push(c.id);
  return c;
}
const task = (clientId: string, owner: { agentId?: string | null; subjectAgentId?: string | null }) =>
  prisma.interaction.create({
    data: {
      clientId,
      type: "CALL",
      notes: "Перезвонить",
      nextAction: "Перезвонить",
      nextActionDate: new Date(Date.now() + 86_400_000),
      // Задача без agentId заведена автоматикой: схема требует для неё не-AGENT actorKind.
      ...(owner.agentId ? {} : { actorKind: "SYSTEM" as const }),
      ...owner,
    },
  });

beforeAll(async () => {
  aId = await agent("Агент А очереди", "41");
  bId = await agent("Агент Б очереди", "42");
  vId = await agent("Агент В очереди", "43");
  dId = await agent("Руководитель очереди", "44");
});
afterAll(async () => {
  await prisma.interaction.deleteMany({ where: { clientId: { in: clientIds } } });
  await prisma.client.deleteMany({ where: { id: { in: clientIds } } });
  await prisma.agent.deleteMany({ where: { id: { in: [aId, bId, vId, dId] } } });
  await prisma.$disconnect();
});

const move = (clientId: string, toAgentId: string | null) =>
  changeClientAgent({ clientId, toAgentId, reason: "тест очереди", actorId: dId, source: "test.queue" });

describe("возврат из очереди переносит задачи последнего держателя (CRM-02)", () => {
  it("А → очередь → Б: задачи А (своя и заведённая ботом) переезжают к Б, задача В остаётся у В", async () => {
    const client = await makeClient(aId);
    const own = await task(client.id, { agentId: aId });
    const bot = await task(client.id, { agentId: null, subjectAgentId: aId });
    const foreign = await task(client.id, { agentId: vId });

    expect((await move(client.id, null)).ok).toBe(true);
    expect((await move(client.id, bId)).ok).toBe(true);

    expect((await prisma.interaction.findUniqueOrThrow({ where: { id: own.id } })).agentId).toBe(bId);
    expect((await prisma.interaction.findUniqueOrThrow({ where: { id: bot.id } })).subjectAgentId).toBe(bId);
    expect((await prisma.interaction.findUniqueOrThrow({ where: { id: foreign.id } })).agentId).toBe(vId);
  });

  it("прямая передача А → Б работает как раньше", async () => {
    const client = await makeClient(aId);
    const own = await task(client.id, { agentId: aId });
    expect((await move(client.id, bId)).ok).toBe(true);
    expect((await prisma.interaction.findUniqueOrThrow({ where: { id: own.id } })).agentId).toBe(bId);
  });

  it("возврат из очереди тому же агенту: задачи остаются у него", async () => {
    const client = await makeClient(aId);
    const own = await task(client.id, { agentId: aId });
    await move(client.id, null);
    await move(client.id, aId);
    expect((await prisma.interaction.findUniqueOrThrow({ where: { id: own.id } })).agentId).toBe(aId);
  });
});
