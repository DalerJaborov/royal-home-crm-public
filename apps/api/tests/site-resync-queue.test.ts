import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.stubEnv("SITE_SYNC_URL", "https://site-resync-fixture.invalid/api/v1/crm");
vi.stubEnv("SITE_SYNC_API_KEY", "test-site-resync-key");
vi.stubEnv("CRM_PUBLIC_URL", "https://site-resync-crm.invalid");

const { prisma } = await import("../src/db.js");
const { claimBatch, runBackgroundJobsTick } = await import("../src/jobs/runner.js");
const { enqueueSiteResyncInTransaction } = await import("../src/lib/siteResyncQueue.js");
const { resyncPhotosIfPublished } = await import("../src/lib/siteSync.js");

type SiteItem = { externalId: string; crmPriceVersion: number; data: { price: number } };

function stubSite(send: (item: SiteItem) => Response | Promise<Response>) {
  const transport = vi.fn(async (url: string, init: { body: string }) => {
    if (!url.startsWith("https://site-resync-fixture.invalid/")) throw new Error("Unexpected test transport destination");
    const body = JSON.parse(init.body) as { items: SiteItem[] };
    return send(body.items[0]);
  });
  vi.stubGlobal("fetch", transport);
  return transport;
}

const ok = ({ externalId }: SiteItem) => Response.json({ results: [{ externalId, ok: true }] });
const failure = (status: number) => Response.json({ error: "Synthetic site refusal" }, { status });

describe("site resync queue delivery", () => {
  let propertyId: string;
  let districtId: string;
  let initialVersion: number;
  const key = () => `site-resync:${propertyId}`;

  beforeEach(async () => {
    districtId = (await prisma.district.create({ data: { name: `Site price test ${randomUUID()}` } })).id;
    const property = await prisma.property.create({
      data: {
        title: "Synthetic site fixture", type: "APARTMENT", areaSqm: 50, price: 300000,
        currency: "TJS", districtId, address: "Fixture", condition: "GOOD",
        publishedOnSite: true, status: "AVAILABLE", siteListingId: 880009,
      },
    });
    propertyId = property.id;
    initialVersion = property.version;
  });

  afterEach(async () => {
    vi.unstubAllGlobals();
    await prisma.backgroundJob.deleteMany({
      where: { type: "site-resync", payload: { path: ["propertyId"], equals: propertyId } },
    });
    await prisma.property.delete({ where: { id: propertyId } });
    await prisma.district.delete({ where: { id: districtId } });
  });

  afterAll(() => vi.unstubAllEnvs());

  async function changePrice(price: number) {
    await prisma.$transaction(async (tx) => {
      await tx.property.update({ where: { id: propertyId }, data: { price, version: { increment: 1 } } });
      await enqueueSiteResyncInTransaction(tx, propertyId, "Synthetic price change");
    });
  }

  it.each([200, 403, 503])("keeps the latest committed price when the leased send returns HTTP %i", async (firstStatus) => {
    let start!: () => void;
    let release!: () => void;
    const started = new Promise<void>((resolve) => { start = resolve; });
    const blocked = new Promise<void>((resolve) => { release = resolve; });
    const sent: number[][] = [];
    stubSite(async (item) => {
      sent.push([item.data.price, item.crmPriceVersion]);
      if (sent.length === 1) {
        start();
        await blocked;
        if (firstStatus !== 200) return failure(firstStatus);
      }
      return ok(item);
    });

    await resyncPhotosIfPublished(propertyId, "First snapshot");
    const active = await prisma.backgroundJob.findUniqueOrThrow({ where: { dedupeKey: key() } });
    const firstTick = runBackgroundJobsTick();
    try {
      await Promise.race([started, firstTick.then(() => { throw new Error("Site worker did not send the first snapshot"); })]);
      await changePrice(290000);
      await changePrice(280000);
      const running = await prisma.backgroundJob.findUniqueOrThrow({ where: { dedupeKey: key() } });
      expect(running).toMatchObject({ id: active.id, status: "RUNNING" });
      expect(running.payload).not.toEqual(active.payload);
      // A second worker cannot take the same property while the previous request is in flight.
      await runBackgroundJobsTick();
      expect(sent).toEqual([[300000, initialVersion]]);
    } finally {
      release();
      await firstTick;
    }

    const successor = await prisma.backgroundJob.findUniqueOrThrow({ where: { dedupeKey: key() } });
    expect(successor).toMatchObject({ id: active.id, status: "PENDING", attempts: 0, lastError: null });
    await runBackgroundJobsTick();
    expect(sent).toEqual([[300000, initialVersion], [280000, initialVersion + 2]]);
    expect(await prisma.backgroundJob.findUniqueOrThrow({ where: { id: active.id } }))
      .toMatchObject({ status: "DONE", dedupeKey: null });
  });

  it("picks up the newest price after the worker disappears with a lease", async () => {
    const sent: number[] = [];
    stubSite((item) => {
      sent.push(item.data.price);
      return ok(item);
    });
    await resyncPhotosIfPublished(propertyId, "Before restart");
    const [claimed] = (await claimBatch()).filter((job) => job.dedupeKey === key());
    expect(claimed).toBeDefined();
    await changePrice(280000);
    await prisma.$executeRaw`UPDATE "BackgroundJob" SET "lockedAt" = now() - interval '16 minutes' WHERE id = ${claimed.id}`;
    await runBackgroundJobsTick();
    expect(sent).toEqual([280000]);
    expect(await prisma.backgroundJob.findUniqueOrThrow({ where: { id: claimed.id } }))
      .toMatchObject({ status: "DONE", dedupeKey: null });
  });

  it("rolls back the queued delivery with the property write", async () => {
    await expect(prisma.$transaction(async (tx) => {
      await tx.property.update({ where: { id: propertyId }, data: { price: 280000 } });
      await enqueueSiteResyncInTransaction(tx, propertyId, "Rolled back price");
      throw new Error("Synthetic price rollback");
    })).rejects.toThrow("Synthetic price rollback");

    expect(await prisma.backgroundJob.findUnique({ where: { dedupeKey: key() } })).toBeNull();
    const property = await prisma.property.findUniqueOrThrow({ where: { id: propertyId } });
    expect(Number(property.price)).toBe(300000);
  });

  it.each([403, 429, 503])("retries transient refusals only (HTTP %i)", async (status) => {
    let calls = 0;
    stubSite((item) => ++calls === 1 ? failure(status) : ok(item));
    await resyncPhotosIfPublished(propertyId, "Site status");
    const active = await prisma.backgroundJob.findUniqueOrThrow({ where: { dedupeKey: key() } });
    await runBackgroundJobsTick();

    const shouldRetry = status !== 403;
    expect(await prisma.backgroundJob.findUniqueOrThrow({ where: { id: active.id } })).toMatchObject({
      status: shouldRetry ? "PENDING" : "GIVEN_UP",
      attempts: 1,
      lastError: expect.stringContaining("Synthetic site refusal"),
    });
    await prisma.$executeRaw`UPDATE "BackgroundJob" SET "runAt" = now() - interval '1 minute' WHERE id = ${active.id}`;
    await runBackgroundJobsTick();
    expect(calls).toBe(shouldRetry ? 2 : 1);
  });

  it("requires acknowledgement of the same property before recording success", async () => {
    stubSite(() => Response.json({ results: [{ externalId: "another-property", ok: true }] }));
    await resyncPhotosIfPublished(propertyId, "Missing acknowledgement");
    await runBackgroundJobsTick();
    expect(await prisma.backgroundJob.findUniqueOrThrow({ where: { dedupeKey: key() } })).toMatchObject({
      status: "PENDING", attempts: 1, lastError: expect.stringContaining("сайт не подтвердил"),
    });
  });
});
