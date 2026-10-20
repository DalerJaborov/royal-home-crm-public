import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, beforeEach, expect, it, vi } from "vitest";
import { prisma } from "../src/db.js";
import { encryptSecret } from "../src/crypto.js";
import { handleComment, type QueuedComment } from "../src/messengers/comments.js";

const { model } = vi.hoisted(() => ({ model: vi.fn() }));
vi.mock("../src/ai/client.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/ai/client.js")>()), callAiText: model,
}));
vi.mock("../src/lib/socialPublish.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/lib/socialPublish.js")>()),
  youtubeAccessToken: vi.fn(async () => "synthetic-youtube-token"),
}));

const prefix = `c02b-youtube-${randomUUID()}`;
const ids: string[] = [];
let saved: { youtubeClientId: string | null; youtubeClientSecret: string | null; youtubeRefreshToken: string | null };
let moderationStatus = 204;
let moderationBody = "";
const calls: { url: string; method: string }[] = [];
beforeAll(async () => {
  saved = await prisma.settings.findUniqueOrThrow({ where: { id: "singleton" },
    select: { youtubeClientId: true, youtubeClientSecret: true, youtubeRefreshToken: true } });
  await prisma.settings.update({ where: { id: "singleton" }, data: { youtubeClientId: "synthetic-client",
    youtubeClientSecret: encryptSecret("synthetic-secret"), youtubeRefreshToken: encryptSecret("synthetic-refresh") } });
});
beforeEach(() => {
  calls.length = 0; moderationStatus = 204; moderationBody = "";
  model.mockReset();
  model.mockResolvedValue({ action: "delete", reason: "реклама конкурента" });
  vi.stubGlobal("fetch", vi.fn(async (url: unknown, init?: RequestInit) => {
    const address = String(url);
    calls.push({ url: address, method: init?.method ?? "GET" });
    if (!address.startsWith("https://www.googleapis.com/youtube/v3/")) throw new Error("Unexpected external request in YT moderation fixture");
    if (address.includes("/comments/setModerationStatus")) {
      return new Response(moderationStatus === 204 ? null : moderationBody, { status: moderationStatus });
    }
    if (address.includes("/videos?") || address.includes("/channels?")) {
      return new Response(JSON.stringify({ items: [] }), { status: 200 });
    }
    throw new Error("Unexpected YouTube endpoint in moderation fixture");
  }));
});
afterEach(() => { vi.unstubAllGlobals(); });
afterAll(async () => {
  await prisma.instagramComment.deleteMany({ where: { id: { in: ids } } });
  if (saved) await prisma.settings.update({ where: { id: "singleton" }, data: saved });
});
async function row(suffix: string) {
  // Normal configuration may retry an assertion in the same worker. Remove only this owned row.
  await prisma.instagramComment.deleteMany({ where: { commentId: `${prefix}-${suffix}` } });
  const value = await prisma.instagramComment.create({ data: { commentId: `${prefix}-${suffix}`,
    channel: "YOUTUBE", mediaId: "synthetic-video", authorId: `${prefix}-author-${suffix}`,
    text: "Можно уточнить условия?", replyDueAt: new Date() } });
  ids.push(value.id);
  return value as QueuedComment;
}
it("actual model delete + YT204 stores rejected HIDDEN without a deleted outcome or DM", async () => {
  const incoming = await row("accepted");
  expect(await handleComment(incoming)).toBe("hidden");
  expect(model.mock.calls.some(([input]) => input.endpoint === "instagram-comment")).toBe(true);
  const savedRow = await prisma.instagramComment.findUniqueOrThrow({ where: { id: incoming.id } });
  expect(savedRow.status).toBe("HIDDEN");
  expect(savedRow.note).toBe("youtube_rejected; competitor_ad");
  expect(savedRow.hiddenAt).not.toBeNull();
  expect(savedRow.dmSentAt).toBeNull();
  const requests = calls.filter((request) => request.url.includes("setModerationStatus"));
  expect(requests).toHaveLength(1);
  expect(requests[0]).toMatchObject({ method: "POST" });
  expect(requests[0].url).toContain("moderationStatus=rejected");
  expect(calls.some((request) => request.method === "DELETE" || request.url.includes("/me/messages"))).toBe(false);
});
it("actual model delete + YT200{} closes unknown without claiming hidden/deleted", async () => {
  moderationStatus = 200; moderationBody = "{}";
  const incoming = await row("unknown");
  expect(await handleComment(incoming)).toBe("skipped");
  const savedRow = await prisma.instagramComment.findUniqueOrThrow({ where: { id: incoming.id } });
  expect(savedRow.status).toBe("SKIPPED");
  expect(savedRow.hiddenAt).toBeNull();
  expect(savedRow.note).toContain("moderation_unknown");
  expect(calls.filter((request) => request.url.includes("setModerationStatus"))).toHaveLength(1);
});
