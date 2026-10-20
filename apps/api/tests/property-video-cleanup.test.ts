import { beforeEach, describe, expect, it, vi } from "vitest";
import path from "node:path";

const mocks = vi.hoisted(() => ({
  list: vi.fn(), find: vi.fn(), lock: vi.fn(), uploads: vi.fn(), jobs: vi.fn(), drafts: vi.fn(),
  removeRow: vi.fn(), update: vi.fn(), audit: vi.fn(), removeFile: vi.fn(), access: vi.fn(), error: vi.fn(),
}));
vi.mock("../src/db.js", () => ({ prisma: {
  property: { findMany: mocks.list }, $disconnect: vi.fn(),
  $transaction: async (run: (tx: unknown) => unknown) => run({
    $queryRaw: mocks.lock, property: {findUnique: mocks.find, update: mocks.update},
    videoUploadSession: {count: mocks.uploads}, backgroundJob: {count: mocks.jobs},
    propertyDraftMedia: {count: mocks.drafts}, propertyVideo: {delete: mocks.removeRow}, auditLog: {create: mocks.audit},
  }),
} }));
vi.mock("../src/lib/localVideoStorage.js", async importOriginal => ({...await importOriginal<typeof import("../src/lib/localVideoStorage.js")>(), localVideoDelete: mocks.removeFile}));
vi.mock("../src/lib/systemError.js", async importOriginal => ({...await importOriginal<typeof import("../src/lib/systemError.js")>(), logSystemError: mocks.error}));
vi.mock("../src/upload.js", async importOriginal => ({...await importOriginal<typeof import("../src/upload.js")>(), videoHandoffDir: "/finished"}));
vi.mock("node:fs/promises", () => ({default: {access: mocks.access}}));
const {cleanupStalePropertyVideos} = await import("../src/lib/propertyVideoCleanup.js");

const old = new Date(Date.now() - 8 * 86_400_000);
function property(change = {}) {
  return {id: "p1", shortId: 1, status: "AVAILABLE", deletedAt: null, videoHandoffStatus: "RECEIVED",
    clipReviewStatus: "APPROVED", videoHandoffVideoId: "v1", videoHandoffFinalPath: "/uploads/handoff/final.mp4",
    publishedChannels: ["INSTAGRAM"], publishedPostIds: {INSTAGRAM: "post1", RAW_VIDEO_PUBLISHED_AT: old.toISOString(), RAW_VIDEO_PUBLISHED_PATH: "/uploads/handoff/final.mp4"},
    videos: [{id: "v1", storageKey: "p1/v1.mp4", uploadedAt: new Date(old.getTime() - 1000)}], ...change};
}
beforeEach(() => {
  vi.resetAllMocks();
  mocks.list.mockResolvedValue([property()]); mocks.find.mockResolvedValue(property());
  mocks.uploads.mockResolvedValue(0); mocks.jobs.mockResolvedValue(0); mocks.drafts.mockResolvedValue(0);
  mocks.access.mockResolvedValue(undefined); mocks.removeFile.mockResolvedValue(true);
});
describe("safe published raw-source cleanup", () => {
  it("deletes expired sources and logs the exact receipt, preserving the final", async () => {
    expect(await cleanupStalePropertyVideos()).toEqual({properties: 1, videosDeleted: 1, failed: 0});
    expect(mocks.access).toHaveBeenCalledWith(path.join("/finished", "final.mp4"));
    expect(mocks.removeFile).toHaveBeenCalledWith("p1/v1.mp4");
    expect(mocks.removeFile.mock.invocationCallOrder[0]).toBeLessThan(mocks.removeRow.mock.invocationCallOrder[0]);
    expect(mocks.audit).toHaveBeenCalledWith(expect.objectContaining({data: expect.objectContaining({meta: expect.objectContaining({retentionDays: 7, publishedAt: old.toISOString()})})}));
  });
  it.each([{status:"EDITING"}, {publishedChannels:[]}, {videoHandoffStatus:"QUEUED"}, {deletedAt:new Date()}, {clipReviewStatus:"PENDING"}])("rechecks protected state after taking the row lock: %o", async change => {
    mocks.find.mockResolvedValue(property(change));
    await cleanupStalePropertyVideos();
    expect(mocks.lock).toHaveBeenCalled();
    expect(mocks.removeFile).not.toHaveBeenCalled();
  });
  it.each(["uploads", "jobs", "drafts"] as const)("preserves files with active %s", async key => {
    mocks[key].mockResolvedValue(1);
    await cleanupStalePropertyVideos();
    expect(mocks.removeFile).not.toHaveBeenCalled();
  });
  it("preserves newly added sources after this publication", async () => {
    mocks.find.mockResolvedValue(property({videos:[{id:"new",storageKey:"p1/new.mp4",uploadedAt:new Date()}]}));
    await cleanupStalePropertyVideos(); expect(mocks.removeFile).not.toHaveBeenCalled();
  });
  it("preserves the database row when filesystem deletion fails", async () => {
    mocks.removeFile.mockResolvedValue(false);
    expect((await cleanupStalePropertyVideos()).failed).toBe(1);
    expect(mocks.removeRow).not.toHaveBeenCalled();
  });
  it("preserves sources when the finished video is missing", async () => {
    mocks.access.mockRejectedValue(new Error("ENOENT"));
    expect((await cleanupStalePropertyVideos()).failed).toBe(1);
    expect(mocks.removeFile).not.toHaveBeenCalled();
  });
});
