import { describe, expect, it } from "vitest";
import { prisma, type TxClient } from "../src/db.js";
import { isActiveTransactionClient } from "../src/lib/transactionScope.js";

/** Actual extended interactive clients/context, without mutations or fixtures.
 * These tests deliberately do not mock the predicate or global db module. */
describe("customer transaction evidence reuses actual active Prisma callback context", () => {
  it("root, undefined, null and copied transaction-shaped objects are not active clients", () => {
    expect(isActiveTransactionClient(prisma)).toBe(false);
    expect(isActiveTransactionClient(undefined)).toBe(false);
    expect(isActiveTransactionClient(null)).toBe(false);
    expect(isActiveTransactionClient({ $transaction: prisma.$transaction })).toBe(false);
  });
  it("accepts the actual extended interactive client even though it inherits $transaction", async () => {
    let escaped: TxClient | undefined;
    await prisma.$transaction(async tx => {
      escaped = tx;
      expect("$transaction" in tx).toBe(true); // Actual regression trigger.
      expect(isActiveTransactionClient(tx)).toBe(true);
      expect(isActiveTransactionClient(prisma)).toBe(false);
      expect(isActiveTransactionClient(undefined)).toBe(false);
      await Promise.resolve();
      expect(isActiveTransactionClient(tx)).toBe(true);
    });
    expect(escaped).toBeDefined();
    expect(isActiveTransactionClient(escaped)).toBe(false);
  });
  it("rejects an escaped client after the callback throws and rolls back", async () => {
    let escaped: TxClient | undefined;
    await expect(prisma.$transaction(async tx => {
      escaped = tx; expect(isActiveTransactionClient(tx)).toBe(true);
      throw new Error("synthetic customer rollback");
    })).rejects.toThrow("synthetic customer rollback");
    expect(isActiveTransactionClient(escaped)).toBe(false);
  });
  it("rejects another concurrently open transaction from the current callback context", async () => {
    const clients: TxClient[] = [];
    const ready = [0, 1].map(() => {
      let resolve!: () => void;
      const promise = new Promise<void>(done => { resolve = done; });
      return { promise, resolve };
    });
    await Promise.all([0, 1].map(index => prisma.$transaction(async tx => {
      clients[index] = tx; ready[index].resolve();
      await Promise.all(ready.map(signal => signal.promise));
      expect(isActiveTransactionClient(tx)).toBe(true);
      expect(isActiveTransactionClient(clients[1 - index])).toBe(false);
      expect(isActiveTransactionClient(prisma)).toBe(false);
    }, { maxWait: 5000, timeout: 5000 })));
    expect(clients.every(client => !isActiveTransactionClient(client))).toBe(true);
  });
  it("a detached continuation inheriting ALS loses authority as soon as its callback finishes", async () => {
    let release!: () => void;
    const gate = new Promise<void>(done => { release = done; });
    let detached: Promise<boolean> | undefined;
    await prisma.$transaction(async tx => {
      detached = gate.then(() => isActiveTransactionClient(tx));
      expect(isActiveTransactionClient(tx)).toBe(true);
    });
    release();
    expect(await detached).toBe(false);
  });
});
