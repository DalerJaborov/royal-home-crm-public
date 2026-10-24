import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import fs from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import request from "supertest";

const storageHooks = vi.hoisted(() => ({
  write: vi.fn(),
  assemble: vi.fn(),
  abort: vi.fn(),
}));
vi.mock("../src/lib/localVideoStorage.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/lib/localVideoStorage.js")>();
  return {
    ...actual,
    writeLocalUploadPart: async (...args: Parameters<typeof actual.writeLocalUploadPart>) => {
      await storageHooks.write();
      return actual.writeLocalUploadPart(...args);
    },
    completeLocalUploadSession: async (...args: Parameters<typeof actual.completeLocalUploadSession>) => {
      await storageHooks.assemble();
      return actual.completeLocalUploadSession(...args);
    },
    abortLocalUploadSession: async (...args: Parameters<typeof actual.abortLocalUploadSession>) => {
      if (await storageHooks.abort() === false) return false;
      return actual.abortLocalUploadSession(...args);
    },
  };
});
vi.mock("../src/push.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/push.js")>()),
  sendPushToAgent: vi.fn(async () => 0),
}));
vi.mock("../src/lib/rawVideoFacts.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/lib/rawVideoFacts.js")>()),
  probeRawVideoFacts: vi.fn(async () => ({})),
}));
vi.mock("../src/lib/propertyPipeline.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/lib/propertyPipeline.js")>()),
  revertToReviewAfterVideoUpload: vi.fn(async () => undefined),
}));
vi.mock("../src/lib/propertyReview.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/lib/propertyReview.js")>()),
  autoApproveIfRawReviewOff: vi.fn(async () => undefined),
}));
vi.mock("../src/lib/propertyEditNotify.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/lib/propertyEditNotify.js")>()),
  notifySourceFilesChanged: vi.fn(async () => undefined),
}));

const { prisma } = await import("../src/db.js");
const { app } = await import("../src/app.js");
const { signAccessToken } = await import("../src/auth/jwt.js");
const storage = await import("../src/lib/localVideoStorage.js");
const { cleanupStaleVideoUploadSessions } = await import("../src/lib/videoUploadCleanup.js");
const runId = randomUUID();
const propertyIds: string[] = [];
const sessionIds: string[] = [];
let agentId: string;
let districtId: string;
let token: string;

function gate() {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => { release = resolve; });
  return { promise, release };
}

async function fixture(complete = false) {
  const property = await prisma.property.create({ data: {
    title: `Upload cleanup race ${runId}`, type: "APARTMENT", areaSqm: 50,
    price: 100, currency: "TJS", districtId, condition: "GOOD", status: "EDITING",
    address: "Synthetic test address", createdById: agentId, intakeAgentId: agentId,
  } });
  propertyIds.push(property.id);
  const session = await prisma.videoUploadSession.create({ data: {
    propertyId: property.id, uploadKey: randomUUID(), storageKey: `${property.id}/${randomUUID()}.mp4`,
    filename: "fixture.mp4", sizeBytes: 2, partSize: 1, totalParts: 2,
    contentType: "video/mp4", createdById: agentId,
    parts: complete ? [{ partNumber: 1 }, { partNumber: 2 }] : [{ partNumber: 1 }],
    updatedAt: new Date(Date.now() - 49 * 3600_000),
  } });
  sessionIds.push(session.id);
  await storage.createLocalUploadSession(session.id);
  await storage.writeLocalUploadPart(session.id, 1, Buffer.from("a"));
  if (complete) await storage.writeLocalUploadPart(session.id, 2, Buffer.from("b"));
  return { property, session };
}

const part = (propertyId: string, sessionId: string, number = 2) => request(app)
  .put(`/api/v1/properties/${propertyId}/videos/upload-sessions/${sessionId}/parts/${number}`)
  .set("Authorization", `Bearer ${token}`).set("Content-Type", "application/octet-stream").send(Buffer.from("b"));

async function waitForBlockedConnection() {
  for (let attempt = 0; attempt < 100; attempt++) {
    const [row] = await prisma.$queryRaw<Array<{ count: number }>>`
      SELECT count(*)::int AS count FROM pg_stat_activity
      WHERE datname = current_database() AND wait_event_type = 'Lock'
      AND cardinality(pg_blocking_pids(pid)) > 0`;
    if (row.count > 0) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error("Expected a real PostgreSQL lock waiter");
}

beforeAll(async () => {
  districtId = (await prisma.district.create({ data: { name: `upload-race-${runId}` } })).id;
  agentId = (await prisma.agent.create({ data: {
    fullName: "Synthetic upload tester", phone: `test-upload-${runId}`, role: "AGENT", passwordHash: "test-unused-hash",
  } })).id;
  token = signAccessToken({ sub: agentId, role: "AGENT" });
});
afterEach(() => {
  vi.restoreAllMocks();
  storageHooks.write.mockReset();
  storageHooks.assemble.mockReset();
  storageHooks.abort.mockReset();
});
afterAll(async () => {
  for (const id of sessionIds) await storage.abortLocalUploadSession(id);
  const videos = await prisma.propertyVideo.findMany({ where: { propertyId: { in: propertyIds } } });
  for (const video of videos) await storage.localVideoDelete(video.storageKey);
  await prisma.videoUploadSession.deleteMany({ where: { propertyId: { in: propertyIds } } });
  await prisma.propertyVideo.deleteMany({ where: { propertyId: { in: propertyIds } } });
  await prisma.auditLog.deleteMany({ where: { entityId: { in: propertyIds } } });
  await prisma.property.deleteMany({ where: { id: { in: propertyIds } } });
  await prisma.agent.delete({ where: { id: agentId } });
  await prisma.district.delete({ where: { id: districtId } });
  await prisma.$disconnect();
});

describe("stale multipart cleanup versus real upload IO", () => {
  it("keeps bytes accepted by PUT after the stale candidate scan", async () => {
    const { property, session } = await fixture();
    const findMany = prisma.videoUploadSession.findMany.bind(prisma.videoUploadSession);
    vi.spyOn(prisma.videoUploadSession, "findMany").mockImplementationOnce(async (args) => {
      const snapshot = await findMany(args);
      expect((await part(property.id, session.id)).status).toBe(200);
      return snapshot;
    });
    const result = await cleanupStaleVideoUploadSessions();
    expect(result).toEqual({ sessions: 0, failed: 0 });
    expect(await prisma.videoUploadSession.findUnique({ where: { id: session.id } })).not.toBeNull();
    expect(await fs.readFile(path.join(process.env.PROPERTY_VIDEO_SESSIONS_DIR ?? "./uploads-private-video-sessions", session.id, "part-2"), "utf8")).toBe("b");
  });

  it("waits for an uncommitted renewal and checks its committed timestamp", async () => {
    const { session } = await fixture();
    const entered = gate();
    const release = gate();
    const writing = prisma.$transaction(async (tx) => {
      await tx.videoUploadSession.update({ where: { id: session.id }, data: { updatedAt: new Date() } });
      entered.release();
      await release.promise;
    });
    await entered.promise;
    const cleaning = cleanupStaleVideoUploadSessions();
    try {
      await waitForBlockedConnection();
    } finally { release.release(); }
    await writing;
    expect(await cleaning).toEqual({ sessions: 0, failed: 0 });
    expect(await prisma.videoUploadSession.findUnique({ where: { id: session.id } })).not.toBeNull();
  });

  it("a PUT cannot acknowledge success after cleanup wins the locked stale check", async () => {
    const { property, session } = await fixture();
    const entered = gate();
    const release = gate();
    storageHooks.write.mockClear();
    storageHooks.abort.mockImplementationOnce(async () => { entered.release(); await release.promise; });
    const cleaning = cleanupStaleVideoUploadSessions();
    await entered.promise;
    const writing = part(property.id, session.id).then((response) => response);
    try {
      await waitForBlockedConnection();
    } finally { release.release(); }
    expect(await cleaning).toEqual({ sessions: 1, failed: 0 });
    expect((await writing).status).toBeGreaterThanOrEqual(400);
    // The existing route writes bytes before its implicit UPDATE row lock;
    // that UPDATE must fail if cleanup has removed the session meanwhile.
    expect(storageHooks.write).toHaveBeenCalledTimes(1);
    await expect(fs.access(path.join(process.env.PROPERTY_VIDEO_SESSIONS_DIR ?? "./uploads-private-video-sessions", session.id))).rejects.toThrow();
  });

  it("a completion accepted after the scan keeps its independent completed file", async () => {
    const { property, session } = await fixture(true);
    const findMany = prisma.videoUploadSession.findMany.bind(prisma.videoUploadSession);
    vi.spyOn(prisma.videoUploadSession, "findMany").mockImplementationOnce(async (args) => {
      const snapshot = await findMany(args);
      const completed = await request(app)
        .post(`/api/v1/properties/${property.id}/videos/upload-sessions/${session.id}/complete`)
        .set("Authorization", `Bearer ${token}`);
      expect(completed.status).toBe(201);
      return snapshot;
    });
    expect(await cleanupStaleVideoUploadSessions()).toEqual({ sessions: 0, failed: 0 });
    expect(await fs.readFile(storage.localVideoFilePath(session.storageKey)!, "utf8")).toBe("ab");
    expect(await prisma.propertyVideo.count({ where: { uploadKey: session.uploadKey } })).toBe(1);
  });

  it("retains the row and actual parts when disk cleanup fails", async () => {
    const { session } = await fixture();
    storageHooks.abort.mockResolvedValueOnce(false);
    expect(await cleanupStaleVideoUploadSessions()).toEqual({ sessions: 0, failed: 1 });
    expect(await prisma.videoUploadSession.findUnique({ where: { id: session.id } })).not.toBeNull();
    expect(await fs.readFile(path.join(process.env.PROPERTY_VIDEO_SESSIONS_DIR ?? "./uploads-private-video-sessions", session.id, "part-1"), "utf8")).toBe("a");
    // Remove this intentionally stale fixture so it cannot affect later files.
    await storage.abortLocalUploadSession(session.id);
    await prisma.videoUploadSession.delete({ where: { id: session.id } });
  });
});
