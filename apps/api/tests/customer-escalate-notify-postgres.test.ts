/**
 * БОТ ПЕРЕДАЛ РАЗГОВОР ЧЕЛОВЕКУ — ЧЕЛОВЕК ОБ ЭТОМ УЗНАЁТ (14.11.2026).
 *
 * Решение модели `escalate` клиенту ничего не отправляет (lib/customerDmAgentTurn.ts):
 * ход только помечался HELD, и никто из сотрудников не узнавал — клиент просил
 * человека и ждал в тишине. Теперь ответственному агенту (или всем, кто читает
 * все чаты) уходит то же уведомление «Ответьте вручную», что при удержании
 * маршрутизацией, не чаще раза на чат за окно.
 */
import { readFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const { prisma } = await import("../src/db.js");
const { notifyEscalatedCustomerTurn } = await import("../src/lib/customerHeldMessage.js");
const { createTestAgent } = await import("./helpers/ownAgent.js");
const { deleteAgentsWithTraces } = await import("./helpers/cleanupAgents.js");
const { waitFor, waitForSettled } = await import("./helpers/waitFor.js");

const runId = randomUUID().slice(0, 8);
const conversationIds: string[] = [];
const clientIds: string[] = [];
let agentId = "";
const notices = (conversationId: string) => prisma.notification.findMany({ where: { tag: `customer-held-${conversationId}` } });

beforeAll(async () => {
  agentId = await createTestAgent(`Эскалация ${runId}`);
});

afterAll(async () => {
  await prisma.notification.deleteMany({ where: { tag: { in: conversationIds.map(id => `customer-held-${id}`) } } });
  await prisma.processedMessage.deleteMany({ where: { channel: "customer-held-notify",
    messageId: { in: conversationIds.flatMap(id => [0, 1, 2].map(k => `${id}:${Math.floor(Date.now() / 21_600_000) - k}`)) } } });
  await prisma.botConversation.deleteMany({ where: { id: { in: conversationIds } } });
  await prisma.client.deleteMany({ where: { id: { in: clientIds } } });
  await deleteAgentsWithTraces([agentId]);
});

describe("notifyEscalatedCustomerTurn", () => {
  it("the responsible agent gets one push with the customer's words; a repeat in the window is quiet", async () => {
    const client = await prisma.client.create({ data: { fullName: `Клиент эскалации ${runId}`,
      phone: `+992${Math.floor(Math.random() * 900_000_000) + 100_000_000}`, source: "INSTAGRAM", assignedAgentId: agentId } });
    clientIds.push(client.id);
    const chat = await prisma.botConversation.create({ data: { channel: "INSTAGRAM", subscriberId: `esc-${runId}`, messages: [], clientId: client.id },
      select: { id: true } });
    conversationIds.push(chat.id);

    expect(await notifyEscalatedCustomerTurn({ conversationId: chat.id, channel: "INSTAGRAM",
      text: "Я вам написал, никто не отвечает, дайте человека" })).toBe("sent");
    await waitFor(async () => (await notices(chat.id)).length > 0, { label: "уведомление агенту", timeoutMs: 5000 });
    const rows = await waitForSettled(() => notices(chat.id));
    expect(rows.map(row => row.agentId)).toEqual([agentId]);
    expect(rows[0].title).toContain(`Клиент эскалации ${runId}`);
    expect(rows[0].body).toContain("дайте человека");
    expect(rows[0].body).toContain("Бот передал разговор человеку");

    expect(await notifyEscalatedCustomerTurn({ conversationId: chat.id, channel: "INSTAGRAM", text: "Ещё раз: дайте человека" })).toBe("skipped");
  }, 60_000);

  it("a missing chat never throws and calls nobody", async () => {
    expect(await notifyEscalatedCustomerTurn({ conversationId: randomUUID(), channel: "INSTAGRAM", text: "дайте человека" })).toBe("skipped");
  });
});

describe("the DM worker wires escalation to the notification", () => {
  it("customerDmAgentTurn notifies staff on an escalate decision (source guard)", () => {
    const source = readFileSync(new URL("../src/lib/customerDmAgentTurn.ts", import.meta.url), "utf8").replace(/\r\n/g, "\n");
    expect(source, "escalate branch must call notifyEscalatedCustomerTurn")
      .toMatch(/result\.decision\.kind === "escalate"\)\s*\{\s*await notifyEscalatedCustomerTurn\(/u);
  });
});
