import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import sharp from "sharp";
import { setFacebookVideoThumbnail, setYouTubeThumbnail, youtubeThumbnailFromSquare } from "../src/lib/socialPublish.js";

/**
 * ОБЛОЖКА В FACEBOOK И YOUTUBE (25.09.2026, «обложки везде, где можно»). Обе
 * ставятся отдельным вызовом ПОСЛЕ публикации: отказ площадки — строка в
 * журнал публикации, не исключение. Сеть подменена.
 */
let squarePath: string;
const youtubeCreds = { clientId: "cid", clientSecret: "secret", refreshToken: "refresh" };

beforeAll(async () => {
  squarePath = path.join(os.tmpdir(), `square-${Date.now()}.jpg`);
  await fs.writeFile(squarePath, await sharp({ create: { width: 1080, height: 1080, channels: 3, background: { r: 200, g: 170, b: 60 } } }).jpeg().toBuffer());
});
afterEach(() => vi.unstubAllGlobals());
afterAll(async () => fs.rm(squarePath, { force: true }));

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

describe("Facebook: превью видео", () => {
  it("успех — квадрат уходит multipart в /{video-id}/thumbnails, заметки нет", async () => {
    const fetchMock = vi.fn(async () => json(200, { success: true }));
    vi.stubGlobal("fetch", fetchMock);
    expect(await setFacebookVideoThumbnail("vid1", "page-token", squarePath)).toBeNull();
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toMatch(/\/vid1\/thumbnails$/);
    const form = init.body as FormData;
    expect(form.get("is_preferred")).toBe("true");
    expect(form.get("source")).toBeInstanceOf(Blob);
  });

  it("Facebook отверг — понятная заметка, без исключения", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => json(400, { error: { message: "Invalid parameter" } })));
    const note = await setFacebookVideoThumbnail("vid1", "page-token", squarePath);
    expect(note).toMatch(/Facebook не принял обложку/);
    expect(note).toMatch(/видео опубликовано/);
  });
});

describe("YouTube: thumbnails.set", () => {
  it("квадрат превращается в 1280×720 с полями", async () => {
    const img = await youtubeThumbnailFromSquare(squarePath);
    expect(await sharp(img).metadata()).toMatchObject({ width: 1280, height: 720 });
  });

  function stubYouTube(thumbReply: Response) {
    const fetchMock = vi.fn(async (url: string) => (url.includes("oauth2.googleapis.com") ? json(200, { access_token: "at", scope: "x" }) : thumbReply));
    vi.stubGlobal("fetch", fetchMock);
    return fetchMock;
  }

  it("успех — заметки нет, JPEG уходит с Bearer", async () => {
    const fetchMock = stubYouTube(json(200, { items: [] }));
    expect(await setYouTubeThumbnail(youtubeCreds, "yt1", squarePath)).toBeNull();
    const call = fetchMock.mock.calls.find((c) => String(c[0]).includes("thumbnails/set")) as unknown as [string, RequestInit];
    expect(call[0]).toMatch(/videoId=yt1/);
    expect((call[1].headers as Record<string, string>).Authorization).toBe("Bearer at");
  });

  it("403 insufficient scopes — рецепт перевыпуска токена, не ошибка", async () => {
    stubYouTube(json(403, { error: { message: "Request had insufficient authentication scopes." } }));
    const note = await setYouTubeThumbnail(youtubeCreds, "yt1", squarePath);
    expect(note).toMatch(/youtube\.force-ssl/);
    expect(note).toMatch(/youtube-oauth-refresh-check/);
  });
});
