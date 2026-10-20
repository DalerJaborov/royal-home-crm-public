import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import bcrypt from "bcrypt";
import request from "supertest";

/**
 * ФАКТЫ СЫРОГО ВИДЕО — звук/длительность/размеры/кодек (23.09.2026, задание C).
 * Объект №127: IMG_8361.mov с iPhone был БЕЗ звука уже при загрузке, и это не
 * увидел никто — ни агент, ни модератор (одобрил видео), ни монтажёр. Три
 * группы проверок:
 *  1. describeRawVideo — одна строка фактов, пустые поля пропускаются молча;
 *  2. probeRawVideoFacts — разбор JSON ffprobe (hasAudio по наличию
 *     audio-потока, rotation ±90/270 переставляет экранные width/height);
 *  3. запись фактов ПОСЛЕ загрузки через POST /:id/videos — ffprobe замокан
 *     (реального бинарника в тесте нет, тот же приём, что и в
 *     tiktok-video-transcode.test.ts), а сама загрузка и запись в БД настоящие.
 */

const tryRunFfmpeg = vi.fn();
vi.mock("../src/lib/ffmpeg.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/lib/ffmpeg.js")>();
  return {
    ...actual,
    tryRunFfmpeg: (...args: unknown[]) => tryRunFfmpeg(...args),
  };
});

const { app } = await import("../src/app.js");
const { prisma } = await import("../src/db.js");
const { probeRawVideoFacts, describeRawVideo } = await import("../src/lib/rawVideoFacts.js");
const { waitFor } = await import("./helpers/waitFor.js");

function ffprobeResult(opts: {
  hasAudio?: boolean;
  width?: number;
  height?: number;
  codec?: string;
  durationSec?: number;
  rotation?: number;
  rotateTag?: string;
}) {
  const videoStream: Record<string, unknown> = {
    codec_type: "video",
    codec_name: opts.codec ?? "hevc",
    width: opts.width ?? 1080,
    height: opts.height ?? 1920,
  };
  if (opts.rotation != null) videoStream.side_data_list = [{ side_data_type: "Display Matrix", rotation: opts.rotation }];
  if (opts.rotateTag != null) videoStream.tags = { rotate: opts.rotateTag };
  const streams = [videoStream];
  if (opts.hasAudio !== false) streams.push({ codec_type: "audio", codec_name: "aac" });
  return {
    stdout: JSON.stringify({ streams, format: { duration: String(opts.durationSec ?? 80) } }),
    stderrTail: "",
    durationMs: 5,
  };
}

describe("describeRawVideo", () => {
  it("собирает все факты в одну строку через ' · '", () => {
    expect(
      describeRawVideo({ hasAudio: false, durationSec: 80, width: 2160, height: 3840, videoCodec: "HEVC" })
    ).toBe("1:20 · 2160×3840 · HEVC · ⚠ БЕЗ ЗВУКА");
  });

  it("звук есть — чип «без звука» не появляется", () => {
    expect(describeRawVideo({ hasAudio: true, durationSec: 5, width: 100, height: 100, videoCodec: "H264" })).toBe(
      "0:05 · 100×100 · H264"
    );
  });

  it("пустые/неразобранные поля пропускаются молча, не «null»", () => {
    expect(describeRawVideo({})).toBe("");
    expect(describeRawVideo({ hasAudio: null, durationSec: null, width: null, height: null, videoCodec: null })).toBe("");
    expect(describeRawVideo({ durationSec: 61 })).toBe("1:01");
  });
});

describe("probeRawVideoFacts", () => {
  afterAll(() => vi.clearAllMocks());

  it("видео + аудио, без поворота — hasAudio true, размеры как есть", async () => {
    tryRunFfmpeg.mockResolvedValueOnce(ffprobeResult({ width: 1078, height: 1920, codec: "hevc", durationSec: 45.6 }));
    const facts = await probeRawVideoFacts("/tmp/whatever.mp4");
    expect(facts).toEqual({ hasAudio: true, durationSec: 45.6, width: 1078, height: 1920, videoCodec: "HEVC" });
  });

  it("аудиопотока нет вовсе — hasAudio false (объект №127, IMG_8361.mov)", async () => {
    tryRunFfmpeg.mockResolvedValueOnce(ffprobeResult({ hasAudio: false, width: 3840, height: 2160, codec: "hevc" }));
    const facts = await probeRawVideoFacts("/tmp/img8361.mov");
    expect(facts?.hasAudio).toBe(false);
  });

  it("rotation=-90 (Display Matrix, современный iPhone) — экранные width/height переставлены", async () => {
    tryRunFfmpeg.mockResolvedValueOnce(ffprobeResult({ width: 3840, height: 2160, rotation: -90 }));
    const facts = await probeRawVideoFacts("/tmp/rotated.mov");
    expect(facts).toMatchObject({ width: 2160, height: 3840 });
  });

  it("rotation=270 через старый тег rotate — тоже переставляет", async () => {
    tryRunFfmpeg.mockResolvedValueOnce(ffprobeResult({ width: 1920, height: 1080, rotateTag: "270" }));
    const facts = await probeRawVideoFacts("/tmp/rotated-tag.mp4");
    expect(facts).toMatchObject({ width: 1080, height: 1920 });
  });

  it("rotation=180 — НЕ переставляет (перевёрнуто, не повёрнуто на четверть)", async () => {
    tryRunFfmpeg.mockResolvedValueOnce(ffprobeResult({ width: 1920, height: 1080, rotation: 180 }));
    const facts = await probeRawVideoFacts("/tmp/upside-down.mp4");
    expect(facts).toMatchObject({ width: 1920, height: 1080 });
  });

  it("ffprobe недоступен (tryRunFfmpeg вернул null) — null, не бросает", async () => {
    tryRunFfmpeg.mockResolvedValueOnce(null);
    await expect(probeRawVideoFacts("/tmp/whatever.mp4")).resolves.toBeNull();
  });

  it("битый JSON в stdout — null", async () => {
    tryRunFfmpeg.mockResolvedValueOnce({ stdout: "не json", stderrTail: "", durationMs: 1 });
    await expect(probeRawVideoFacts("/tmp/whatever.mp4")).resolves.toBeNull();
  });

  it("нет видеопотока вовсе (аудиофайл по ошибке) — null", async () => {
    tryRunFfmpeg.mockResolvedValueOnce({
      stdout: JSON.stringify({ streams: [{ codec_type: "audio", codec_name: "aac" }], format: { duration: "10" } }),
      stderrTail: "",
      durationMs: 1,
    });
    await expect(probeRawVideoFacts("/tmp/audio-only.mp3")).resolves.toBeNull();
  });
});

describe("запись фактов после загрузки (POST /:id/videos)", () => {
  const runId = Date.now();
  const password = "testpass123";
  let districtId: string;
  let agentId: string;
  let token: string;
  let propertyId: string;

  beforeAll(async () => {
    const passwordHash = await bcrypt.hash(password, 10);
    districtId = (await prisma.district.create({ data: { name: `Тест-факты-видео-${runId}` } })).id;
    agentId = (
      await prisma.agent.create({
        data: { fullName: "Агент фактов видео", phone: `+992955${runId}`, role: "AGENT", passwordHash },
      })
    ).id;
    const res = await request(app).post("/api/v1/auth/login").send({ phone: `+992955${runId}`, password });
    expect(res.status).toBe(200);
    token = res.body.accessToken as string;

    const p = await prisma.property.create({
      data: {
        title: `Факты видео ${runId}`,
        type: "APARTMENT",
        areaSqm: 50,
        price: 40000,
        currency: "TJS",
        districtId,
        address: "Тестовая, 1",
        condition: "GOOD",
        status: "EDITING",
        intakeAgentId: agentId,
        createdById: agentId,
      },
    });
    propertyId = p.id;
  });

  afterAll(async () => {
    await prisma.propertyVideo.deleteMany({ where: { propertyId } }).catch(() => {});
    await prisma.property.deleteMany({ where: { id: propertyId } }).catch(() => {});
    await prisma.agent.deleteMany({ where: { id: agentId } }).catch(() => {});
    await prisma.district.deleteMany({ where: { id: districtId } }).catch(() => {});
  });

  it("ответ агенту уходит СРАЗУ с пустыми фактами, БД дописывается фоном (не задерживает загрузку)", async () => {
    tryRunFfmpeg.mockResolvedValueOnce(
      ffprobeResult({ hasAudio: false, width: 2160, height: 3840, codec: "hevc", durationSec: 80 })
    );

    const uploadRes = await request(app)
      .post(`/api/v1/properties/${propertyId}/videos`)
      .set("Authorization", `Bearer ${token}`)
      .attach("videos", Buffer.from("видео IMG_8361"), { filename: "IMG_8361.mov", contentType: "video/quicktime" });

    expect(uploadRes.status).toBe(201);
    expect(uploadRes.body[0]).toMatchObject({ filename: "IMG_8361.mov", hasAudio: null, durationSec: null });
    const videoId = uploadRes.body[0].id as string;

    const updated = await waitFor(
      async () => {
        const row = await prisma.propertyVideo.findUnique({ where: { id: videoId } });
        return row?.hasAudio === false ? row : null;
      },
      { label: "факты видео записаны фоном" }
    );
    expect(updated).toMatchObject({ hasAudio: false, durationSec: 80, width: 2160, height: 3840, videoCodec: "HEVC" });

    // GET отдаёт то же самое наружу через presentVideo.
    const getRes = await request(app)
      .get(`/api/v1/properties/${propertyId}/videos`)
      .set("Authorization", `Bearer ${token}`);
    expect(getRes.status).toBe(200);
    expect(getRes.body.find((v: { id: string }) => v.id === videoId)).toMatchObject({
      hasAudio: false,
      durationSec: 80,
      width: 2160,
      height: 3840,
      videoCodec: "HEVC",
    });
  });

  it("ffprobe отказал (null) — поля остаются null, загрузка не страдает", async () => {
    tryRunFfmpeg.mockResolvedValueOnce(null);

    const uploadRes = await request(app)
      .post(`/api/v1/properties/${propertyId}/videos`)
      .set("Authorization", `Bearer ${token}`)
      .attach("videos", Buffer.from("видео без ffprobe"), { filename: "no-ffprobe.mp4", contentType: "video/mp4" });

    expect(uploadRes.status).toBe(201);
    const videoId = uploadRes.body[0].id as string;

    // Ждём settle: без ffprobe факты и не появятся — просто даём фону отработать.
    await new Promise((resolve) => setTimeout(resolve, 100));
    const row = await prisma.propertyVideo.findUnique({ where: { id: videoId } });
    expect(row).toMatchObject({ hasAudio: null, durationSec: null, width: null, height: null, videoCodec: null });
  });
});
