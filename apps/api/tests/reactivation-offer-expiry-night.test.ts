import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { randomInt } from "node:crypto";

/**
 * B10 глубокой проверки 02.10.2026: просроченное предложение реактивации снималось
 * круглосуточным кроном и раздавалось по очереди ночью — непринятым лидом, о
 * котором агент узнавал утром, когда карусель уже считала его «не принятым».
 * С флагом крона ночью предложение ждёт утра.
 */

vi.mock("../src/push.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/push.js")>()),
  sendPushToAgent: vi.fn(async () => 1),
  sendPushToAgents: vi.fn(async () => 1),
}));

const { prisma } = await import("../src/db.js");
const { expireStaleReactivationOffers } = await import("../src/lib/reactivationOffers.js");
const { deleteAgentsWithTraces } = await import("./helpers/cleanupAgents.js");
const { isWithinWorkingHours } = await import("../src/lib/workingHours.js");

/**
 * Час внутри и час вне часов раздачи — по тем Настройкам, что лежат в базе.
 * Настройки здесь НЕ правятся: соседние файлы на той же базе держат свои окна
 * (00:00–23:59 у тестов сайта), и чужая правка посреди их прогона ломала бы их.
 */
async function hourWhere(open: boolean): Promise<Date | null> {
  for (let h = 0; h < 24; h++) {
    const at = new Date();
    at.setUTCHours(h, 7, 0, 0);
    if ((await isWithinWorkingHours(at)) === open) return at;
  }
  return null;
}

const phone = () => `+99293${randomInt(1_000_000, 9_999_999)}`;
let agentId = "";
let clientId = "";

beforeAll(async () => {
  agentId = (await prisma.agent.create({ data: { fullName: "Агент предложения B10", phone: phone(), role: "AGENT", passwordHash: "x" } })).id;
  clientId = (
    await prisma.client.create({
      data: {
        fullName: "Предложение B10",
        phone: phone(),
        kind: "BUYER",
        source: "INSTAGRAM",
        workStatus: "INACTIVE",
        reactivationOfferedToAgentId: agentId,
        reactivationOfferedAt: new Date(Date.now() - 30 * 24 * 3600_000),
      },
    })
  ).id;
});

afterAll(async () => {
  await prisma.interaction.deleteMany({ where: { clientId } });
  await prisma.client.deleteMany({ where: { id: clientId } });
  await deleteAgentsWithTraces([agentId]);
  await prisma.$disconnect();
});

describe("истечение предложения реактивации ночью", () => {
  it("вне часов раздачи с флагом крона — не снимает, предложение ждёт утра", async () => {
    const night = await hourWhere(false);
    if (!night) return; // окно круглосуточное — ночи нет, проверять нечего
    const released = await expireStaleReactivationOffers(night, { onlyWorkingHours: true });
    expect(released).toBe(0);
    const after = await prisma.client.findUniqueOrThrow({ where: { id: clientId } });
    expect(after.reactivationOfferedToAgentId).toBe(agentId);
  });

  it("в часы раздачи — снимает как прежде", async () => {
    const day = await hourWhere(true);
    expect(day).not.toBeNull();
    const released = await expireStaleReactivationOffers(day, { onlyWorkingHours: true });
    expect(released).toBeGreaterThanOrEqual(1);
    const after = await prisma.client.findUniqueOrThrow({ where: { id: clientId } });
    expect(after.reactivationOfferedToAgentId).toBeNull();
  });
});
