// Ревью #193 (15.11.2026): три сценария сбоя сторожа «бот молчит — сразу человеку».
//  193-2: клиента с закреплённым агентом сторож считал «отвеченным» — пуш шёл только через 30 минут и только днём;
//  193-3: при поломке хода сотрудник читал «бот решил, что нужен сотрудник» — неправда;
//  193-4: два списка «намеренного молчания» (мгновенный сторож и сторож через 30 минут) уже расходились.
import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const sendPushToAgent = vi.fn(async () => 1);
vi.mock("../src/push.js", async (importOriginal) => ({ ...(await importOriginal<typeof import("../src/push.js")>()), sendPushToAgent }));

const { prisma } = await import("../src/db.js");
const held = await import("../src/lib/customerHeldMessage.js");
const { reportUnansweredCustomerTurn } = await import("../src/lib/customerTurnSilence.js");
const { CUSTOMER_TURN_INTENDED_SILENCE } = await import("../src/lib/customerIntendedSilence.js");
const { INTENTIONAL_SILENCE_REASONS } = await import("../src/lib/clientWaitingAlert.js");

const runId = Date.now().toString(36);
let agentId = "";
const clientIds: string[] = [];
const convIds: string[] = [];
const eventKeys: string[] = [];

async function heldTurn(withAgent: boolean) {
  const n = convIds.length;
  const client = await prisma.client.create({ data: { fullName: `Клиент сторожа ${runId}-${n}`, phone: `+99290${String(Date.now() + n).slice(-7)}`,
    source: "INSTAGRAM", ...(withAgent ? { assignedAgentId: agentId } : {}) } });
  clientIds.push(client.id);
  const conv = await prisma.botConversation.create({ data: { channel: "INSTAGRAM", subscriberId: `silence-review-${runId}-${n}`, clientId: client.id,
    lastMessageAt: new Date(), messages: [{ role: "user", content: "Есть варианты с ремонтом?", at: new Date().toISOString() }] } });
  convIds.push(conv.id);
  const eventKey = `${runId}${n}`.padEnd(64, "e").slice(0, 64);
  eventKeys.push(eventKey);
  await prisma.customerPropertyIngressTicket.create({ data: { eventKey, scopeKey: `scope-${runId}-${n}`, conversationId: conv.id,
    processingState: "HELD", errorCode: "round_limit", payloadVersion: 1, payloadCiphertext: "test-ciphertext", payloadHash: "c".repeat(64) } });
  return { convId: conv.id, eventKey };
}

beforeAll(async () => {
  agentId = (await prisma.agent.create({ data: { fullName: `Агент сторожа ${runId}`, phone: `+99291${String(Date.now()).slice(-7)}`, role: "AGENT", passwordHash: "x" } })).id;
});
beforeEach(() => { sendPushToAgent.mockClear(); });
afterAll(async () => {
  await prisma.customerPropertyIngressTicket.deleteMany({ where: { eventKey: { in: eventKeys } } });
  await prisma.botConversation.deleteMany({ where: { id: { in: convIds } } });
  await prisma.client.deleteMany({ where: { id: { in: clientIds } } });
  await prisma.agent.delete({ where: { id: agentId } }).catch(() => {});
});

describe("сторож «бот молчит» после ревью", () => {
  it("193-2: клиент с закреплённым агентом — агент получает пуш сразу, а не через 30 минут", async () => {
    const { convId, eventKey } = await heldTurn(true);
    await reportUnansweredCustomerTurn(eventKey, "round_limit");
    await vi.waitFor(() => expect(sendPushToAgent.mock.calls.some(([id, p]) => id === agentId && (p as { tag?: string }).tag === `client-waiting-${convId}`)).toBe(true));
  });

  it("193-3: поломка хода — в пуше правдивая причина, не «бот решил»", async () => {
    const { convId, eventKey } = await heldTurn(true);
    await reportUnansweredCustomerTurn(eventKey, "round_limit");
    await vi.waitFor(() => expect(sendPushToAgent.mock.calls.some(([, p]) => (p as { tag?: string }).tag === `client-waiting-${convId}`)).toBe(true));
    const body = (sendPushToAgent.mock.calls.find(([, p]) => (p as { tag?: string }).tag === `client-waiting-${convId}`)![1] as { body: string }).body;
    expect(body).not.toContain("бот решил");
    expect(body).toContain("не уложился");
    expect(body).not.toContain("round_limit");
  });

  it("193-3: модель сама решила позвать сотрудника — так и написано", async () => {
    const { convId } = await heldTurn(false);
    await held.notifyUnansweredCustomerTurn({ reason: "staff_or_supported_reply_required", channel: "INSTAGRAM", peer: "p", conversationId: convId, excerpt: "x" });
    // Без агента — очередь тревог руководству; проверяем текст там.
    const alert = await prisma.pendingDirectorAlert.findFirst({ where: { tag: `client-waiting-${convId}` } });
    expect(alert?.body ?? "").toContain("бот решил");
    await prisma.pendingDirectorAlert.deleteMany({ where: { tag: `client-waiting-${convId}` } });
  });

  it("193-4: один список намеренного молчания на оба сторожа, второго нет", () => {
    expect([...INTENTIONAL_SILENCE_REASONS].sort()).toEqual([...CUSTOMER_TURN_INTENDED_SILENCE].sort());
    const src = path.join(__dirname, "../src");
    const walk = (dir: string): string[] => readdirSync(dir).flatMap(f => {
      const p = path.join(dir, f);
      return statSync(p).isDirectory() ? (f === "generated" ? [] : walk(p)) : p.endsWith(".ts") ? [p] : [];
    });
    const lists = walk(src).filter(p => { const t = readFileSync(p, "utf8"); return t.includes('"foreign_share_no_reply"') && t.includes('"attachment_question_repeat_no_reply"'); })
      .map(p => path.relative(src, p).split(path.sep).join("/")).sort();
    // customerAgentCore — место, где ядро эти коды ставит; список — только customerIntendedSilence.
    expect(lists).toEqual(["ai/customerAgentCore.ts", "lib/customerIntendedSilence.ts"]);
  });
});
