import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
vi.mock("../src/db.js", async (importOriginal) => ({ ...await importOriginal<typeof import("../src/db.js")>(), prisma: { $disconnect: async () => {} } }));
vi.mock("../src/lib/systemError.js", async (importOriginal) => ({ ...await importOriginal<typeof import("../src/lib/systemError.js")>(), logSystemError: vi.fn() }));
import { sniffAudioMime, transcodeToM4a, transcodeToOggOpus } from "../src/lib/audioTranscode.js";

/**
 * ГОЛОСОВОЕ В WHATSAPP (21.11.2026). Живая ошибка: «Audio file uploaded with mimetype as audio/ogg;
 * codecs=opus, however on processing it is of type application/octet-stream». Запись агента с iPhone
 * (Safari пишет mp4) уходила в ogg вместе с тегами контейнера MP4 (major_brand, handler_name
 * «Core Media Audio», vendor_id из нулевых байтов). Теперь: теги снимаются, файл проверяется по
 * содержимому (моно Ogg/Opus — единственный ogg, который принимает WhatsApp, документация Meta).
 */
const ffmpeg = process.env.FFMPEG_BIN || "ffmpeg";
const hasFfmpeg = spawnSync(ffmpeg, ["-version"], { shell: process.platform === "win32" }).status === 0;
const skip = !hasFfmpeg && process.env.AUDIO_TRANSCODE_ALLOW_NO_FFMPEG === "1";
const run = (args: string[]) => {
  const r = spawnSync(ffmpeg, ["-hide_banner", "-loglevel", "error", "-y", ...args], { encoding: "utf8" });
  if (r.status !== 0) throw new Error(r.stderr.slice(-500));
};
const probeTags = (file: string) => spawnSync(process.env.FFPROBE_BIN || "ffprobe", ["-v", "error", "-show_entries", "stream_tags:format_tags:stream=channels,codec_name", "-of", "json", file], { encoding: "utf8" }).stdout;

describe("тип голосового — по содержимому файла", () => {
  it("Ogg с OpusHead — audio/ogg и число каналов; Ogg без Opus — не audio/ogg; mp4, mp3, amr, aac", () => {
    const opusHead = Buffer.concat([Buffer.from("OggS"), Buffer.alloc(24), Buffer.from("OpusHead"), Buffer.from([1, 1, 0x38, 1, 0x80, 0xbb, 0, 0])]);
    expect(sniffAudioMime(opusHead)).toEqual({ mime: "audio/ogg", opusChannels: 1 });
    expect(sniffAudioMime(Buffer.concat([Buffer.from("OggS"), Buffer.alloc(24), Buffer.from("\x01vorbis"), Buffer.alloc(16)]))).toBeNull();
    expect(sniffAudioMime(Buffer.concat([Buffer.from([0, 0, 0, 0x20]), Buffer.from("ftypM4A "), Buffer.alloc(8)]))?.mime).toBe("audio/mp4");
    expect(sniffAudioMime(Buffer.concat([Buffer.from("ID3"), Buffer.alloc(16)]))?.mime).toBe("audio/mpeg");
    expect(sniffAudioMime(Buffer.concat([Buffer.from("#!AMR\n"), Buffer.alloc(16)]))?.mime).toBe("audio/amr");
    expect(sniffAudioMime(Buffer.concat([Buffer.from([0xff, 0xf1]), Buffer.alloc(16)]))?.mime).toBe("audio/aac");
    expect(sniffAudioMime(Buffer.from("<html>not audio</html>"))).toBeNull();
  });

  it("ffmpeg есть (без него голосовое агента не перекодируется вовсе)", () => {
    if (skip) return;
    expect(hasFfmpeg, `ffmpeg не найден; локально пропустить — AUDIO_TRANSCODE_ALLOW_NO_FFMPEG=1`).toBe(true);
  });

  it.skipIf(skip)("запись iPhone (mp4 с тегами контейнера, стерео) → моно Ogg/Opus без тегов MP4; m4a для Instagram тоже без них", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "wa-voice-"));
    try {
      const src = path.join(dir, "iphone.mp4");
      run(["-f", "lavfi", "-i", "sine=f=300:duration=2", "-ac", "2", "-c:a", "aac", "-brand", "iso5",
        "-metadata:s:a", "handler_name=Core Media Audio", "-metadata", "creation_time=2026-11-21T08:05:40Z", src]);
      expect(probeTags(src)).toMatch(/Core Media Audio/);

      const ogg = await transcodeToOggOpus(fs.readFileSync(src));
      expect(ogg).not.toBeNull();
      expect(sniffAudioMime(ogg!)).toEqual({ mime: "audio/ogg", opusChannels: 1 });
      const oggPath = path.join(dir, "out.ogg");
      fs.writeFileSync(oggPath, ogg!);
      const tags = probeTags(oggPath);
      expect(tags).toMatch(/"codec_name": "opus"/);
      expect(tags).not.toMatch(/major_brand|handler_name|compatible_brands|creation_time|vendor_id/);

      const m4a = await transcodeToM4a(fs.readFileSync(src));
      expect(sniffAudioMime(m4a!)?.mime).toBe("audio/mp4");
      const m4aPath = path.join(dir, "out.m4a");
      fs.writeFileSync(m4aPath, m4a!);
      expect(probeTags(m4aPath)).not.toMatch(/Core Media Audio|creation_time/);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }, 60_000);

  it("не аудио на входе — null (агент узнает «не отправлено»), а не файл, который WhatsApp отклонит", async () => {
    if (skip) return;
    expect(await transcodeToOggOpus(Buffer.from("<html>это не звук</html>".repeat(10)))).toBeNull();
  });
});
