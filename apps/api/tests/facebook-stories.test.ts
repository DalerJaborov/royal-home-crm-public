import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * ИСТОРИИ FACEBOOK (28.09.2026, Page Stories API у Meta с 11.2023) —
 * lib/socialPublish.ts::publishFacebookStoryImage/publishFacebookStoryVideo.
 * Тот же приём подмены global.fetch, что и у Историй Instagram
 * (social-publish-instagram-story.test.ts) — настоящий Graph API не дёргается.
 */

const { publishFacebookStoryImage, publishFacebookStoryVideo } = await import("../src/lib/socialPublish.js");

function jsonResponse(body: unknown, ok = true, status = 200): Response {
  return { ok, status, json: async () => body } as unknown as Response;
}

beforeEach(() => {
  vi.useRealTimers();
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("publishFacebookStoryImage", () => {
  it("уходит двумя шагами: /photos (published:false), затем /photo_stories", async () => {
    const calls: Array<{ url: string; body: unknown }> = [];
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      calls.push({ url, body: init?.body ? JSON.parse(init.body as string) : undefined });
      if (url.includes("/photo_stories")) return jsonResponse({ success: true, post_id: "fb-story-post-1" });
      return jsonResponse({ id: "fb-photo-1" });
    });
    vi.stubGlobal("fetch", fetchMock);

    const result = await publishFacebookStoryImage("page-1", "token", "https://crm.example/uploads/handoff/card.jpg");

    expect(result.ok).toBe(true);
    expect(result.channel).toBe("FACEBOOK");
    expect(result.postId).toBe("fb-story-post-1");

    const photoCall = calls.find((c) => c.url.includes("/photos"));
    expect(photoCall?.body).toMatchObject({ url: "https://crm.example/uploads/handoff/card.jpg", published: false });

    const storyCall = calls.find((c) => c.url.includes("/photo_stories"));
    expect(storyCall?.body).toMatchObject({ photo_id: "fb-photo-1" });
  });

  it("Graph API отказал на /photos — честный отказ, до photo_stories не доходим", async () => {
    const fetchMock = vi.fn(async (url: string) => {
      if (url.includes("/photo_stories")) throw new Error("не должны были дойти сюда");
      return jsonResponse({ error: { message: "Invalid image URL" } }, false, 400);
    });
    vi.stubGlobal("fetch", fetchMock);

    const result = await publishFacebookStoryImage("page-1", "token", "https://crm.example/uploads/handoff/bad.jpg");

    expect(result.ok).toBe(false);
    expect(result.error).toBe("Invalid image URL");
  });

  it("photo_stories отказал (success:false) — честный отказ", async () => {
    const fetchMock = vi.fn(async (url: string) => {
      if (url.includes("/photo_stories")) return jsonResponse({ error: { message: "Media not eligible for stories" } }, false, 400);
      return jsonResponse({ id: "fb-photo-2" });
    });
    vi.stubGlobal("fetch", fetchMock);

    const result = await publishFacebookStoryImage("page-1", "token", "https://crm.example/uploads/handoff/c.jpg");

    expect(result.ok).toBe(false);
    expect(result.error).toBe("Media not eligible for stories");
  });
});

describe("publishFacebookStoryVideo", () => {
  it("уходит тремя шагами: start → upload_url → finish, video_status=ready", async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      calls.push({ url, init });
      if (url.includes("upload.example/bytes")) return jsonResponse({});
      if (url.includes("fields=status")) return jsonResponse({ status: { video_status: "ready" } });
      if (init?.body && (init.body as string).includes('"finish"')) return jsonResponse({ success: true, post_id: "fb-video-post-1" });
      return jsonResponse({ video_id: "fb-video-1", upload_url: "https://upload.example/bytes" });
    });
    vi.stubGlobal("fetch", fetchMock);

    const result = await publishFacebookStoryVideo("page-1", "token", "https://crm.example/uploads/handoff/a.mp4");

    expect(result.ok).toBe(true);
    expect(result.postId).toBe("fb-video-post-1");
    expect(result.note).toBeUndefined();

    const startCall = calls.find((c) => c.init?.body && (c.init.body as string).includes('"start"'));
    expect(startCall).toBeTruthy();

    const uploadCall = calls.find((c) => c.url === "https://upload.example/bytes");
    expect(uploadCall?.init?.headers).toMatchObject({ Authorization: "OAuth token", file_url: "https://crm.example/uploads/handoff/a.mp4" });

    const finishCall = calls.find((c) => c.init?.body && (c.init.body as string).includes('"finish"'));
    expect(finishCall?.init?.body).toContain("fb-video-1");
  });

  it("отказ на finish — честный отказ, несмотря на успешные start/upload", async () => {
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      if (url.includes("upload.example/bytes")) return jsonResponse({});
      if (url.includes("fields=status")) return jsonResponse({ status: { video_status: "ready" } });
      if (init?.body && (init.body as string).includes('"finish"')) return jsonResponse({ error: { message: "Video processing failed" } }, false, 400);
      return jsonResponse({ video_id: "fb-video-2", upload_url: "https://upload.example/bytes" });
    });
    vi.stubGlobal("fetch", fetchMock);

    const result = await publishFacebookStoryVideo("page-1", "token", "https://crm.example/uploads/handoff/b.mp4");

    expect(result.ok).toBe(false);
    expect(result.error).toBe("Video processing failed");
  });

  it("не дождались video_status (всегда processing) — не отказ, finish всё равно зовём, ok:true с note", async () => {
    // Лесенка ожидания (CONTAINER_POLL_INTERVALS_MS) суммарно ~4м42с — фейковые
    // часы, тот же приём, что и у ожидания контейнера Instagram
    // (social-publish-instagram-pending.test.ts).
    vi.useFakeTimers();
    try {
      const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
        if (url.includes("upload.example/bytes")) return jsonResponse({});
        if (url.includes("fields=status")) return jsonResponse({ status: { video_status: "processing" } });
        if (init?.body && (init.body as string).includes('"finish"')) return jsonResponse({ success: true, post_id: "fb-video-post-3" });
        return jsonResponse({ video_id: "fb-video-3", upload_url: "https://upload.example/bytes" });
      });
      vi.stubGlobal("fetch", fetchMock);

      const resultPromise = publishFacebookStoryVideo("page-1", "token", "https://crm.example/uploads/handoff/c.mp4");
      await vi.advanceTimersByTimeAsync(30 * 60 * 1000);
      const result = await resultPromise;

      expect(result.ok).toBe(true);
      expect(result.postId).toBe("fb-video-post-3");
      expect(result.note).toMatch(/не подтвердила обработку/);
    } finally {
      vi.useRealTimers();
    }
  });

  it("Graph API отказал уже на start — до upload не доходим", async () => {
    const fetchMock = vi.fn(async (url: string) => {
      if (url.includes("upload.example")) throw new Error("не должны были дойти сюда");
      return jsonResponse({ error: { message: "Insufficient permission" } }, false, 400);
    });
    vi.stubGlobal("fetch", fetchMock);

    const result = await publishFacebookStoryVideo("page-1", "token", "https://crm.example/uploads/handoff/d.mp4");

    expect(result.ok).toBe(false);
    expect(result.error).toBe("Insufficient permission");
  });

  it("отказ на загрузке байтов (upload_url) — честный отказ, до finish не доходим", async () => {
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      if (url.includes("upload.example/bytes")) return jsonResponse({ error: { message: "Upload failed" } }, false, 400);
      if (init?.body && (init.body as string).includes('"finish"')) throw new Error("не должны были дойти сюда");
      return jsonResponse({ video_id: "fb-video-5", upload_url: "https://upload.example/bytes" });
    });
    vi.stubGlobal("fetch", fetchMock);

    const result = await publishFacebookStoryVideo("page-1", "token", "https://crm.example/uploads/handoff/e.mp4");

    expect(result.ok).toBe(false);
    expect(result.error).toContain("Upload failed");
  });
});
