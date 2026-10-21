import { afterAll, afterEach, beforeAll, expect, it, vi } from "vitest";
import { prisma } from "../src/db.js";
import { decryptCustomerFinalOrigin } from "../src/lib/customerOriginPayload.js";
import { createCustomerCoreGoldenFixture, reply } from "./helpers/customerCoreGoldenFixture.js";

// Genuine global-HMAC public envelope and real PG/Core/tool/outbox boundaries.
// Public property reads do not upgrade this input to a protected namespace.
let f: Awaited<ReturnType<typeof createCustomerCoreGoldenFixture>>;
beforeAll(async () => {
  f = await createCustomerCoreGoldenFixture({ publicEnvelope: true });
  vi.stubEnv("BOT_PROPERTY_CONTEXT_ENABLED", "0");
});
afterEach(() => f?.assertIoClean());
afterAll(async () => { await f?.cleanup(); });

it("reads availability of an explicitly selected public card without private-memory or write assurance", async () => {
  const owner = await f.owner(), { property } = await f.publicCard();
  const event = await f.capture(owner, `Объект №${property.shortId} ещё есть?`);
  f.script([[reply(["e0"])]]);
  const delivered = await f.deliver(event);
  expect(delivered.text).toBe(`Да, объект №${property.shortId} ещё доступен.`);
  const ticket = await prisma.customerPropertyIngressTicket.findUniqueOrThrow({ where: { eventKey: event } });
  expect(decryptCustomerFinalOrigin(ticket.originCiphertext!).input.assurance).toBe("public_envelope");
  expect(await prisma.customerAction.count({ where: { inquiry: { conversationId: ticket.conversationId } } })).toBe(0);
});
