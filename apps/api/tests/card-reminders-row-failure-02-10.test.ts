import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

/**
 * E8 глубокой проверки 02.10.2026 (класс №173): напоминания о незаполненной
 * карточке шли одним циклом без try на запись. Сбой отправки на одной карточке
 * обрывал напоминания всем остальным, а отметка «напомнили» ставилась ПОСЛЕ
 * пуша — у успевших уйти её не было, и следующий тик слал им повтор.
 *
 * Первая отправка падает, кому бы она ни шла.
 */

let calls = 0;
const sendPushToAgent = vi.fn(async () => {
  calls++;
  if (calls === 1) throw new Error("нарочный сбой отправки");
  return 1;
});
vi.mock("../src/push.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/push.js")>()),
  sendPushToAgent,
}));

const { prisma } = await import("../src/db.js");
const { remindIncompleteCards } = await import("../src/lib/cardReminders.js");

const runId = Date.now();
let agentId: string;
const clientIds: string[] = [];

beforeAll(async () => {
  agentId = (
    await prisma.agent.create({
      data: { fullName: `Агент карточек сбой ${runId}`, phone: `+992931${runId}`, role: "AGENT", passwordHash: "x" },
    })
  ).id;
  const accepted = new Date(Date.now() - 2 * 3_600_000);
  for (let i = 0; i < 2; i++) {
    const c = await prisma.client.create({
      data: {
        fullName: `Карточка сбой ${runId}-${i}`,
        phone: `+99293${i}${runId}`,
        source: "PHONE_CALL",
        assignedAgentId: agentId,
        acceptedAt: accepted,
        lastContactAt: accepted,
      },
    });
    clientIds.push(c.id);
  }
});

afterAll(async () => {
  await prisma.client.deleteMany({ where: { id: { in: clientIds } } });
  await prisma.agent.deleteMany({ where: { id: agentId } });
  await prisma.$disconnect();
});

describe("напоминание о карточке: сбой на одной не обрывает остальные", () => {
  it("обе карточки отмечены «напомнили», хотя первая отправка упала", async () => {
    await remindIncompleteCards().catch(() => {});
    const rows = await prisma.client.findMany({ where: { id: { in: clientIds } }, select: { cardReminderSentAt: true } });
    expect(rows.every((r) => r.cardReminderSentAt !== null)).toBe(true);
  });
});
