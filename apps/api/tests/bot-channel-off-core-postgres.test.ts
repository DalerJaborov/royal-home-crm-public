import { afterAll, afterEach, beforeAll, expect, it, vi } from "vitest";
import { prisma } from "../src/db.js";
import { createCustomerCoreGoldenFixture } from "./helpers/customerCoreGoldenFixture.js";
import { consumeCustomerInboxTicket } from "../src/lib/customerIngressProducer.js";
import * as turnSilence from "../src/lib/customerTurnSilence.js";
import * as dmTurn from "../src/lib/customerDmAgentTurn.js";

// Meta DMs of the new core (Instagram) and the emergency kill switch CUSTOMER_AGENT_CHANNEL_OFF (lib/customerAgentChannelOff.ts):
// real signed intake / ticket / outbox; only the model and the Meta send are fixtures. A switched-off channel never starts the
// core turn: no model request, no outbox part, the ticket is HELD `customer_channel_off`, and the one «unanswered turn» door
// tells a person. Another channel in the list changes nothing. The core turn itself is a spy in the «not switched off»
// cases: what is tested here is the door in front of it, not the core (its own suites cover it).
let f: Awaited<ReturnType<typeof createCustomerCoreGoldenFixture>>;
beforeAll(async () => { f = await createCustomerCoreGoldenFixture(); });
afterEach(() => { vi.unstubAllEnvs(); vi.restoreAllMocks(); f?.assertIoClean(); });
afterAll(async () => { await f?.cleanup(); });

it("instagram switched off: no core turn, no model call, nothing to send; HELD with its reason and a person is told", async () => {
  vi.stubEnv("CUSTOMER_AGENT_CHANNEL_OFF", "instagram");
  const report = vi.spyOn(turnSilence, "reportUnansweredCustomerTurn").mockResolvedValue(undefined);
  const owner = await f.owner();
  const eventKey = await f.capture(owner, "Подскажите по ипотеке для семьи");
  const bodies = f.bodies.length, sent = f.physical.length;
  expect(await consumeCustomerInboxTicket(eventKey)).toEqual({ status: "held", reason: "customer_channel_off" });
  expect(f.bodies.length).toBe(bodies);
  expect(f.physical.length).toBe(sent);
  expect(await prisma.customerOutboxPart.count({ where: { ticketEventKey: eventKey } })).toBe(0);
  expect(await prisma.customerPropertyIngressTicket.findUniqueOrThrow({ where: { eventKey }, select: { processingState: true, errorCode: true } }))
    .toEqual({ processingState: "HELD", errorCode: "customer_channel_off" });
  expect(report).toHaveBeenCalledTimes(1);
  expect(report).toHaveBeenCalledWith(eventKey, "customer_channel_off");
});

for (const value of ["", "whatsapp,facebook,website,telegram,telegram_direct,youtube,instagrm"]) {
  it(`CUSTOMER_AGENT_CHANNEL_OFF=${JSON.stringify(value)}: the Instagram ticket goes to the core turn exactly as before`, async () => {
    vi.stubEnv("CUSTOMER_AGENT_CHANNEL_OFF", value);
    const core = vi.spyOn(dmTurn, "runCustomerDmAgentTurn").mockResolvedValue({ status: "unchanged", reason: "fixture" });
    const report = vi.spyOn(turnSilence, "reportUnansweredCustomerTurn").mockResolvedValue(undefined);
    const owner = await f.owner();
    const eventKey = await f.capture(owner, "Какие у вас есть районы?");
    expect(await consumeCustomerInboxTicket(eventKey)).toEqual({ status: "unchanged", reason: "fixture" });
    expect(core).toHaveBeenCalledWith(eventKey);
    expect(report).not.toHaveBeenCalled();
    expect((await prisma.customerPropertyIngressTicket.findUniqueOrThrow({ where: { eventKey }, select: { errorCode: true } })).errorCode)
      .not.toBe("customer_channel_off");
  });
}

it("`arvan`: a Royal Home Instagram ticket goes to the core; the same account with a brand name (Arvan) is held", async () => {
  vi.stubEnv("CUSTOMER_AGENT_CHANNEL_OFF", "arvan");
  const core = vi.spyOn(dmTurn, "runCustomerDmAgentTurn").mockResolvedValue({ status: "unchanged", reason: "fixture" });
  const report = vi.spyOn(turnSilence, "reportUnansweredCustomerTurn").mockResolvedValue(undefined);
  const owner = await f.owner();
  const royal = await f.capture(owner, "Какие у вас есть районы?");
  expect(await consumeCustomerInboxTicket(royal)).toEqual({ status: "unchanged", reason: "fixture" });
  expect(core).toHaveBeenCalledWith(royal);
  await prisma.messengerAccount.update({ where: { id: owner.id }, data: { brandName: "Arvan" } });
  const arvan = await f.capture(owner, "Салом, нархаш чанд?");
  expect(await consumeCustomerInboxTicket(arvan)).toEqual({ status: "held", reason: "customer_channel_off" });
  expect(core).not.toHaveBeenCalledWith(arvan);
  expect(report).toHaveBeenCalledWith(arvan, "customer_channel_off");
});

it("`all`: the Instagram ticket is held too", async () => {
  vi.stubEnv("CUSTOMER_AGENT_CHANNEL_OFF", "all");
  const core = vi.spyOn(dmTurn, "runCustomerDmAgentTurn");
  vi.spyOn(turnSilence, "reportUnansweredCustomerTurn").mockResolvedValue(undefined);
  const owner = await f.owner();
  const eventKey = await f.capture(owner, "Салом");
  expect(await consumeCustomerInboxTicket(eventKey)).toEqual({ status: "held", reason: "customer_channel_off" });
  expect(core).not.toHaveBeenCalled();
});
