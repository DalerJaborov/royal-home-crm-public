import fs from "node:fs";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import request from "supertest";
import { app } from "../src/app.js";
import { signMediaToken } from "../src/auth/jwt.js";
import { clipVideoDir, thumbsDir, uploadsDir } from "../src/upload.js";
import {
  UPLOADS_IMMUTABLE_CACHE_CONTROL,
  UPLOADS_NO_CACHE,
  UPLOADS_PRIVATE_CACHE_CONTROL,
  uploadsCacheControl,
} from "../src/lib/uploadsCacheControl.js";

/**
 * Кэш файлов /uploads (17.11.2026, аудит скорости P1): фото и миниатюры с
 * уникальным именем — 30 дней immutable; звуки телефонии (перезаписываются под
 * тем же именем) — no-cache; закрытые папки — без общего кэша; всё прочее — как
 * было до правки (max-age=0).
 */

const runId = `${Date.now()}-${process.pid}`;
const created: string[] = [];
const telephonyDir = path.join(uploadsDir, "telephony");
const telephonyFile = path.join(telephonyDir, "queue.mp3");
let telephonyExisted = false;

function put(full: string, body: string) {
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, body);
  created.push(full);
}

beforeAll(() => {
  put(path.join(uploadsDir, `cache-photo-${runId}.webp`), "photo");
  put(path.join(thumbsDir, `cache-photo-${runId}.webp`), "thumb");
  put(path.join(uploadsDir, "msg", `cache-msg-${runId}.webp`), "msg");
  put(path.join(clipVideoDir, `cache-video-${runId}.mp4`), "video");
  // Чужой настоящий звук (если он есть на этой машине) не трогаем.
  telephonyExisted = fs.existsSync(telephonyFile);
  if (!telephonyExisted) put(telephonyFile, "sound");
});

afterAll(() => {
  for (const full of created) fs.rmSync(full, { force: true });
});

describe("uploadsCacheControl — правило по пути", () => {
  it("фото в корне и миниатюры — долгий immutable", () => {
    expect(uploadsCacheControl("0b5c.webp")).toBe(UPLOADS_IMMUTABLE_CACHE_CONTROL);
    expect(uploadsCacheControl("thumbs/0b5c.webp")).toBe(UPLOADS_IMMUTABLE_CACHE_CONTROL);
    expect(uploadsCacheControl("thumbs\\0b5c.JPG")).toBe(UPLOADS_IMMUTABLE_CACHE_CONTROL);
    expect(uploadsCacheControl("logo-1731830400000.webp")).toBe(UPLOADS_IMMUTABLE_CACHE_CONTROL);
  });

  it("телефония — no-cache, закрытые папки — private", () => {
    expect(uploadsCacheControl("telephony/greeting.wav")).toBe(UPLOADS_NO_CACHE);
    expect(uploadsCacheControl("telephony/moh.mp3")).toBe(UPLOADS_NO_CACHE);
    expect(uploadsCacheControl("video/x.mp4")).toBe(UPLOADS_PRIVATE_CACHE_CONTROL);
    expect(uploadsCacheControl("automontage/covers/x.jpg")).toBe(UPLOADS_PRIVATE_CACHE_CONTROL);
    expect(uploadsCacheControl("handoff/x.jpg")).toBe(UPLOADS_PRIVATE_CACHE_CONTROL);
  });

  it("всё, что не проверено поимённо, остаётся на умолчании (null)", () => {
    for (const rel of ["msg/a.webp", "covers/a.jpg", "photo-posts/a.jpg", "avatars-fallback/a.webp", "lead-magnets/a.pdf", "a.pdf", "../etc/passwd.png", "thumbs/../x.webp"]) {
      expect(uploadsCacheControl(rel), rel).toBeNull();
    }
  });
});

describe("GET /uploads — заголовки на настоящих ответах", () => {
  it("фото объекта — 30 дней immutable", async () => {
    const res = await request(app).get(`/uploads/cache-photo-${runId}.webp`);
    expect(res.status).toBe(200);
    expect(res.headers["cache-control"]).toBe("public, max-age=2592000, immutable");
  });

  it("миниатюра — 30 дней immutable, и повтор по ETag (304) несёт тот же заголовок", async () => {
    const first = await request(app).get(`/uploads/thumbs/cache-photo-${runId}.webp`);
    expect(first.status).toBe(200);
    expect(first.headers["cache-control"]).toBe(UPLOADS_IMMUTABLE_CACHE_CONTROL);
    const again = await request(app).get(`/uploads/thumbs/cache-photo-${runId}.webp`).set("If-None-Match", first.headers.etag);
    expect(again.status).toBe(304);
    expect(again.headers["cache-control"]).toBe(UPLOADS_IMMUTABLE_CACHE_CONTROL);
  });

  it("звук телефонии — no-cache, не долгий", async () => {
    const res = await request(app).get("/uploads/telephony/queue.mp3");
    expect(res.status).toBe(200);
    expect(res.headers["cache-control"]).toBe("no-cache");
  });

  it("закрытое видео по подписи — private, без публичного кэша", async () => {
    const rel = `/uploads/video/cache-video-${runId}.mp4`;
    const res = await request(app).get(`${rel}?t=${signMediaToken(rel)}`);
    expect(res.status).toBe(200);
    expect(res.headers["cache-control"]).toBe("private, no-cache");
    expect(res.headers["cache-control"]).not.toMatch(/public|immutable/);
  });

  it("непроверенная папка (фото переписки) — прежнее умолчание max-age=0", async () => {
    const res = await request(app).get(`/uploads/msg/cache-msg-${runId}.webp`);
    expect(res.status).toBe(200);
    expect(res.headers["cache-control"]).toBe("public, max-age=0");
  });
});
