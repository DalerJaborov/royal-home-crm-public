import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import bcrypt from "bcrypt";
import { prisma } from "../src/db.js";
import { acceptLead } from "../src/lib/leadAccept.js";

/**
 * pickAgentForLead замокан на «некому передать»: приём лида никого никуда
 * не передаёт, и если бы передача случилась, тест бы это увидел.
 */
vi.mock("../src/services/leads/selection.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/services/leads/selection.js")>();
  return { ...actual, pickAgentForLead: vi.fn().mockResolvedValue(null) };
});

/**
 * Приём лида: двойной клик (идемпотентность), принятие уже переназначенного
 * лида (гонка с кроном) и приём без лимита (16.11.2026).
 */

const runId = Date.now();
const password = "testpass123";

let agentId: string;
let otherAgentId: string;
const clientIds: string[] = [];
let savedSettings: Record<string, unknown>;

beforeAll(async () => {
  const passwordHash = await bcrypt.hash(password, 10);
  agentId = (
    await prisma.agent.create({
      data: { fullName: "Агент приёма лида", phone: `+992970${runId}`, role: "AGENT", passwordHash },
    })
  ).id;
  otherAgentId = (
    await prisma.agent.create({
      data: { fullName: "Второй агент приёма лида", phone: `+992971${runId}`, role: "AGENT", passwordHash },
    })
  ).id;

  const settings = await prisma.settings.upsert({ where: { id: "singleton" }, update: {}, create: { id: "singleton" } });
  savedSettings = {
    leadActiveLimit: settings.leadActiveLimit,
    ownPropertyOverLimitEnabled: settings.ownPropertyOverLimitEnabled,
    ownPropertyReleaseEnabled: settings.ownPropertyReleaseEnabled,
    ownPropertyReleaseMode: settings.ownPropertyReleaseMode,
  };
});

afterAll(async () => {
  await prisma.settings.update({ where: { id: "singleton" }, data: savedSettings });
  await prisma.interaction.deleteMany({ where: { clientId: { in: clientIds } } });
  await prisma.client.deleteMany({ where: { id: { in: clientIds } } });
  await prisma.agent.deleteMany({ where: { id: { in: [agentId, otherAgentId] } } });
  await prisma.$disconnect();
});

async function makeClient(overrides: Partial<{ ownPropertyLead: boolean; accepted: boolean; assignedAgentId: string }> = {}) {
  const c = await prisma.client.create({
    data: {
      fullName: `Клиент приёма лида ${runId}-${clientIds.length}`,
      phone: `+992972${runId}${clientIds.length}`,
      source: "PHONE_CALL",
      kind: "BUYER",
      assignedAgentId: overrides.assignedAgentId ?? agentId,
      acceptedAt: overrides.accepted ? new Date() : null,
      ownPropertyLead: overrides.ownPropertyLead ?? false,
    },
  });
  clientIds.push(c.id);
  return c;
}

describe("acceptLead — двойной клик", () => {
  it("повторный вызов на уже принятой карточке — успех, без побочных эффектов", async () => {
    const client = await makeClient();
    const first = await acceptLead({ clientId: client.id, agentId });
    expect(first.ok).toBe(true);

    const second = await acceptLead({ clientId: client.id, agentId });
    expect(second.ok).toBe(true);

    const reloaded = await prisma.client.findUniqueOrThrow({ where: { id: client.id } });
    expect(reloaded.acceptedAt).not.toBeNull();
    // Записей «Заявка принята агентом» — ровно одна, не по одной на каждый клик.
    const accepts = await prisma.interaction.count({
      where: { clientId: client.id, notes: "Заявка принята агентом — контакты открыты" },
    });
    expect(accepts).toBe(1);
  });
});

describe("acceptLead — принятие уже переназначенного лида", () => {
  it("лид ушёл другому агенту (гонка с кроном) — 409, а не тихий успех", async () => {
    const client = await makeClient();
    // Симулируем то, что делает крон переназначения между проверками агента и приёмом.
    await prisma.client.update({ where: { id: client.id }, data: { assignedAgentId: otherAgentId } });

    const result = await acceptLead({ clientId: client.id, agentId });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.status).toBe(409);
    }
  });
});

describe("acceptLead — лимита нет (владелец 16.11.2026)", () => {
  it("лид по своему объекту принимается при любом портфеле: без вопроса «кого отдать»", async () => {
    // Старая настройка в базе (до миграции колонки) не должна ничего значить.
    await prisma.settings.update({
      where: { id: "singleton" },
      data: { leadActiveLimit: 1, ownPropertyOverLimitEnabled: true, ownPropertyReleaseEnabled: true },
    });
    const normal = await makeClient({ accepted: true });
    const second = await makeClient({ accepted: true });
    const ownLead = await makeClient({ ownPropertyLead: true });

    const result = await acceptLead({ clientId: ownLead.id, agentId });
    expect(result).toEqual({ ok: true });

    const after = await prisma.client.findMany({ where: { id: { in: [normal.id, second.id, ownLead.id] } } });
    expect(after.every((c) => c.assignedAgentId === agentId && c.acceptedAt)).toBe(true);
  });
});
