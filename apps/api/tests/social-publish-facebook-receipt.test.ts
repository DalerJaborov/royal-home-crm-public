import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../src/db.js", () => ({ prisma: { $disconnect: vi.fn(), settings: { findUnique: vi.fn(async () => ({})) } } }));
const marks = vi.hoisted(() => ({ channels: [] as string[], postIds: {} as Record<string, unknown> }));
vi.mock("../src/lib/publishedMarks.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/lib/publishedMarks.js")>()),
  readOwnerMarks: vi.fn(async () => marks),
  updateOwnerMarks: vi.fn(async (_owner, change) => {
    const next = await change(marks);
    if (next) { marks.channels = next.channels; marks.postIds = next.postIds; }
  }),
}));
vi.mock("../src/messengers/meta.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/messengers/meta.js")>()),
  loadCredentials: vi.fn(async () => ({ pageId: "test-page", pageToken: "test-token" })),
}));
const { logSystemError } = vi.hoisted(() => ({ logSystemError: vi.fn(async () => {}) }));
vi.mock("../src/lib/systemError.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/lib/systemError.js")>()), logSystemError,
}));
const { findRecentFacebookVideo, publishApprovedPost } = await import("../src/lib/socialPublish.js");
const SINCE = new Date("2026-10-21T00:00:00.000Z");
const EARLIEST = "2026-10-20T23:50:00.000Z";
const CAPTION = "Полная подпись\nЦена: 500 000";
const video = (over: Record<string, unknown> = {}) => ({ id: "fb-existing", description: CAPTION, created_time: SINCE.toISOString(), ...over });
function lookup(items: unknown[], caption = CAPTION, since = SINCE) {
  vi.stubGlobal("fetch", vi.fn(async () => ({ ok: true, status: 200, json: async () => ({ data: items }) })));
  return findRecentFacebookVideo("Test owner", "test-page", "test-token", caption, since);
}
beforeEach(() => logSystemError.mockClear());
afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); });

describe("Facebook recovery receipt: full caption and timestamp", () => {
  it("recognizes the reproduced 602-to-600 character provider trim", async () => {
    const remote = "x".repeat(600);
    const stored = ` ${remote}\n`;
    expect(stored.length).toBe(602);
    expect(await lookup([video({ description: remote })], stored)).toBe("fb-existing");
  });
  it.each([
    [CAPTION, ` \n${CAPTION}\t `],
    [` \n${CAPTION}\t `, CAPTION],
    [` ${CAPTION}\n`, `\t${CAPTION} `],
  ])("accepts only outer whitespace normalization", async (stored, remote) => {
    expect(await lookup([video({ description: remote })], stored)).toBe("fb-existing");
  });
  it.each(["", " \n\t "])("empty normalized caption cannot identify a publication", async (caption) => {
    expect(await lookup([video({ description: caption })], caption)).toBeNull();
  });
  it.each([
    "Полная подпись Цена: 500 000", "Полная  подпись\nЦена: 500 000",
    "Полная подпись\nЦена: 500000", "Полная подпись", `${CAPTION} ещё текст`,
  ])("does not match changed internal whitespace, partial or different text", async (description) => {
    expect(await lookup([video({ description })])).toBeNull();
  });
  it.each([undefined, null, "", "not-a-date"])("invalid creation time cannot serve as a receipt", async (created_time) => {
    expect(await lookup([video({ created_time })])).toBeNull();
  });
  it("invalid pending time cannot serve as a receipt", async () => {
    expect(await lookup([video()], CAPTION, new Date("invalid"))).toBeNull();
  });
  it("includes the existing ten-minute lower boundary, excludes one millisecond before it", async () => {
    expect(await lookup([video({ created_time: EARLIEST })])).toBe("fb-existing");
    expect(await lookup([video({ created_time: "2026-10-20T23:49:59.999Z" })])).toBeNull();
  });
  it("skips invalid, old and different candidates before the one full match", async () => {
    expect(await lookup([
      video({ id: "wrong", description: `${CAPTION} другой` }),
      video({ id: "old", created_time: "2026-10-20T23:49:59.999Z" }),
      video({ id: "invalid", created_time: "invalid" }),
      video({ description: ` ${CAPTION}\n` }),
    ])).toBe("fb-existing");
  });
  it("two distinct full matches are ambiguous, not an invented published receipt", async () => {
    expect(await lookup([video(), video({ id: "fb-other", description: ` ${CAPTION} ` })])).toEqual({ ambiguous: true });
  });
  it("repeated entries for the same video are one receipt", async () => {
    expect(await lookup([video(), video()])).toBe("fb-existing");
  });
});

describe("Facebook recovery caller: no duplicate POST", () => {
  it.each([false, true])("adopts one trimmed receipt; blocks two distinct receipts (ambiguous=%s)", async (ambiguous) => {
    vi.stubEnv("CRM_PUBLIC_URL", "https://example.com");
    const pending = new Date().toISOString();
    marks.channels = [];
    marks.postIds = { FACEBOOK_PENDING: pending, FACEBOOK_PENDING_AT: pending };
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      const json = (body: unknown) => ({ ok: true, status: 200, json: async () => body }) as Response;
      if (String(url).includes("/videos?fields=")) {
        return json({ data: [video({ description: ` ${CAPTION}\n`, created_time: pending }), ...(ambiguous ? [video({ id: "fb-other", created_time: pending })] : [])] });
      }
      if (String(url).includes("fields=post_id")) return json({ post_id: "test-page-post" });
      if (init?.method === "POST") return json({ id: "fb-duplicate" });
      throw new Error("Unexpected fixture request");
    });
    vi.stubGlobal("fetch", fetchMock);
    const onChannelPublished = vi.fn(async (_result: { ok: boolean }) => {});
    const results = await publishApprovedPost({
      freeVideoId: "test-free-video", localVideoPath: "/uploads/fixture.mp4", caption: CAPTION,
      skipChannels: ["INSTAGRAM", "TELEGRAM", "YOUTUBE", "TIKTOK", "THREADS"], onChannelPublished,
    });
    const result = results.find((r) => r.channel === "FACEBOOK");
    expect(fetchMock.mock.calls.filter(([, init]) => init?.method === "POST")).toHaveLength(0);
    if (ambiguous) {
      expect(result).toMatchObject({ ok: false, outcomeUnknown: true });
      expect(result?.postId).toBeUndefined();
      expect(marks.postIds).toEqual({ FACEBOOK_PENDING: pending, FACEBOOK_PENDING_AT: pending });
      expect(onChannelPublished).not.toHaveBeenCalled();
    } else {
      expect(result).toMatchObject({ ok: true, postId: "fb-existing" });
      expect(marks.postIds).toEqual({});
      expect(onChannelPublished).toHaveBeenCalledWith(expect.objectContaining({ ok: true, postId: "fb-existing" }));
    }
  });
});
