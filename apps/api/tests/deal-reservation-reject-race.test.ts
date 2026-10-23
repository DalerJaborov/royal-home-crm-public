import { randomUUID } from "node:crypto";
import { expect, it, vi } from "vitest";
import request from "supertest";
import { app } from "../src/app.js";
import { prisma } from "../src/db.js";
import { signAccessToken } from "../src/auth/jwt.js";
import { releaseExpiredReservations } from "../src/lib/dealReservation.js";
import { waitFor } from "./helpers/waitFor.js";
import { reportCronRowError } from "../src/lib/cronHeartbeat.js";

vi.mock("../src/lib/cronHeartbeat.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/lib/cronHeartbeat.js")>()),
  reportCronRowError: vi.fn(),
}));
vi.mock("../src/lib/directorAlertQueue.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/lib/directorAlertQueue.js")>()),
  enqueueDirectorAlert: vi.fn(async () => undefined),
}));
vi.mock("../src/push.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/push.js")>()),
  sendPushToAgent: vi.fn(async () => undefined),
}));
vi.mock("../src/lib/propertyMatchFilter.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/lib/propertyMatchFilter.js")>()),
  notifyWaitingBuyersOfNewProperty: vi.fn(async () => undefined),
}));

type Transaction = Parameters<Parameters<typeof prisma.$transaction>[0]>[0];

it.each(["PENDING_APPROVAL", "NEGOTIATION"] as const)(
  "changes %s while expiry waits without a lock cycle", async (stage) => {
    vi.mocked(reportCronRowError).mockClear();
    const key = randomUUID();
    const actor = await prisma.agent.create({ data: {
      fullName: "Synthetic review", phone: `test-review-${key}`, passwordHash: "test-unused", role: "DIRECTOR",
    } });
    const district = await prisma.district.create({ data: { name: `test-review-${key}` } });
    const client = await prisma.client.create({ data: {
      fullName: "Synthetic review", phone: `test-client-${key}`, source: "WALK_IN", assignedAgentId: actor.id,
    } });
    const property = await prisma.property.create({ data: {
      title: "Synthetic review", type: "APARTMENT", areaSqm: 50, price: 100000,
      districtId: district.id, address: "test", condition: "GOOD", status: "RESERVED",
      reservedAt: new Date("2020-01-01T00:00:00Z"), reservedForClientId: client.id, assignedAgentId: actor.id,
    } });
    const deal = await prisma.deal.create({ data: {
      clientId: client.id, propertyId: property.id, agentId: actor.id, stage,
    } });
    let release!: () => void;
    let ready!: () => void;
    const paused = new Promise<void>((resolve) => { ready = resolve; });
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const original = prisma.$transaction.bind(prisma) as unknown as (...args: unknown[]) => Promise<unknown>;
    let cronResult: Promise<number> | undefined;
    let http: Promise<request.Response> | undefined;
    // Pause the actual HTTP transaction once it owns Deal. Consistent ordering
    // means it owns Property too. Before the fix, expiry could own Property and
    // wait for Deal while HTTP needed Property for renewal or the timeline FK.
    const spy = vi.spyOn(prisma, "$transaction").mockImplementation(((operation: unknown, options: unknown) => {
      if (typeof operation !== "function") return original(operation, options);
      return original(async (tx: Transaction) => {
        const update = tx.deal.updateMany.bind(tx.deal);
        tx.deal.updateMany = (async (args: Parameters<typeof update>[0]) => {
          const result = await update(args);
          if (args.where?.id === deal.id && args.data.version) {
            ready();
            await gate;
          }
          return result;
        }) as typeof tx.deal.updateMany;
        return operation(tx);
      }, options);
    }) as never);
    try {
      http = request(app).patch(`/api/v1/deals/${deal.id}`)
        .set("Authorization", `Bearer ${signAccessToken({ sub: actor.id, role: "DIRECTOR" })}`)
        .send({ stage: "CONTRACT_SIGNED", rejectReason: "Synthetic review return" }).then((response) => response);
      await paused;
      cronResult = releaseExpiredReservations();
      await waitFor(async () => {
        const rows = await prisma.$queryRaw<Array<{ waiting: number }>>`
          SELECT count(*)::int AS waiting FROM pg_stat_activity
          WHERE datname=current_database() AND cardinality(pg_blocking_pids(pid))>0`;
        return rows[0].waiting > 0;
      }, { timeoutMs: 5000, label: "expiry waits for the stage change transaction" });
      release();
      expect((await http).status).toBe(200);
      expect(await cronResult).toBe(0);
      expect(reportCronRowError).not.toHaveBeenCalled();
      const storedProperty = await prisma.property.findUniqueOrThrow({ where: { id: property.id } });
      const storedDeal = await prisma.deal.findUniqueOrThrow({ where: { id: deal.id } });
      expect(storedProperty.status).toBe("RESERVED");
      expect(storedDeal.stage).toBe("CONTRACT_SIGNED");
      if (stage === "PENDING_APPROVAL") {
        expect(storedProperty.reservedAt!.getTime()).toBeGreaterThan(Date.parse("2020-01-01T00:00:00Z"));
        expect(storedDeal.reservationExpiredAt).toBeNull();
      } else {
        expect(storedDeal.reservationExpiredAt).not.toBeNull();
      }
    } finally {
      release();
      await Promise.allSettled([...(http ? [http] : []), ...(cronResult ? [cronResult] : [])]);
      spy.mockRestore();
      await prisma.deal.delete({ where: { id: deal.id } });
      await prisma.interaction.deleteMany({ where: { clientId: client.id } });
      await prisma.client.delete({ where: { id: client.id } });
      await prisma.property.delete({ where: { id: property.id } });
      await prisma.agent.delete({ where: { id: actor.id } });
      await prisma.district.delete({ where: { id: district.id } });
    }
  }, 20000,
);