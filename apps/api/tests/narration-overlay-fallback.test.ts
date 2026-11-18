import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

/**
 * ТЕКСТ НЕ НАРИСОВАЛСЯ — РОЛИК ВСЁ РАВНО СОБИРАЕТСЯ (ревью 18.11.2026). Фильтр текста подменён заведомо
 * ломающимся (шрифта нет): сведение повторяется без текста, руководству — строка в журнале.
 */
const log = vi.hoisted(() => vi.fn());
vi.mock("../src/lib/systemError.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/lib/systemError.js")>()),
  logSystemError: log,
}));
vi.mock("../src/lib/video/narrationOverlay.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/lib/video/narrationOverlay.js")>()),
  drawtextAvailable: async () => true,
  buildOverlayFilter: () => "drawtext=fontfile='/no/such/font.ttf':text='x',nosuchfilter_rh=1",
}));

const FF = process.env.FFMPEG_BIN || "ffmpeg";
const ffmpegReady = spawnSync(FF, ["-version"], { stdio: "ignore" }).status === 0;
const { mixNarrationOntoMaster } = await import("../src/lib/narrationMix.js");
const { probeMediaInfo } = await import("../src/lib/ffmpeg.js");
const tmp = path.join(os.tmpdir(), `narration-overlay-fallback-${Date.now()}`);

beforeAll(async () => {
  await fs.mkdir(tmp, { recursive: true });
  if (!ffmpegReady) return;
  const ff = (args: string[]) => { if (spawnSync(FF, ["-y", "-hide_banner", "-loglevel", "error", ...args], { stdio: "ignore" }).status !== 0) throw new Error(args.join(" ")); };
  ff(["-f", "lavfi", "-i", "color=c=0x445566:size=320x568:rate=25:duration=4", "-f", "lavfi", "-i", "sine=frequency=440:duration=4", "-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "aac", "-shortest", path.join(tmp, "master.mp4")]);
  ff(["-f", "lavfi", "-i", "sine=frequency=700:duration=2", "-c:a", "libmp3lame", path.join(tmp, "voice.mp3")]);
}, 60_000);
afterAll(async () => { await fs.rm(tmp, { recursive: true, force: true }); });

describe.skipIf(!ffmpegReady)("текст на ролике: отказ фильтра", { timeout: 60_000 }, () => {
  it("ffmpeg не смог нарисовать текст — ролик собран без текста, строка в журнал", async () => {
    const out = path.join(tmp, "out.mp4");
    const res = await mixNarrationOntoMaster({ masterPath: path.join(tmp, "master.mp4"), voicePath: path.join(tmp, "voice.mp3"), outPath: out, fit: { allowFreeze: true },
      textOverlay: { price: "9 000 с.", script: "Квартира на продажу." } });
    expect(res.ok).toBe(true);
    const info = (await probeMediaInfo(out))!;
    expect(info.hasVideo && info.hasAudio).toBe(true);
    expect(log).toHaveBeenCalledWith("video-handoff", expect.stringContaining("не нарисованы"), { dedupKey: "narration-overlay-failed" });
  });
});
