import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import sharp from "sharp";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

/**
 * ФАЙЛ ПОД КАНАЛ КЛИЕНТА (25.11.2026, lib/outgoingMediaPrepare.ts): настоящий ffmpeg на
 * файлах, сделанных тут же из генератора ffmpeg (HEVC 10 бит HLG с поворотом, как у iPhone;
 * H.264 High; ролик без звука), и настоящий sharp на фото с EXIF-поворотом и GPS.
 * Проверяется ВЫХОДНОЙ файл через ffprobe: кодек, профиль, цвет, размер, +faststart.
 */

// HEIC: sharp без декодера HEVC, путь идёт через heic-decode — подменяем его пикселями,
// как tests/heic-pixel-cap.test.ts, чтобы не держать бинарный HEIC в репозитории.
vi.mock("heic-decode", () => {
  const image = { width: 64, height: 48, data: new Uint8ClampedArray(64 * 48 * 4).fill(255) };
  const one = vi.fn(async () => image);
  const all = vi.fn(async () => Object.assign([{ width: 64, height: 48, decode: async () => image }], { dispose: () => {} }));
  return { default: Object.assign(one, { all }) };
});

const { META_OUTGOING_MEDIA_LIMITS } = await import("@royal-home/shared");
const {
  channelMediaLimit, metaCompatible, parseProbe, planVideo, prepareOutgoingMedia, probeMedia, scaledSize,
} = await import("../src/lib/outgoingMediaPrepare.js");

let dir: string;
const fx = (name: string) => path.join(dir, name);
const ff = (args: string[]) => execFileSync(process.env.FFMPEG_BIN || "ffmpeg", ["-hide_banner", "-loglevel", "error", "-y", ...args]);

function moovBeforeMdat(file: string): boolean {
  const buf = readFileSync(file);
  const moov = buf.indexOf("moov");
  const mdat = buf.indexOf("mdat");
  return moov > 0 && mdat > 0 && moov < mdat;
}

function ffprobeTags(file: string): string {
  return execFileSync(process.env.FFPROBE_BIN || "ffprobe", ["-v", "error", "-show_entries", "format_tags:stream_tags", "-of", "json", file]).toString();
}

beforeAll(() => {
  dir = mkdtempSync(path.join(os.tmpdir(), "rh-outgoing-media-"));
  // iPhone: HEVC Main 10, HLG, кадр 1280×720 с поворотом 90° (на экране портрет), 60 к/с, звук, геометка.
  ff([
    "-f", "lavfi", "-i", "testsrc2=size=1280x720:rate=60", "-f", "lavfi", "-i", "sine=frequency=440:sample_rate=48000",
    "-t", "3", "-c:v", "libx265", "-preset", "ultrafast", "-pix_fmt", "yuv420p10le",
    "-x265-params", "log-level=error:colorprim=bt2020:transfer=arib-std-b67:colormatrix=bt2020nc",
    "-color_primaries", "bt2020", "-color_trc", "arib-std-b67", "-colorspace", "bt2020nc", "-tag:v", "hvc1",
    "-c:a", "aac", "-metadata", "location=+38.5598+068.7870/", fx("raw-hdr.mov"),
  ]);
  ff(["-display_rotation", "90", "-i", fx("raw-hdr.mov"), "-c", "copy", fx("iphone-hdr.mov")]);
  // Android/камера: H.264 High — WhatsApp его не берёт (B-кадры на Android).
  ff(["-f", "lavfi", "-i", "testsrc2=size=640x360:rate=30", "-f", "lavfi", "-i", "sine=frequency=300",
    "-t", "3", "-c:v", "libx264", "-preset", "veryfast", "-profile:v", "high", "-pix_fmt", "yuv420p", "-c:a", "aac", fx("high.mp4")]);
  // Уже годный: H.264 Main, без звука.
  ff(["-f", "lavfi", "-i", "testsrc2=size=640x360:rate=30", "-t", "3", "-c:v", "libx264", "-preset", "ultrafast",
    "-profile:v", "main", "-pix_fmt", "yuv420p", "-an", fx("main-silent.mp4")]);
  // «Длинное» для маленького предела: 20 секунд шумной картинки.
  ff(["-f", "lavfi", "-i", "testsrc2=size=1280x720:rate=30", "-f", "lavfi", "-i", "sine=frequency=200",
    "-t", "20", "-c:v", "libx264", "-preset", "ultrafast", "-profile:v", "high", "-b:v", "4M", "-c:a", "aac", fx("long.mp4")]);
}, 120_000);

afterAll(() => {
  if (dir) rmSync(dir, { recursive: true, force: true });
});

describe("разбор файла", () => {
  it("поворот 90° меняет стороны местами: на экране портрет", async () => {
    const probe = await probeMedia(fx("iphone-hdr.mov"));
    expect(probe.video).toMatchObject({ codec: "hevc", width: 720, height: 1280, hdr: true, bitDepth10: true });
    expect(probe.majorBrand).toBe("qt");
  });

  it("обложка-картинка в контейнере не считается видео", () => {
    const p = parseProbe({ streams: [{ codec_type: "video", codec_name: "mjpeg", width: 10, height: 10, disposition: { attached_pic: 1 } }] });
    expect(p.video).toBeNull();
  });
});

describe("план для видео (чистая функция)", () => {
  const base = parseProbe({
    format: { duration: "30", format_name: "mov,mp4" },
    streams: [
      { codec_type: "video", codec_name: "h264", profile: "Main", pix_fmt: "yuv420p", width: 1080, height: 1920, avg_frame_rate: "30/1" },
      { codec_type: "audio", codec_name: "aac" },
    ],
  });

  it("годный и лёгкий — только перекладка, без перекодирования", () => {
    expect(planVideo(base, "WHATSAPP", 5 * 1024 * 1024)).toEqual({ kind: "remux" });
  });

  it("High в WhatsApp — перекодирование, даже если влезает", () => {
    const high = { ...base, video: { ...base.video!, profile: "High" } };
    expect(metaCompatible(high, "WHATSAPP")).toBe(false);
    expect(metaCompatible(high, "INSTAGRAM")).toBe(true);
    expect(planVideo(high, "WHATSAPP", 1024).kind).toBe("transcode");
  });

  it("битрейт посчитан под предел канала с запасом, кадр не больше 720p и не увеличивается", () => {
    const plan = planVideo(base, "WHATSAPP", 200 * 1024 * 1024);
    expect(plan.kind).toBe("transcode");
    if (plan.kind !== "transcode") return;
    const bytes = ((plan.videoKbps + plan.audioKbps) * 1000 * 30) / 8;
    expect(bytes).toBeLessThan(META_OUTGOING_MEDIA_LIMITS.WHATSAPP.video * 0.93);
    expect(Math.min(plan.width, plan.height)).toBeLessThanOrEqual(720);
    expect(scaledSize(320, 240, 720)).toEqual({ width: 320, height: 240 });
  });

  it("слишком длинное для WhatsApp — честная ссылка, а не каша; для Instagram — ещё файл", () => {
    const sixMin = { ...base, durationSec: 6 * 60 };
    expect(planVideo(sixMin, "WHATSAPP", 300 * 1024 * 1024).kind).toBe("link");
    expect(planVideo(sixMin, "INSTAGRAM", 300 * 1024 * 1024).kind).toBe("transcode");
    const hour = { ...base, durationSec: 3600 };
    const plan = planVideo(hour, "INSTAGRAM", 900 * 1024 * 1024);
    expect(plan).toEqual({ kind: "link", reason: "too_long", viewingCopy: null });
  });

  it("Telegram — оригинал, только перекладка, пока влезает в предел сервера Bot API", () => {
    const limit = channelMediaLimit("TELEGRAM", "video");
    expect(planVideo({ ...base, durationSec: 3600 }, "TELEGRAM", limit)).toEqual({ kind: "remux" });
    // Облачный Bot API (20 МБ, без своего сервера) — сжатие под его предел, а не отказ.
    expect(planVideo({ ...base, durationSec: 60 }, "TELEGRAM", limit + 1).kind).toBe("transcode");
  });
});

describe("настоящее сжатие", () => {
  it("HDR HEVC с iPhone → WhatsApp: H.264 Main, обычный цвет, портрет, 30 к/с, +faststart, без геометки", async () => {
    const size = statSync(fx("iphone-hdr.mov")).size;
    const out = await prepareOutgoingMedia({ path: fx("iphone-hdr.mov"), mimetype: "video/quicktime", size }, "WHATSAPP", { workDir: dir });
    expect(out.action).toBe("transcoded");
    expect(out.mimetype).toBe("video/mp4");
    expect(out.size).toBeLessThanOrEqual(META_OUTGOING_MEDIA_LIMITS.WHATSAPP.video);
    const p = await probeMedia(out.path);
    expect(p.video).toMatchObject({ codec: "h264", profile: "Main", pixFmt: "yuv420p", hdr: false, fps: 30 });
    expect(p.video!.height).toBeGreaterThan(p.video!.width);
    expect(p.audio?.codec).toBe("aac");
    expect(moovBeforeMdat(out.path)).toBe(true);
    expect(ffprobeTags(fx("iphone-hdr.mov"))).toContain("location");
    expect(ffprobeTags(out.path)).not.toContain("location");
  }, 120_000);

  it("H.264 Main без звука → только перекладка, звука не появляется", async () => {
    const size = statSync(fx("main-silent.mp4")).size;
    const out = await prepareOutgoingMedia({ path: fx("main-silent.mp4"), mimetype: "video/mp4", size }, "WHATSAPP", { workDir: dir });
    expect(out.action).toBe("remuxed");
    const p = await probeMedia(out.path);
    expect(p.audio).toBeNull();
    expect(p.video?.codec).toBe("h264");
  }, 60_000);

  it("H.264 High → WhatsApp перекодируется в Main", async () => {
    const size = statSync(fx("high.mp4")).size;
    const out = await prepareOutgoingMedia({ path: fx("high.mp4"), mimetype: "video/mp4", size }, "WHATSAPP", { workDir: dir });
    expect(out.action).toBe("transcoded");
    expect((await probeMedia(out.path)).video?.profile).toBe("Main");
  }, 60_000);

  it("тесный предел: сжато точно под потолок; ещё теснее — ссылка, клиенту не уходит «каша»", async () => {
    const saved = { ...META_OUTGOING_MEDIA_LIMITS.WHATSAPP };
    try {
      META_OUTGOING_MEDIA_LIMITS.WHATSAPP.video = 1024 * 1024; // 1 МБ на 20 секунд ≈ 380 кбит/с
      const size = statSync(fx("long.mp4")).size;
      const fit = await prepareOutgoingMedia({ path: fx("long.mp4"), mimetype: "video/mp4", size }, "WHATSAPP", { workDir: dir });
      expect(fit.sendAsLink).toBe(false);
      expect(fit.size).toBeLessThanOrEqual(1024 * 1024);
      expect(Math.min((await probeMedia(fit.path)).video!.width, (await probeMedia(fit.path)).video!.height)).toBeLessThanOrEqual(360);

      META_OUTGOING_MEDIA_LIMITS.WHATSAPP.video = 300 * 1024; // ниже нижнего предела качества
      const link = await prepareOutgoingMedia({ path: fx("long.mp4"), mimetype: "video/mp4", size }, "WHATSAPP", { workDir: dir });
      expect(link.sendAsLink).toBe(true);
      expect(link.action).toBe("link-copy");
      // Копия для просмотра — играет сразу в браузере клиента.
      expect(moovBeforeMdat(link.path)).toBe(true);
    } finally {
      Object.assign(META_OUTGOING_MEDIA_LIMITS.WHATSAPP, saved);
    }
  }, 180_000);

  it("Telegram: HEVC с iPhone уходит оригиналом в MP4 (перекладка, качество то же)", async () => {
    const size = statSync(fx("iphone-hdr.mov")).size;
    const out = await prepareOutgoingMedia({ path: fx("iphone-hdr.mov"), mimetype: "video/quicktime", size }, "TELEGRAM", { workDir: dir });
    expect(out.action).toBe("remuxed");
    const p = await probeMedia(out.path);
    expect(p.video).toMatchObject({ codec: "hevc", hdr: true });
    expect(moovBeforeMdat(out.path)).toBe(true);
  }, 60_000);

  it("отмена обрывает ffmpeg", async () => {
    const controller = new AbortController();
    const size = statSync(fx("long.mp4")).size;
    const run = prepareOutgoingMedia({ path: fx("long.mp4"), mimetype: "video/mp4", size }, "WHATSAPP", {
      workDir: dir, signal: controller.signal,
    });
    setTimeout(() => controller.abort(), 150);
    await expect(run).rejects.toMatchObject({ code: "aborted" });
  }, 60_000);
});

describe("фото", () => {
  async function photoWithGps(width: number, height: number, orientation: number): Promise<string> {
    const file = fx(`photo-${width}-${orientation}.jpg`);
    const noise = Buffer.alloc(width * height * 3);
    for (let i = 0; i < noise.length; i++) noise[i] = (i * 2654435761) >>> 24;
    await sharp(noise, { raw: { width, height, channels: 3 } })
      .withMetadata({ orientation, exif: { IFD0: { Make: "Apple", Model: "iPhone" }, IFD3: { GPSLatitudeRef: "N", GPSLatitude: "38/1 33/1 12/1" } } })
      .jpeg({ quality: 98 })
      .toFile(file);
    return file;
  }

  it("EXIF и GPS удалены, поворот применён, вес под пределом канала", async () => {
    const file = await photoWithGps(1200, 800, 6);
    const before = await sharp(file).metadata();
    expect(before.exif).toBeDefined();
    const out = await prepareOutgoingMedia({ path: file, mimetype: "image/jpeg", size: statSync(file).size }, "WHATSAPP", { workDir: dir });
    const meta = await sharp(out.path).metadata();
    expect(meta.exif).toBeUndefined();
    expect(meta.orientation).toBeUndefined();
    expect([meta.width, meta.height]).toEqual([800, 1200]);
    expect(out.mimetype).toBe("image/jpeg");
    expect(readFileSync(out.path).includes(Buffer.from("iPhone"))).toBe(false);
  });

  it("тяжёлое фото не отклоняется, а сжимается под предел", async () => {
    const file = await photoWithGps(2400, 1600, 1);
    const saved = { ...META_OUTGOING_MEDIA_LIMITS.WHATSAPP };
    try {
      META_OUTGOING_MEDIA_LIMITS.WHATSAPP.image = 250 * 1024;
      expect(statSync(file).size).toBeGreaterThan(250 * 1024);
      const out = await prepareOutgoingMedia({ path: file, mimetype: "image/jpeg", size: statSync(file).size }, "WHATSAPP", { workDir: dir });
      expect(out.size).toBeLessThanOrEqual(250 * 1024);
    } finally {
      Object.assign(META_OUTGOING_MEDIA_LIMITS.WHATSAPP, saved);
    }
  });

  it("PNG с прозрачностью остаётся PNG", async () => {
    const file = fx("alpha.png");
    await sharp({ create: { width: 300, height: 200, channels: 4, background: { r: 0, g: 0, b: 255, alpha: 0.3 } } }).png().toFile(file);
    const out = await prepareOutgoingMedia({ path: file, mimetype: "image/png", size: statSync(file).size }, "INSTAGRAM", { workDir: dir });
    expect(out.mimetype).toBe("image/png");
    expect((await sharp(out.path).metadata()).hasAlpha).toBe(true);
  });

  it("HEIC с iPhone → JPEG", async () => {
    const file = fx("photo.heic");
    const header = Buffer.alloc(64);
    header.writeUInt32BE(24, 0);
    header.write("ftypheic", 4, "latin1");
    writeFileSync(file, header);
    const out = await prepareOutgoingMedia({ path: file, mimetype: "image/heic", size: 64 }, "WHATSAPP", { workDir: dir });
    expect(out.mimetype).toBe("image/jpeg");
    expect((await sharp(out.path).metadata()).format).toBe("jpeg");
  });
});

describe("голосовое: запись Chrome и Safari доходит в любой канал (deliverVoiceToConversation)", () => {
  it("webm/opus (Chrome) и mp4/aac (Safari) → Ogg/Opus для WhatsApp и Telegram, M4A для Instagram и Messenger", async () => {
    const { transcodeToOggOpus, transcodeToM4a, sniffAudioMime } = await import("../src/lib/audioTranscode.js");
    ff(["-f", "lavfi", "-i", "sine=frequency=500:sample_rate=48000", "-t", "2", "-c:a", "libopus", fx("chrome.webm")]);
    ff(["-f", "lavfi", "-i", "sine=frequency=500:sample_rate=44100", "-t", "2", "-c:a", "aac", "-f", "mp4", fx("safari.mp4")]);
    for (const src of ["chrome.webm", "safari.mp4"]) {
      const ogg = await transcodeToOggOpus(readFileSync(fx(src)));
      expect(sniffAudioMime(ogg!)?.mime).toBe("audio/ogg");
      const m4a = await transcodeToM4a(readFileSync(fx(src)));
      expect(sniffAudioMime(m4a!)?.mime).toBe("audio/mp4");
    }
  }, 60_000);
});
