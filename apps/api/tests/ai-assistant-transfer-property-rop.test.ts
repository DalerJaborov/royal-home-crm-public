import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import bcrypt from "bcrypt";
import type { PermissionId } from "@royal-home/shared";

/**
 * ШАБНАМ: «передай объект» пускает по тому же правилу, что кнопка в CRM (17.11.2026).
 *
 * Раньше инструмент требовал `properties.editForeign` (его у РОПа нет — владелец 16.11 заменил
 * правку чужих объектов передачей с уведомлением директору), и Шабнам РОПу отказывала, хотя
 * экран пускал по `canTransferProperty` (lib/propertyManualTransfer.ts). Теперь права решает
 * одна эта функция — и в объявлении инструмента, и при подготовке карточки, и при нажатии.
 */

const { push, tgSend } = vi.hoisted(() => ({
  push: vi.fn(async () => 1),
  tgSend: vi.fn(async () => ({ message_id: 1 })),
}));
vi.mock("../src/push.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/push.js")>()),
  sendPushToAgent: push,
  sendPushToAgents: push,
}));
vi.mock("../src/telegram/api.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/telegram/api.js")>()),
  isTelegramEnabled: () => true,
  sendMessageWithButtons: tgSend,
  sendMessage: vi.fn(async () => ({ message_id: 2 })),
  sendHtmlMessage: vi.fn(async () => ({ message_id: 3 })),
}));

const { prisma } = await import("../src/db.js");
await import("../src/ai/assistant/tools/index.js");
const { pluginDeclarations } = await import("../src/ai/assistant.js");
const { actorFromAccess } = await import("../src/ai/assistant/actor.js");
const { loadAgentAccess } = await import("../src/auth/middleware.js");
const { createPendingAssistantAction, confirmAssistantAction, AssistantActionError } = await import("../src/lib/assistantActions.js");
const { actorFor, cleanupAssistantActionAgents } = await import("./helpers/assistantActionFixture.js");
const { waitFor, waitForSettled } = await import("./helpers/waitFor.js");
const { formatPropertyCode } = await import("@royal-home/shared");

const runId = String(Date.now()).slice(-7);
const agentIds: string[] = [];
const propertyIds: string[] = [];
let districtId = "";
const ids: Record<"owner" | "target" | "rop" | "director", string> = { owner: "", target: "", rop: "", director: "" };
const ROP_PERMS: PermissionId[] = ["transfers.request", "clients.assign"];

async function mkAgent(key: keyof typeof ids, role: "AGENT" | "HEAD_OF_SALES" | "DIRECTOR") {
  const agent = await prisma.agent.create({
    data: {
      fullName: `Передача Шабнам ${key} ${runId}`,
      phone: `+992${Math.floor(Math.random() * 900_000_000) + 100_000_000}`,
      role,
      passwordHash: await bcrypt.hash("testpass123", 4),
    },
  });
  ids[key] = agent.id;
  agentIds.push(agent.id);
}

async function mkProperty(owner: string) {
  const p = await prisma.property.create({
    data: {
      title: `Объект передачи Шабнам ${runId}-${propertyIds.length}`,
      type: "APARTMENT",
      areaSqm: 50,
      price: 60000,
      currency: "USD",
      districtId,
      address: `Тест передачи ${runId}`,
      condition: "GOOD",
      status: "AVAILABLE",
      intakeAgentId: owner,
      assignedAgentId: owner,
    },
  });
  propertyIds.push(p.id);
  return p;
}

const ownerOf = async (propertyId: string) => (await prisma.property.findUniqueOrThrow({ where: { id: propertyId } })).assignedAgentId;

beforeAll(async () => {
  districtId = (await prisma.district.create({ data: { name: `Передача-Шабнам-${runId}` } })).id;
  await mkAgent("owner", "AGENT");
  await mkAgent("target", "AGENT");
  await mkAgent("rop", "HEAD_OF_SALES");
  await mkAgent("director", "DIRECTOR");
});

afterAll(async () => {
  // Уведомление директору о передаче РОПа уходит в фоне — дождаться строки до уборки.
  await waitForSettled(() => prisma.ownershipTransferRequest.count({ where: { requestedById: { in: agentIds } } }));
  await prisma.ownershipTransferRequest.deleteMany({ where: { requestedById: { in: agentIds } } });
  await prisma.property.deleteMany({ where: { id: { in: propertyIds } } });
  await cleanupAssistantActionAgents(agentIds);
  await prisma.district.deleteMany({ where: { id: districtId } });
  await prisma.$disconnect();
});

async function declaredFor(key: keyof typeof ids, surface: "crm-private" | "telegram-group") {
  const access = await loadAgentAccess(ids[key]);
  const actor = actorFromAccess(ids[key], { role: access!.role, permissions: access!.permissions }, surface);
  return pluginDeclarations(actor, true, surface === "crm-private" ? "crm" : "telegram").map((row) => row.name);
}

describe("transfer_property: РОП передаёт объект через Шабнам", () => {
  it("инструмент объявляется РОПу и директору, но не рядовому агенту и не в общей группе", async () => {
    expect(await declaredFor("rop", "crm-private")).toContain("transfer_property");
    expect(await declaredFor("director", "crm-private")).toContain("transfer_property");
    expect(await declaredFor("owner", "crm-private")).not.toContain("transfer_property");
    expect(await declaredFor("rop", "telegram-group")).not.toContain("transfer_property");
  });

  it("РОП: карточка не пишет, «Подтвердить» передаёт объект получателю, в журнале PROPERTY_TRANSFER от РОПа", async () => {
    const p = await mkProperty(ids.owner);
    const actor = actorFor(ids.rop, ROP_PERMS);
    const pending = await createPendingAssistantAction(actor, "transfer_property", {
      ref: formatPropertyCode(p.shortId),
      toAgentId: ids.target,
      reason: "Агент в отпуске",
    });
    expect(pending.preview.title).toContain("Передать");
    expect(await ownerOf(p.id)).toBe(ids.owner);

    const done = await confirmAssistantAction(pending.id, actor);
    expect(done.replay).toBe(false);
    expect(await ownerOf(p.id)).toBe(ids.target);
    const audit = await waitFor(() => prisma.auditLog.findFirst({ where: { entityId: p.id, action: "PROPERTY_TRANSFER" } }));
    expect(audit?.agentId).toBe(ids.rop);
  });

  it("директор по-прежнему передаёт (properties.editForeign + clients.assign)", async () => {
    const p = await mkProperty(ids.owner);
    const actor = actorFor(ids.director, ["properties.editForeign", "clients.assign"]);
    const pending = await createPendingAssistantAction(actor, "transfer_property", { ref: String(p.shortId), toAgentId: ids.target, reason: "Перераспределение" });
    await confirmAssistantAction(pending.id, actor);
    expect(await ownerOf(p.id)).toBe(ids.target);
  });

  it("рядовой агент — отказ при подготовке, объект на месте; «права на словах» не помогают", async () => {
    const p = await mkProperty(ids.owner);
    for (const [who, perms] of [
      [ids.owner, []],
      [ids.owner, [...ROP_PERMS, "properties.editForeign"]],
    ] as const) {
      const error = await createPendingAssistantAction(actorFor(who, [...perms]), "transfer_property", {
        ref: String(p.shortId),
        toAgentId: ids.target,
        reason: "Попытка",
      }).then(() => null, (e: unknown) => e);
      expect(error).toBeInstanceOf(AssistantActionError);
      expect((error as InstanceType<typeof AssistantActionError>).status).toBe(403);
    }
    expect(await ownerOf(p.id)).toBe(ids.owner);
  });
});
