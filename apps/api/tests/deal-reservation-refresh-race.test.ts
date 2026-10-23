import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { prisma } from "../src/db.js";
import { releaseExpiredReservations } from "../src/lib/dealReservation.js";

vi.mock("../src/push.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/push.js")>()),
  sendPushToAgent: vi.fn(async () => undefined),
}));
vi.mock("../src/lib/directorAlertQueue.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/lib/directorAlertQueue.js")>()),
  enqueueDirectorAlert: vi.fn(async () => undefined),
}));
vi.mock("../src/lib/propertyMatchFilter.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/lib/propertyMatchFilter.js")>()),
  notifyWaitingBuyersOfNewProperty: vi.fn(async () => undefined),
}));

let actorId: string;
let districtId: string;
const clientIds: string[] = [];
const propertyIds: string[] = [];
const dealIds: string[] = [];
beforeAll(async () => {
  actorId = (await prisma.agent.create({ data: {
    fullName: "Night reservation fixture", phone: `test-night-reservation-${randomUUID()}`,
    passwordHash: "test-placeholder", role: "AGENT",
  } })).id;
  districtId = (await prisma.district.create({ data: { name: `Night reservation ${randomUUID()}` } })).id;
});
afterEach(() => vi.restoreAllMocks());
afterAll(async () => {
  await prisma.deal.deleteMany({ where: { id: { in: dealIds } } });
  await prisma.interaction.deleteMany({ where: { clientId: { in: clientIds } } });
  await prisma.client.deleteMany({ where: { id: { in: clientIds } } });
  await prisma.property.deleteMany({ where: { id: { in: propertyIds } } });
  if (actorId) await prisma.agent.delete({ where: { id: actorId } });
  if (districtId) await prisma.district.delete({ where: { id: districtId } });
});

describe("reservation expiry rechecks its candidate snapshot", () => {
  it.each(["NEGOTIATION", "CONTRACT_SIGNED"] as const)("leaves a renewed %s reservation unchanged after candidate selection", async stage => {
    const client = await prisma.client.create({ data: { fullName: "Night reservation client fixture", phone: `test-night-reservation-client-${randomUUID()}`, source: "WALK_IN", assignedAgentId: actorId } });
    clientIds.push(client.id);
    const property = await prisma.property.create({ data: {
      title: "Night renewed reservation fixture", type: "APARTMENT", areaSqm: 50, price: 100000,
      districtId, address: "Test fixture", condition: "GOOD", status: "RESERVED",
      reservedAt: new Date(Date.now() - 14 * 86400000), reservedForClientId: client.id, assignedAgentId: actorId,
    } });
    propertyIds.push(property.id);
    const deal = await prisma.deal.create({ data: { clientId: client.id, propertyId: property.id, agentId: actorId, stage } });
    dealIds.push(deal.id);
    const renewedAt = new Date();
    const originalTransaction = prisma.$transaction.bind(prisma) as unknown as (...args: unknown[]) => Promise<unknown>;
    let renewed = false;
    vi.spyOn(prisma, "$transaction").mockImplementation((async (operation: unknown, options: unknown) => {
      if (!renewed && typeof operation === "function") {
        renewed = true;
        await prisma.property.update({ where: { id: property.id }, data: { reservedAt: renewedAt } });
      }
      return originalTransaction(operation, options);
    }) as never);

    await releaseExpiredReservations(renewedAt);
    expect(renewed).toBe(true);
    const afterProperty = await prisma.property.findUniqueOrThrow({ where: { id: property.id } });
    const afterDeal = await prisma.deal.findUniqueOrThrow({ where: { id: deal.id } });
    expect(afterProperty.status).toBe("RESERVED");
    expect(afterProperty.reservedAt).toEqual(renewedAt);
    expect(afterProperty.reservedForClientId).toBe(client.id);
    expect(afterDeal.stage).toBe(stage);
    expect(afterDeal.reservationExpiredAt).toBeNull();
  });
});
