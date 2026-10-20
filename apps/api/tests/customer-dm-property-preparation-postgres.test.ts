import { afterAll, afterEach, beforeAll, expect, it, vi } from "vitest";
import { prisma } from "../src/db.js";
import { prepareCustomerDmInboxCoreContext } from "../src/lib/customerDmCoreContext.js";
import { consumeCustomerInboxTicket } from "../src/lib/customerIngressProducer.js";
import { revalidateCustomerPrincipal } from "../src/lib/customerPrincipal.js";
import { loadAcceptedCustomerState } from "../src/lib/customerState.js";
import { customerPropertyRegistry } from "../src/lib/customerPropertyRegistry.js";
import { createCustomerCoreGoldenFixture, reply } from "./helpers/customerCoreGoldenFixture.js";

// Actual PG/HMAC/P03/canonical/principal/Core/P12 boundaries. The selector spy
// only injects a real concurrent IN or native staff pause; no proof is mocked.
let f: Awaited<ReturnType<typeof createCustomerCoreGoldenFixture>>;
beforeAll(async () => { f = await createCustomerCoreGoldenFixture(); });
afterEach(() => { vi.restoreAllMocks(); f?.assertIoClean(); });
afterAll(async () => { await f?.cleanup(); });

it("resolves original owned focus before minting a current principal, then actual Core/P12 answers its price", async () => {
  const owner = await f.owner(), { property } = await f.publicCard();
  const event = await f.capture(owner, `Какая цена объекта №${property.shortId}?`);
  const prepared = await prepareCustomerDmInboxCoreContext(event);
  expect(prepared.status, JSON.stringify(prepared)).toBe("prepared");
  if (prepared.status !== "prepared") throw new Error("Actual preparation held");
  expect(prepared.focus?.snapshot.focus).toMatchObject({ status: "resolved", propertyId: property.id });
  expect(await revalidateCustomerPrincipal(prepared.lane.principal)).toMatchObject({ status: "current" });
  const current = await loadAcceptedCustomerState(prepared.lane.ticket);
  expect(prepared.lane.principal.authority.fence).toEqual(current?.fence);
  const original = await prisma.customerPropertyIngressTicket.findUniqueOrThrow({ where: { eventKey: event } });
  f.script([[reply(["e0"])]]);
  const delivered = await f.deliver(event);
  expect(delivered.text).toContain(`Цена объекта №${property.shortId}: 500 000 сомони.`);
  const after = await prisma.customerPropertyIngressTicket.findUniqueOrThrow({ where: { eventKey: event } });
  expect(after.order).toBe(original.order); expect(after.receivedAt).toEqual(original.receivedAt);
  expect(after.originCiphertext).toBe(original.originCiphertext); expect(after.originCapturedAt).toEqual(original.originCapturedAt);
  expect(f.counts().generated).toBeGreaterThan(0);
});

it("new genuine IN B during original A selector await prevents A principal/model/OUT adoption", async () => {
  const owner = await f.owner(), { property } = await f.publicCard();
  const a = await f.capture(owner, `Какая цена объекта №${property.shortId}?`), actualSelector = customerPropertyRegistry.selector;
  let b: string | undefined, bStatus: string | undefined; const before = f.counts();
  vi.spyOn(customerPropertyRegistry, "selector").mockImplementationOnce(async reference => {
    b = await f.capture(owner, "Сейчас хочу узнать об аренде");
    const acceptedB = await prepareCustomerDmInboxCoreContext(b); bStatus = acceptedB.status;
    return actualSelector(reference);
  });
  expect(await consumeCustomerInboxTicket(a)).toMatchObject({ status: "held" });
  expect(b).toBeTruthy(); expect(bStatus).toBe("prepared"); expect(f.counts()).toEqual(before);
  const ticketA = await prisma.customerPropertyIngressTicket.findUniqueOrThrow({ where: { eventKey: a } });
  const inquiry = await prisma.customerInquiry.findUniqueOrThrow({ where: { conversationId: ticketA.conversationId! } });
  expect(inquiry.lastAcceptedEventKey).toBe(b);
  expect(await prisma.customerOutboxPart.count({ where: { ticketEventKey: a } })).toBe(0);
  expect(ticketA.providerOperationId).toBeNull();
});

it("actual native staff pause during original selector await cannot be adopted as a fresh BOT controller", async () => {
  const owner = await f.owner(), { property } = await f.publicCard();
  const event = await f.capture(owner, `Какая цена объекта №${property.shortId}?`), actualSelector = customerPropertyRegistry.selector;
  const before = f.counts(), until = new Date(Date.now() + 60_000); let pauseApplied = false;
  vi.spyOn(customerPropertyRegistry, "selector").mockImplementationOnce(async reference => {
    const ticket = await prisma.customerPropertyIngressTicket.findUniqueOrThrow({ where: { eventKey: event } });
    expect(ticket.conversationId).toBeTruthy();
    await prisma.botConversation.update({ where: { id: ticket.conversationId! }, data: { pausedUntil: until } });
    pauseApplied = true;
    return actualSelector(reference);
  });
  expect(await consumeCustomerInboxTicket(event)).toMatchObject({ status: "held" });
  expect(pauseApplied).toBe(true); expect(f.counts()).toEqual(before);
  const ticket = await prisma.customerPropertyIngressTicket.findUniqueOrThrow({ where: { eventKey: event } });
  expect((await prisma.botConversation.findUniqueOrThrow({ where: { id: ticket.conversationId! } })).pausedUntil).toEqual(until);
  expect(ticket.providerOperationId).toBeNull();
  expect(await prisma.customerOutboxPart.count({ where: { ticketEventKey: event } })).toBe(0);
});
