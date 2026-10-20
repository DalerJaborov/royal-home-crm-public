import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
vi.mock("../src/loadEnv.js", () => ({}));
vi.mock("../src/lib/livePublish.js", async (importOriginal) => ({ ...(await importOriginal<typeof import("../src/lib/livePublish.js")>()), publishMessageNew: vi.fn(async () => {}) }));
import { prisma } from "../src/db.js";
import { admitCustomerPropertyInput, customerPropertyInputAlreadyManaged, verifyCustomerPropertyAdmission } from "../src/lib/customerPropertyAdmission.js";
import { managedCustomerPropertyReply, persistManagedCustomerPropertyReply, publishManagedCustomerPropertyReply } from "../src/lib/customerPropertyDelivery.js";
import { prepareCustomerPropertyAdmission, customerPropertyTurnAlreadyManaged } from "../src/lib/customerPropertyTurnContext.js";
import { processMessengerTurn } from "../src/messengers/conversation.js";
import { loadWebsiteChatMessages } from "../src/messengers/websiteChat.js";
import type { CustomerPropertyAdmission, CustomerPropertyAdmissionResult } from "@royal-home/shared";

const tag = `p03-fence-${randomUUID()}`; const peers: string[] = [];
const result = (ticket: CustomerPropertyAdmission): CustomerPropertyAdmissionResult => ({ status: "admitted", ticket });
async function input(peer?: string, mid = randomUUID()) {
  const target = peer ?? `p03-${randomUUID()}`; if (!peers.includes(target)) peers.push(target);
  const admission = await admitCustomerPropertyInput({ channel: "WEBSITE", peer: target, eventKind: "website_message", eventId: mid, evidence: [] });
  expect(admission.status).toBe("admitted"); if (admission.status !== "admitted") throw new Error(admission.reason);
  return { ticket: admission.ticket, mid, peer: target };
}
function part(item: Awaited<ReturnType<typeof input>>, text = "Уточните номер объекта.") {
  return managedCustomerPropertyReply({ id: item.ticket.conversationId, channel: "WEBSITE", subscriberId: item.peer, accountId: null }, null, text, result(item.ticket));
}
beforeAll(async () => {
  const url = new URL(process.env.DATABASE_URL ?? "");
  if (process.env.CUSTOMER_CONTEXT_TEST_DATABASE) { expect(url.hostname).toBe("localhost"); expect(url.port).toBe("15500"); expect(url.pathname).toBe(`/${process.env.CUSTOMER_CONTEXT_TEST_DATABASE}`); }
  const [current] = await prisma.$queryRaw<{ name: string }[]>`SELECT current_database() AS name`; expect(current.name).toBe(url.pathname.slice(1));
  vi.stubGlobal("fetch", vi.fn(async () => { throw new Error("No external calls allowed in this gate"); }));
  vi.stubEnv("BOT_TURN_TRACE_ENABLED", "0");
});
afterEach(() => { vi.restoreAllMocks(); });
afterAll(async () => { await prisma.botConversation.deleteMany({ where: { channel: "WEBSITE", subscriberId: { in: peers } } }); await prisma.$disconnect(); vi.unstubAllGlobals(); vi.unstubAllEnvs(); });

describe("real PostgreSQL fact-only output fence and website cursor", () => {
  it("concurrent producers record exactly one part and atomically fence all captured stable inputs", async () => {
    const a = await input(); const b = await input(a.peer);
    const batch = [result(a.ticket), result(b.ticket)];
    const recorded = await Promise.all([persistManagedCustomerPropertyReply(part(b), batch), persistManagedCustomerPropertyReply(part(b), batch)]);
    expect(recorded.sort()).toEqual([false, true]);
    const row = await prisma.botConversation.findUniqueOrThrow({ where: { id: a.ticket.conversationId } }); expect(row.messages).toHaveLength(1);
    const tickets = await prisma.customerPropertyIngressTicket.findMany({ where: { eventKey: { in: [a.ticket.eventKey, b.ticket.eventKey] } } });
    expect(tickets.every((ticket) => !!ticket.managedOutputRecordedAt)).toBe(true);
    expect((await verifyCustomerPropertyAdmission(a.ticket))).toEqual({ status: "denied", reason: "already_managed" });
  });
  it("history trimming/dedupe expiry/flag OFF do not reopen either captured event", async () => {
    const a = await input(undefined, `${tag}-A`); const b = await input(a.peer, `${tag}-B`);
    expect(await persistManagedCustomerPropertyReply(part(b), [result(a.ticket), result(b.ticket)])).toBe(true);
    const dedupe = await prisma.processedMessage.create({ data: { channel: "WEBSITE", messageId: a.mid } });
    await prisma.processedMessage.delete({ where: { id: dedupe.id } });
    await prisma.botConversation.update({ where: { id: a.ticket.conversationId }, data: { messages: Array.from({ length: 40 }, (_, n) => ({ role: n % 2 ? "assistant" : "user", content: `trim-${n}` })) } });
    vi.stubEnv("BOT_PROPERTY_CONTEXT_ENABLED", "0");
    const before = await prisma.$queryRaw<{ last_value: bigint }[]>`SELECT last_value FROM "CustomerPropertyIngressTicket_order_seq"`;
    for (const item of [a, b]) {
      expect(await customerPropertyInputAlreadyManaged({ channel: "WEBSITE", peer: item.peer, eventKind: "website_message", eventId: item.mid })).toBe(true);
      const answer = await processMessengerTurn({ channel: "WEBSITE", subscriberId: item.peer, text: "цена?", messageId: item.mid, customerPropertyEventKind: "website_message" });
      expect(answer).toMatchObject({ shouldReply: false, reply: "" });
    }
    expect(await prisma.$queryRaw`SELECT last_value FROM "CustomerPropertyIngressTicket_order_seq"`).toEqual(before);
    expect(fetch).not.toHaveBeenCalled();
    expect(await customerPropertyInputAlreadyManaged({ channel: "WEBSITE", peer: a.peer, eventKind: "website_message", eventId: `${tag}-NEW` })).toBe(false);
  });
  it("a recorded duplicate in a partial batch cannot swallow fresh B", async () => {
    const a = await input(); expect(await persistManagedCustomerPropertyReply(part(a), [result(a.ticket)])).toBe(true);
    const b = await input(a.peer); expect(await persistManagedCustomerPropertyReply(part(b), [result(a.ticket), result(b.ticket)])).toBe(true);
    expect(await prisma.customerPropertyIngressTicket.findUniqueOrThrow({ where: { eventKey: b.ticket.eventKey } })).toMatchObject({ managedOutputRecordedAt: expect.any(Date) });
    const row = await prisma.botConversation.findUniqueOrThrow({ where: { id: b.ticket.conversationId } }); expect(row.messages).toHaveLength(2);
  });
  it("cross-scope/missing tickets roll back the append and every output marker", async () => {
    const a = await input(); const b = await input();
    await expect(persistManagedCustomerPropertyReply(part(a), [result(a.ticket), result(b.ticket)])).rejects.toThrow("scope mismatch");
    const row = await prisma.botConversation.findUniqueOrThrow({ where: { id: a.ticket.conversationId } }); expect(row.messages).toEqual([]);
    expect((await prisma.customerPropertyIngressTicket.findUniqueOrThrow({ where: { eventKey: a.ticket.eventKey } })).managedOutputRecordedAt).toBeNull();
  });
  it("marker count mismatch rolls back the already executed pending append", async () => {
    const a = await input(); const original = prisma.$transaction.bind(prisma);
    const spy = vi.spyOn(prisma, "$transaction").mockImplementation(((fn: (tx: unknown) => Promise<unknown>) => original(async (tx) => fn(new Proxy(tx, { get(object, key) {
      if (key === "customerPropertyIngressTicket") return new Proxy(Reflect.get(object, key), { get(delegate, name) {
        if (name === "updateMany") return async () => ({ count: 0 }); const value = Reflect.get(delegate, name); return typeof value === "function" ? value.bind(delegate) : value;
      } });
      const value = Reflect.get(object, key); return typeof value === "function" ? value.bind(object) : value;
    } })))) as typeof prisma.$transaction);
    try { await expect(persistManagedCustomerPropertyReply(part(a), [result(a.ticket)])).rejects.toThrow("fence not committed"); }
    finally { spy.mockRestore(); }
    expect((await prisma.botConversation.findUniqueOrThrow({ where: { id: a.ticket.conversationId } })).messages).toEqual([]);
    expect((await prisma.customerPropertyIngressTicket.findUniqueOrThrow({ where: { eventKey: a.ticket.eventKey } })).managedOutputRecordedAt).toBeNull();
    expect(await persistManagedCustomerPropertyReply(part(a), [result(a.ticket)])).toBe(true);
  });
  it("failed pending append leaves no marker and permits a later controlled attempt", async () => {
    const a = await input(); const original = prisma.$transaction.bind(prisma);
    const spy = vi.spyOn(prisma, "$transaction").mockImplementation(((fn: (tx: unknown) => Promise<unknown>) => original(async (tx) => fn(new Proxy(tx, { get(object, key) {
      if (key === "$executeRaw") return async () => { throw new Error("fictional append interruption"); };
      const value = Reflect.get(object, key); return typeof value === "function" ? value.bind(object) : value;
    } })))) as typeof prisma.$transaction);
    try { await expect(persistManagedCustomerPropertyReply(part(a), [result(a.ticket)])).rejects.toThrow("append interruption"); }
    finally { spy.mockRestore(); }
    expect((await prisma.botConversation.findUniqueOrThrow({ where: { id: a.ticket.conversationId } })).messages).toEqual([]);
    expect((await prisma.customerPropertyIngressTicket.findUniqueOrThrow({ where: { eventKey: a.ticket.eventKey } })).managedOutputRecordedAt).toBeNull();
    expect(await persistManagedCustomerPropertyReply(part(a), [result(a.ticket)])).toBe(true);
  });
  it("captured evidence and denied entries survive crash before focus persistence", async () => {
    vi.stubEnv("BOT_PROPERTY_CONTEXT_ENABLED", "1");
    const a = await input(); const b = await input(a.peer);
    const batch: CustomerPropertyAdmissionResult[] = [result(a.ticket), result(b.ticket), { status: "denied", reason: "missing_identity" }];
    await prisma.botConversation.update({ where: { id: b.ticket.conversationId }, data: { messages: [{ role: "user", content: "A+B цена?", customerPropertyAdmission: b.ticket, customerPropertyBatch: batch }] } });
    const restored = await prepareCustomerPropertyAdmission({ channel: "WEBSITE", subscriberId: b.peer, text: "A+B цена?", skipSaveIncoming: true });
    expect(restored.admission).toEqual({ status: "denied", reason: "missing_identity" });
    expect(restored.batch).toEqual(batch);
    expect(await customerPropertyTurnAlreadyManaged({ channel: "WEBSITE", subscriberId: b.peer, text: "A+B цена?", skipSaveIncoming: true })).toBe(false);
  });
  it("publication waits for lock and advances beyond an IN written while waiting, in cursor order", async () => {
    const a = await input(); const pending = part(a); expect(await persistManagedCustomerPropertyReply(pending, [result(a.ticket)])).toBe(true);
    let unlock!: () => void; let locked!: () => void;
    const gate = new Promise<void>((resolve) => { unlock = resolve; }); const ready = new Promise<void>((resolve) => { locked = resolve; });
    const incomingAt = "2031-01-01T00:00:00.000Z";
    const writer = prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT "id" FROM "BotConversation" WHERE "id" = ${a.ticket.conversationId} FOR UPDATE`;
      locked(); await gate;
      await tx.$executeRaw`UPDATE "BotConversation" SET "messages" = "messages" || ${JSON.stringify([null, { role: "user", content: "новый вопрос", at: incomingAt }])}::jsonb WHERE "id" = ${a.ticket.conversationId}`;
    });
    await ready; const publication = publishManagedCustomerPropertyReply(pending);
    try {
      let observed = false;
      for (let n = 0; n < 50; n++) {
        const [waits] = await prisma.$queryRaw<{ count: number }[]>`SELECT COUNT(*)::int AS count FROM pg_stat_activity WHERE datname=current_database() AND wait_event_type='Lock'`;
        if (waits.count > 0) { observed = true; break; }
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      expect(observed).toBe(true); unlock(); await writer; expect(await publication).toBe("accepted");
    } finally { unlock(); await writer; await publication; }
    const all = await loadWebsiteChatMessages(a.peer);
    expect(all.messages.map((message) => message.role)).toEqual(["user", "assistant"]);
    const after = await loadWebsiteChatMessages(a.peer, incomingAt); expect(after.messages).toHaveLength(1);
    expect(Date.parse(after.messages[0].at!)).toBeGreaterThan(Date.parse(incomingAt));
    expect((await loadWebsiteChatMessages(a.peer, after.messages[0].at!)).messages).toEqual([]);
  });
});
