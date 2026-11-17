import { afterAll, afterEach, beforeAll, expect, it, vi } from "vitest";
import { prisma } from "../src/db.js";
import { createCustomerCoreGoldenFixture, reply } from "./helpers/customerCoreGoldenFixture.js";
import { consumeCustomerInboxTicket } from "../src/lib/customerIngressProducer.js";
import { resumeDeferredCustomerInbox } from "../src/lib/customerDeferredInput.js";
import * as verifiedContext from "../src/lib/customerAgentVerifiedContext.js";

// F12 on a real database: an input put aside because a newer one arrived must never end without an answer.
// Real signed intake / FINAL / principal / outbox; only the model and the Meta send are fixtures.
let f: Awaited<ReturnType<typeof createCustomerCoreGoldenFixture>>;
beforeAll(async () => { f = await createCustomerCoreGoldenFixture(); });
afterEach(() => { vi.restoreAllMocks(); f?.assertIoClean(); });
afterAll(async () => { await f?.cleanup(); });
const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
/** B ends WITHOUT an answer after its FINAL acceptance but before any paid model reservation (its provider operation stays open). */
const failEarly = () => vi.spyOn(verifiedContext, "loadCustomerAgentVerifiedDmContext").mockResolvedValueOnce({ status: "held", reason: "storage_unavailable" });
const job = (dedupeKey: string) => prisma.backgroundJob.findUnique({ where: { dedupeKey } });
/** What the queue worker does after a deferred run: the job is examined and finished. */
const queueExamined = (eventKey: string) => prisma.backgroundJob.updateMany({ where: { dedupeKey: `customer-inbox-consume:${eventKey}` },
  data: { status: "DONE" } });
/** The customer's words of the turn whose FIRST generation is bodies[from] (later rounds are protocol corrections). */
const turnUserText = (from: number) => {
  const body = f.bodies[from] as { contents: Array<{ role: string; parts: Array<{ text?: string }> }> };
  return body.contents.filter(entry => entry.role === "user").at(-1)?.parts.map(part => part.text ?? "").join("") ?? "";
};

it("B ends HELD BEFORE its acceptance: A is still the last accepted input, is re-armed and answered itself", async () => {
  const owner = await f.owner();
  const a = await f.capture(owner, "Подскажите по ипотеке для семьи");
  const b = await f.capture(owner, "Какие у вас есть районы?");
  expect(await consumeCustomerInboxTicket(a)).toEqual({ status: "held", reason: "newer_input_pending" });
  await queueExamined(a);
  // B ends early (never accepted) - the one hold we cannot provoke through the real worker without a fault in the intake.
  await prisma.$executeRaw`UPDATE "CustomerPropertyIngressTicket" SET "processingState"='HELD',"errorCode"='scope_blocked' WHERE "eventKey"=${b}`;
  expect(await resumeDeferredCustomerInbox(b)).toBe(a);
  expect((await job(`customer-inbox-consume:${a}`))?.status).toBe("PENDING");
  f.script([[reply([], "property")]]);
  const delivered = await f.deliver(a);
  expect(delivered.text).toBeTruthy();
  expect(await resumeDeferredCustomerInbox(b)).toBeNull(); // A is answered now: nothing left to re-arm
});

it("B ends HELD AFTER its acceptance (older A is permanently stale): B is re-run ONCE with A's words and answers both", async () => {
  const owner = await f.owner();
  const a = await f.capture(owner, "Подскажите по ипотеке для семьи");
  const b = await f.capture(owner, "Какие у вас есть районы?");
  expect(await consumeCustomerInboxTicket(a)).toEqual({ status: "held", reason: "newer_input_pending" });
  await queueExamined(a);

  // B is accepted (FINAL), then ends without an answer: HELD. A can no longer run by itself (a late original never
  // adopts a newer accepted one), so B itself is re-armed once, under its own resume key, a little later.
  failEarly();
  expect(await consumeCustomerInboxTicket(b)).toEqual({ status: "held", reason: "storage_unavailable" });
  expect(await prisma.customerOutboxPart.count({ where: { ticketEventKey: b } })).toBe(0);
  const resume = await job(`customer-inbox-resume:${b}`);
  expect(resume).toMatchObject({ type: "customer-inbox-consume", status: "PENDING", attempts: 0 });
  expect(resume!.runAt.getTime()).toBeGreaterThan(Date.now());
  expect(await prisma.customerPropertyIngressTicket.findUniqueOrThrow({ where: { eventKey: a }, select: { processingState: true, errorCode: true } }))
    .toEqual({ processingState: "HELD", errorCode: "newer_input_resumed" });

  // The resumed run (what the queue worker does) answers the customer once, A and B together.
  f.script([[reply([], "property")]]);
  const before = f.physical.length, bodiesBefore = f.bodies.length;
  const delivered = await f.deliver(b);
  expect(turnUserText(bodiesBefore)).toBe("Подскажите по ипотеке для семьи\nКакие у вас есть районы?");
  expect(f.physical.slice(before)).toEqual([delivered.text]);
  expect(await prisma.customerOutboxPart.count({ where: { ticketEventKey: a } })).toBe(0);
  expect(await consumeCustomerInboxTicket(a)).toEqual({ status: "held", reason: "original_final_stale" });
});

it("a resumed B that fails again re-arms nothing (no loop)", async () => {
  const owner = await f.owner();
  const a = await f.capture(owner, "Хочу продать квартиру");
  const b = await f.capture(owner, "Двухкомнатная, центр");
  expect(await consumeCustomerInboxTicket(a)).toEqual({ status: "held", reason: "newer_input_pending" });
  await queueExamined(a);
  failEarly();
  expect(await consumeCustomerInboxTicket(b)).toEqual({ status: "held", reason: "storage_unavailable" });
  expect((await job(`customer-inbox-resume:${b}`))?.status).toBe("PENDING");
  await prisma.backgroundJob.update({ where: { dedupeKey: `customer-inbox-resume:${b}` }, data: { status: "DONE" } });
  // the second run of B fails the same way: nothing is re-armed any more
  failEarly();
  expect(await consumeCustomerInboxTicket(b)).toEqual({ status: "held", reason: "storage_unavailable" });
  expect((await job(`customer-inbox-resume:${b}`))?.status).toBe("DONE");
  expect(await resumeDeferredCustomerInbox(b)).toBeNull();
  expect(await prisma.customerOutboxPart.count({ where: { ticketEventKey: b } })).toBe(0);
});

it("A and B a second apart produce ONE answer, and it takes A's question into account", async () => {
  const owner = await f.owner();
  const before = f.physical.length;
  const a = await f.capture(owner, "Сколько стоит трёхкомнатная в центре");
  await sleep(1000);
  const b = await f.capture(owner, "И есть ли вариант с ремонтом");
  expect(await consumeCustomerInboxTicket(a)).toEqual({ status: "held", reason: "newer_input_pending" });
  await queueExamined(a);

  f.script([[reply([], "property")]]);
  const bodiesBefore = f.bodies.length;
  const delivered = await f.deliver(b);
  // the model saw A before B, as the customer's current words
  expect(turnUserText(bodiesBefore)).toBe("Сколько стоит трёхкомнатная в центре\nИ есть ли вариант с ремонтом");
  expect(f.physical.slice(before)).toEqual([delivered.text]);

  // A stays unanswered by itself: B's answer already covers it and a re-run never sends a second message.
  expect(await consumeCustomerInboxTicket(a)).toMatchObject({ status: "held" });
  expect(await prisma.customerOutboxPart.count({ where: { ticketEventKey: a } })).toBe(0);
  expect(f.physical.slice(before)).toEqual([delivered.text]);
  // and B's PLANNED answer is a barrier: the resume never re-arms A afterwards.
  expect(await resumeDeferredCustomerInbox(b)).toBeNull();
  expect((await job(`customer-inbox-consume:${a}`))?.status).toBe("DONE");
});
