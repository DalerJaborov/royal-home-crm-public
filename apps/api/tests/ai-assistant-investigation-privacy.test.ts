import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PERMISSION_IDS, type PermissionId } from "@royal-home/shared";

/**
 * ЗАПИСИ «ТОЛЬКО ДЛЯ ПРОВЕРКИ» В ИИ-ПОМОЩНИКЕ — ПО ПРАВИЛУ REST (сборка П3, ревью 2).
 *
 * REST передаёт в проекции `investigationViewerRole(req)`: роль ADMIN/DIRECTOR И
 * действующее право clients.securityReview (auth/investigations.ts). Помощник
 * передавал голую `actor.role`, и директор/админ с ОТОЗВАННЫМ правом видел закрытые
 * записи в get_client_card.nextTask, list_my_tasks и get_client_history. Теперь
 * одно правило (`investigationRoleFor`) на обе стороны.
 */

const { prisma } = await import("../src/db.js");
await import("../src/ai/assistant/tools/index.js");
const { findAssistantToolPlugin } = await import("../src/ai/assistant/tools/index.js");
const { runTool } = await import("../src/ai/assistant.js");
const { actorFromAccess } = await import("../src/ai/assistant/actor.js");
const { dushanbeDateString } = await import("../src/lib/dushanbeTime.js");
const { createTestAgent } = await import("./helpers/ownAgent.js");
const { deleteAgentsWithTraces } = await import("./helpers/cleanupAgents.js");

const runId = `${Date.now()}`.slice(-8);
let adminId = "";
let clientId = "";
const at = new Date(Date.now() + 2 * 3_600_000);

const withoutReview = new Set<PermissionId>(PERMISSION_IDS.filter((p) => p !== "clients.securityReview"));
const withReview = new Set<PermissionId>(PERMISSION_IDS);
const actorOf = (permissions: Set<PermissionId>) => actorFromAccess(adminId, { role: "ADMIN", permissions });

async function read(name: string, args: Record<string, unknown>, permissions: Set<PermissionId>) {
  const plugin = findAssistantToolPlugin(name);
  if (!plugin || plugin.level !== "A") throw new Error(`нет инструмента чтения ${name}`);
  return (await plugin.run(args, { actor: actorOf(permissions) })) as Record<string, any>;
}

beforeAll(async () => {
  adminId = await createTestAgent(`Админ проверки ${runId}`);
  await prisma.agent.update({ where: { id: adminId }, data: { role: "ADMIN" } });
  const client = await prisma.client.create({
    data: {
      fullName: `Клиент проверки ${runId}`,
      phone: `+99291${runId.slice(-7)}`,
      source: "PHONE_CALL",
      kind: "BUYER",
      status: "NEW",
      assignedAgentId: adminId,
      acceptedAt: new Date(),
    },
  });
  clientId = client.id;
  // Единственная задача клиента — закрытая, «только для проверки».
  await prisma.interaction.create({
    data: {
      clientId,
      agentId: adminId,
      type: "CALL",
      notes: `закрытая запись ${runId}`,
      nextAction: `закрытая задача ${runId}`,
      nextActionDate: at,
      investigationOnly: true,
    },
  });
});

afterAll(async () => {
  await prisma.interaction.deleteMany({ where: { clientId } });
  await prisma.client.deleteMany({ where: { id: clientId } });
  await deleteAgentsWithTraces([adminId]);
  await prisma.$disconnect();
});

describe("админ с отозванным clients.securityReview", () => {
  it("get_client_card: закрытой задачи нет в nextTask; с правом — есть", async () => {
    const hidden = await read("get_client_card", { clientId }, withoutReview);
    expect(hidden.nextTask).toBeNull();
    expect(hidden.lastContact.lastRecord).toBeNull();
    const shown = await read("get_client_card", { clientId }, withReview);
    expect(shown.nextTask?.text).toContain(`закрытая задача ${runId}`);
  });

  it("list_my_tasks: закрытой задачи нет; с правом — есть", async () => {
    const date = dushanbeDateString(at);
    const hidden = await read("list_my_tasks", { date }, withoutReview);
    const texts = (r: Record<string, any>) => r.tasks.map((t: { text: string | null }) => t.text ?? "").join(" ");
    expect(texts(hidden)).not.toContain(`закрытая задача ${runId}`);
    const shown = await read("list_my_tasks", { date }, withReview);
    expect(texts(shown)).toContain(`закрытая задача ${runId}`);
  });

  it("get_client_history: закрытой записи нет; с правом — есть", async () => {
    const hidden = (await runTool("get_client_history", { clientId }, actorOf(withoutReview))) as { history: { notes: string }[] };
    expect(JSON.stringify(hidden.history)).not.toContain(`закрытая запись ${runId}`);
    const shown = (await runTool("get_client_history", { clientId }, actorOf(withReview))) as { history: { notes: string }[] };
    expect(JSON.stringify(shown.history)).toContain(`закрытая запись ${runId}`);
  });
});
