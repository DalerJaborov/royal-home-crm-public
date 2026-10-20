import { afterEach, expect, it, vi } from "vitest";
import { prisma } from "../src/db.js";
import { encryptSecret } from "../src/crypto.js";
import { publicReplyReceipt } from "../src/messengers/publicCommentReply.js";
import { postYouTubeCommentReply, postYouTubeCommentReplyResponse } from "../src/messengers/youtubeComments.js";
import { publicCommentWireFixture } from "./helpers/publicCommentWireFixture.js";
vi.mock("../src/lib/socialPublish.js", async importOriginal => ({ ...(await importOriginal<typeof import("../src/lib/socialPublish.js")>()), youtubeAccessToken: vi.fn(async () => "synthetic-public-access") }));
vi.mock("../src/lib/systemError.js", async importOriginal => ({ ...(await importOriginal<typeof import("../src/lib/systemError.js")>()), logSystemError: vi.fn(async () => undefined) }));
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });
async function configured() {
  const baseline = await prisma.settings.findUnique({ where: { id: "singleton" } });
  if (!baseline) throw new Error("Normal setup must create Settings");
  vi.spyOn(prisma.settings, "findUnique").mockResolvedValue({ ...baseline, youtubeClientId: "synthetic-client",
    youtubeClientSecret: encryptSecret("synthetic-secret"), youtubeRefreshToken: encryptSecret("synthetic-refresh") });
}
it("actual YT reply wire returns its ID and posts under the exact root", async () => {
  await configured(); const fetch = vi.fn(async (_url: unknown, _init?: RequestInit) => new Response(JSON.stringify({ id: "yt-public-id" }), { status: 200 })); vi.stubGlobal("fetch", fetch);
  const guard = vi.fn(async () => undefined);
  expect(await postYouTubeCommentReply("root-thread-1", "Synthetic", guard)).toBe("yt-public-id");
  expect(guard).toHaveBeenCalledTimes(1); expect(fetch).toHaveBeenCalledTimes(1);
  expect(JSON.parse(String(fetch.mock.calls[0][1]?.body)).snippet.parentId).toBe("root-thread-1");
});
it("actual YT 2xx without ID remains unknown", async () => {
  await configured(); const fetch = vi.fn(async () => new Response("{}", { status: 200 })); vi.stubGlobal("fetch", fetch);
  expect(publicReplyReceipt("YOUTUBE", await postYouTubeCommentReply("root-thread-2", "Synthetic")).outcome).toBe("unknown");
  expect(fetch).toHaveBeenCalledTimes(1);
});
it.each([{ id: "contradictory", success: false }, { id: "contradictory", ok: false }])("actual YT preserves negative flags until receipt validation: %j", async body => {
  await configured(); const fetch = vi.fn(async () => new Response(JSON.stringify(body), { status: 200 })); vi.stubGlobal("fetch", fetch);
  const wire = publicCommentWireFixture({ channel: "YOUTUBE", accountExternalId: null, mediaId: "video-1", commentId: "root-1", parentId: null });
  await expect(wire.run(beforePost => postYouTubeCommentReplyResponse("root-1", "Synthetic", beforePost))).rejects.toMatchObject({ reason: "contradictory_provider_response", receipt: { outcome: "unknown" } });
  expect(fetch).toHaveBeenCalledTimes(1);
});
it("actual YT inherited HTTP retry is stopped by the one-shot physical callback", async () => {
  await configured(); const fetch = vi.fn(async () => { throw new Error("Synthetic connect failure", { cause: { code: "ECONNREFUSED" } }); }); vi.stubGlobal("fetch", fetch);
  const wire = publicCommentWireFixture({ channel: "YOUTUBE", accountExternalId: null, mediaId: "video-1", commentId: "root-1", parentId: null });
  await expect(wire.run(beforePost => postYouTubeCommentReplyResponse("root-1", "Synthetic", beforePost))).rejects.toMatchObject({ receipt: { outcome: "unknown" } });
  expect(fetch).toHaveBeenCalledTimes(1);
});
it("actual YT credential await cannot adopt a revoked source", async () => {
  await configured(); vi.spyOn(Date, "now").mockReturnValue(Date.now() + 4 * 60 * 60 * 1000);
  const wire = publicCommentWireFixture({ channel: "YOUTUBE", accountExternalId: null, mediaId: "video-1", commentId: "root-1", parentId: null });
  const { youtubeAccessToken } = await import("../src/lib/socialPublish.js");
  vi.mocked(youtubeAccessToken).mockImplementationOnce(async () => { await Promise.resolve(); wire.state.current = false; return "synthetic-new-access"; });
  const fetch = vi.fn(); vi.stubGlobal("fetch", fetch);
  await expect(wire.run(beforePost => postYouTubeCommentReplyResponse("root-1", "Synthetic", beforePost))).rejects.toMatchObject({ receipt: { outcome: "unknown" } });
  expect(fetch).not.toHaveBeenCalled();
});
