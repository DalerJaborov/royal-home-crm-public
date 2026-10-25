import { randomInt, randomUUID } from "node:crypto";
import { afterAll, describe, expect, it, vi } from "vitest";
import { prisma } from "../src/db.js";
import { mergeClients } from "../src/lib/clientMerge.js";

function barrier() {
  let release!: () => void;
  const promise = new Promise<void>(resolve => { release = resolve; });
  return { promise, release };
}
async function bounded<T>(promise: Promise<T>, label: string, ms = 8000): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([promise, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error(`Barrier timeout: ${label}`)), ms); })]);
  } finally { if (timer) clearTimeout(timer); }
}
const clientIds: string[] = [];
let actorId = "";
afterAll(async () => {
  vi.restoreAllMocks();
  await prisma.interaction.deleteMany({ where: { clientId: { in: clientIds } } });
  await prisma.client.deleteMany({ where: { id: { in: clientIds } } });
  if (actorId) await prisma.agent.deleteMany({ where: { id: actorId } });
});

describe("merge observes committed primary edits after acquiring its row lock", () => {
  it("preserves a concurrent manual single role and newly added phone", async () => {
    const actor = await prisma.agent.create({ data: { fullName: "Synthetic concurrent merge", phone: `merge-concurrent-${randomUUID()}`, role: "ADMIN", passwordHash: "unused", isActive: false } });
    actorId = actor.id;
    const tail = randomInt(1000000, 9999999);
    const primary = await prisma.client.create({ data: { fullName: "Concurrent primary", phone: `+99291${tail}`, source: "WALK_IN", kind: "BUYER", assignedAgentId: actorId, dualIntent: false, dualIntentDecisionSource: "AUTO", extraPhones: [] } });
    clientIds.push(primary.id);
    const duplicate = await prisma.client.create({ data: { fullName: "Concurrent seller duplicate", phone: `+99292${tail}`, source: "WALK_IN", kind: "SELLER", assignedAgentId: actorId } });
    clientIds.push(duplicate.id);
    const addedPhone = `+99293${tail}`;
    const writerHasLock = barrier(), allowWriterCommit = barrier(), outsideReadFinished = barrier();
    let staleRead: { source: string; extraPhones: string[] } | undefined;
    const realFind = prisma.client.findUnique.bind(prisma.client);
    const spy = vi.spyOn(prisma.client, "findUnique").mockImplementation(((args: Parameters<typeof prisma.client.findUnique>[0]) =>
      realFind(args).then(row => {
        if (args.where.id === primary.id && row && !staleRead) {
          staleRead = { source: row.dualIntentDecisionSource, extraPhones: [...row.extraPhones] };
          outsideReadFinished.release();
        }
        return row;
      })) as never);
    const writer = prisma.$transaction(async tx => {
      await tx.client.update({ where: { id: primary.id }, data: { dualIntentDecisionSource: "MANUAL", dualIntent: false, extraPhones: [addedPhone] } });
      writerHasLock.release();
      await bounded(allowWriterCommit.promise, "allow writer commit");
    }, { timeout: 15000 });
    // Avoid an unhandled rejection while another bounded barrier is being observed.
    void writer.catch(() => undefined);
    let merge: ReturnType<typeof mergeClients> | undefined;
    try {
      await bounded(writerHasLock.promise, "writer lock acquired");
      merge = mergeClients(primary.id, duplicate.id, actorId, "Synthetic concurrent primary edit");
      void merge.catch(() => undefined);
      await bounded(outsideReadFinished.promise, "merge's actual outside SELECT");
      expect(staleRead).toEqual({ source: "AUTO", extraPhones: [] });
      allowWriterCommit.release();
      await bounded(writer, "writer committed");
      await bounded(merge, "merge finished", 15000);
      const result = await realFind({ where: { id: primary.id } });
      expect(result?.dualIntentDecisionSource).toBe("MANUAL");
      expect(result?.dualIntent).toBe(false);
      expect(result?.extraPhones).toEqual(expect.arrayContaining([addedPhone, duplicate.phone]));
    } finally {
      allowWriterCommit.release();
      await Promise.allSettled([writer, ...(merge ? [merge] : [])]);
      spy.mockRestore();
    }
  }, 30000);
});
