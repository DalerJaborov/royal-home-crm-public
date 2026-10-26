import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { clipPreviewReason, prepareClipForTelegram } from "../src/lib/clipReviewPreview.js";
import { probeMediaInfo, resolveFfmpegBin, type MediaInfo } from "../src/lib/ffmpeg.js";

/**
 * Ролик на проверку в Telegram (26.10.2026): обычный уходит оригиналом с
 * размерами и обложкой, повёрнутый/HEVC/огромный — копией для просмотра с
 * применённым поворотом. Без ffmpeg на машине часть с настоящими файлами пропускается.
 */

const LIMIT = 50 * 1024 * 1024;
const media = (over: Partial<MediaInfo> = {}): MediaInfo => ({
  hasVideo: true,
  hasAudio: true,
  videoCodec: "h264",
  audioCodec: "aac",
  width: 1080,
  height: 1920,
  rotation: 0,
  durationSec: 30,
  sizeBytes: 1000,
  ...over,
});

describe("когда оригинал нельзя показать как есть", () => {
  it("H.264 без поворота в пределах размера — оригинал", () => {
    expect(clipPreviewReason(media(), 1000, LIMIT)).toBeNull();
  });
  it("HEVC, поворот, больше предела — копия", () => {
    expect(clipPreviewReason(media({ videoCodec: "hevc" }), 1000, LIMIT)).toContain("hevc");
    expect(clipPreviewReason(media({ rotation: -90 }), 1000, LIMIT)).toContain("поворот");
    expect(clipPreviewReason(media(), LIMIT + 1, LIMIT)).toContain("предела");
  });
  it("ffprobe не ответил — оригинал", () => {
    expect(clipPreviewReason(null, 1000, LIMIT)).toBeNull();
  });
});

const hasFfmpeg = spawnSync(resolveFfmpegBin("ffmpeg"), ["-version"], { stdio: "ignore" }).status === 0;
const dir = path.join(os.tmpdir(), `clip-preview-test-${randomUUID()}`);

function ffmpeg(args: string[]) {
  const r = spawnSync(resolveFfmpegBin("ffmpeg"), ["-y", "-hide_banner", "-v", "error", ...args], { encoding: "utf8" });
  if (r.status !== 0) throw new Error(r.stderr);
}

describe.skipIf(!hasFfmpeg)("настоящие файлы", () => {
  let plain: string;
  let rotated: string;

  beforeAll(async () => {
    await fs.mkdir(dir, { recursive: true });
    plain = path.join(dir, "plain.mp4");
    rotated = path.join(dir, "rotated.mp4");
    ffmpeg(["-f", "lavfi", "-i", "testsrc=size=320x180:duration=3:rate=25", "-f", "lavfi", "-i", "sine=duration=3",
      "-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "aac", "-shortest", plain]);
    // Как с телефона: кадры ландшафтные, на экране — портрет (поворот в метаданных).
    ffmpeg(["-display_rotation", "90", "-i", plain, "-c", "copy", rotated]);
  });

  afterAll(async () => {
    await fs.rm(dir, { recursive: true, force: true });
  });

  it("обычный ролик — оригинал с размерами, длительностью и обложкой", async () => {
    const info = await probeMediaInfo(plain);
    const stat = await fs.stat(plain);
    const clip = await prepareClipForTelegram(plain, info, stat.size, LIMIT);
    try {
      expect(clip.transcoded).toBe(false);
      expect(clip.videoPath).toBe(plain);
      expect([clip.width, clip.height]).toEqual([320, 180]);
      expect(clip.durationSec).toBeGreaterThan(2);
      expect(clip.thumbnailPath).not.toBeNull();
      await expect(fs.stat(clip.thumbnailPath!)).resolves.toBeTruthy();
    } finally {
      await clip.cleanup();
    }
    await expect(fs.stat(plain)).resolves.toBeTruthy(); // оригинал уборка не трогает
  });

  it("повёрнутый ролик — копия, где поворот уже применён: портрет без тега поворота", async () => {
    const info = await probeMediaInfo(rotated);
    expect(Math.abs(info!.rotation)).toBe(90);
    const stat = await fs.stat(rotated);
    const clip = await prepareClipForTelegram(rotated, info, stat.size, LIMIT);
    try {
      expect(clip.transcoded).toBe(true);
      expect(clip.width).toBeLessThan(clip.height!);
      const out = await probeMediaInfo(clip.videoPath);
      expect(out!.rotation % 360).toBe(0);
      expect(out!.videoCodec).toBe("h264");
      expect(clip.thumbnailPath).not.toBeNull();
    } finally {
      await clip.cleanup();
    }
    await expect(fs.stat(clip.videoPath)).rejects.toThrow();
  });
});
