import { execFile } from "node:child_process";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import sharp from "sharp";

function run(command: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(command, args, { timeout: 5_000, maxBuffer: 65_536, windowsHide: true, encoding: "utf8" },
      (error, stdout) => error ? reject(new Error("media_probe_unavailable")) : resolve(stdout));
  });
}

/** Local, fail-closed inspection; never accepts a caller-controlled filesystem path. */
export async function inspectAssistantMedia(buffer: Buffer, mimeType: string, maxAudioSeconds = 120): Promise<void> {
  if (mimeType.startsWith("image/")) {
    const metadata = await sharp(buffer, { limitInputPixels: 20_000_000 }).metadata();
    const format = { "image/jpeg": "jpeg", "image/png": "png", "image/webp": "webp" }[mimeType];
    if (metadata.format !== format || !metadata.width || !metadata.height
      || metadata.width * metadata.height > 20_000_000 || (metadata.pages ?? 1) !== 1) {
      throw new Error("media_invalid_image");
    }
    return;
  }
  const directory = await mkdtemp(join(tmpdir(), "assistant-media-"));
  try {
    const path = join(directory, mimeType === "application/pdf" ? "input.pdf" : "input.audio");
    await writeFile(path, buffer, { mode: 0o600 });
    if (mimeType === "application/pdf") {
      if (buffer.subarray(0, 5).toString("ascii") !== "%PDF-") throw new Error("media_invalid_pdf");
      const info = await run("pdfinfo", [path]);
      const pages = Number(/^Pages:\s+(\d+)\s*$/m.exec(info)?.[1]);
      if (!Number.isSafeInteger(pages) || pages < 1 || pages > 20 || !/^Encrypted:\s+no\s*$/m.test(info)) {
        throw new Error("media_pdf_limit");
      }
    } else {
      const info = JSON.parse(await run("ffprobe", ["-v", "error", "-show_entries", "format=duration:stream=codec_type", "-of", "json", path]));
      const duration = Number(info.format?.duration);
      if (!Number.isFinite(duration) || duration <= 0 || duration > maxAudioSeconds || !Array.isArray(info.streams)
        || !info.streams.length || info.streams.some((stream: { codec_type?: string }) => stream.codec_type !== "audio")) {
        throw new Error("media_audio_limit");
      }
    }
  } finally {
    // Only the exact directory freshly created above; no user-controlled path components.
    await rm(directory, { recursive: true, force: true });
  }
}
