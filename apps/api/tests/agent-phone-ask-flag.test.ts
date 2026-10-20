import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { prisma } from "../src/db.js";
import { checkAgentPhoneAsk } from "../src/lib/agentPhoneAskDetector.js";

/**
 * checkAgentPhoneAsk — поведение переработано 07.09.2026 (владелец: «и то не
 * нужно вмешиваться в онлайн»): раньше при срабатывании сразу уходил пуш
 * директору, теперь — только молчаливая пометка карточки клиента
 * (Client.phoneAskFlaggedAt/ByAgentId), без пуша и без записи в ленту
 * уведомлений. Аларм по этому факту решает отдельно lib/agentOffCrmAlarm.ts.
 */

const runId = Date.now();
let agentId: string;
const clientIds: string[] = [];

async function makeClient() {
  const c = await prisma.client.create({
    data: {
      fullName: `Флаг номера ${runId}-${clientIds.length}`,
      phone: `+992978${runId}${clientIds.length}`,
      source: "PHONE_CALL",
      kind: "SELLER",
      assignedAgentId: agentId,
    },
  });
  clientIds.push(c.id);
  return c;
}

beforeAll(async () => {
  agentId = (
    await prisma.agent.create({
      data: { fullName: `Агент флага номера ${runId}`, phone: `+992979${runId}`, role: "AGENT", passwordHash: "x" },
    })
  ).id;
});

afterAll(async () => {
  await prisma.client.deleteMany({ where: { id: { in: clientIds } } });
  await prisma.agent.deleteMany({ where: { id: agentId } });
});

describe("checkAgentPhoneAsk", () => {
  it("нашёл просьбу о номере — помечает карточку, БЕЗ записи в ленту уведомлений", async () => {
    const client = await makeClient();
    const before = new Date();

    await checkAgentPhoneAsk({
      agentId,
      agentName: "Тест-агент",
      clientId: client.id,
      clientName: client.fullName,
      channel: "text",
      text: "Напишите ваш номер, пожалуйста",
    });

    const updated = await prisma.client.findUnique({ where: { id: client.id } });
    expect(updated?.phoneAskFlaggedAt).not.toBeNull();
    expect(updated!.phoneAskFlaggedAt!.getTime()).toBeGreaterThanOrEqual(before.getTime());
    expect(updated?.phoneAskFlaggedByAgentId).toBe(agentId);

    const notes = await prisma.notification.findMany({ where: { agentId } });
    expect(notes).toHaveLength(0);
  });

  it("обычное сообщение — карточка не меняется", async () => {
    const client = await makeClient();

    await checkAgentPhoneAsk({
      agentId,
      agentName: "Тест-агент",
      clientId: client.id,
      clientName: client.fullName,
      channel: "text",
      text: "Завтра покажу вам квартиру в центре",
    });

    const updated = await prisma.client.findUnique({ where: { id: client.id } });
    expect(updated?.phoneAskFlaggedAt).toBeNull();
  });

  it("без clientId — ничего не делает, не падает", async () => {
    await expect(
      checkAgentPhoneAsk({
        agentId,
        agentName: "Тест-агент",
        clientId: null,
        clientName: null,
        channel: "text",
        text: "Напишите ваш номер",
      })
    ).resolves.toBeUndefined();
  });

  it("повторный вопрос про номер освежает отметку времени", async () => {
    const client = await makeClient();
    await checkAgentPhoneAsk({
      agentId,
      agentName: "Тест-агент",
      clientId: client.id,
      clientName: client.fullName,
      channel: "text",
      text: "Напишите ваш номер",
    });
    const first = await prisma.client.findUnique({ where: { id: client.id } });

    await new Promise((r) => setTimeout(r, 5));
    await checkAgentPhoneAsk({
      agentId,
      agentName: "Тест-агент",
      clientId: client.id,
      clientName: client.fullName,
      channel: "call",
      text: "Какой у вас номер телефона?",
    });
    const second = await prisma.client.findUnique({ where: { id: client.id } });

    expect(second!.phoneAskFlaggedAt!.getTime()).toBeGreaterThan(first!.phoneAskFlaggedAt!.getTime());
  });
});
