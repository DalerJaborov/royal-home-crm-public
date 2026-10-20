import { EventEmitter } from "node:events";
import { afterEach, describe, expect, it, vi } from "vitest";

/**
 * probeMediaInfo / probeVideoDimensions (lib/ffmpeg.ts, 23.09.2026) — разбор
 * реального случая (объект №127): iPhone .mov 3840×2160 с side_data
 * rotation=-90 без аудиопотока. `probeMediaInfo` зовёт `tryRunFfmpeg` НАПРЯМУЮ
 * внутри того же модуля (не через импорт), поэтому подменить нужно не сам
 * экспорт `tryRunFfmpeg` (vi.mock на ffmpeg.js для его собственных внутренних
 * вызовов не действует — это тот же самый файл), а `node:child_process::spawn`
 * ПОД ним — тот же приём, что и в tests/property-clip-video-upload.test.ts
 * (ffmpeg/ffprobe в песочнице нет, бинарники не найдены).
 */

type FakeProbeBehavior = { stdout?: string; exitCode: number };
let nextBehavior: FakeProbeBehavior = { stdout: "", exitCode: 0 };

vi.mock("node:child_process", () => ({
  spawn: vi.fn(() => {
    const proc = new EventEmitter() as EventEmitter & { stdout: EventEmitter; stderr: EventEmitter; kill: () => void };
    proc.stdout = new EventEmitter();
    proc.stderr = new EventEmitter();
    proc.kill = () => {};
    setImmediate(() => {
      if (nextBehavior.stdout !== undefined) proc.stdout.emit("data", Buffer.from(nextBehavior.stdout));
      proc.emit("close", nextBehavior.exitCode);
    });
    return proc;
  }),
}));

const { probeMediaInfo, probeVideoDimensions } = await import("../src/lib/ffmpeg.js");

function setFfprobeJson(json: unknown) {
  nextBehavior = { stdout: JSON.stringify(json), exitCode: 0 };
}

afterEach(() => {
  nextBehavior = { stdout: "", exitCode: 0 };
});

describe("probeMediaInfo", () => {
  it("iPhone-портрет: side_data rotation=-90 меняет ширину/высоту местами, аудио нет", async () => {
    setFfprobeJson({
      streams: [
        {
          index: 0,
          codec_type: "video",
          codec_name: "hevc",
          width: 3840,
          height: 2160,
          side_data_list: [{ side_data_type: "Display Matrix", rotation: -90 }],
        },
      ],
      format: { duration: "35.950000", size: "123456789" },
    });

    const info = await probeMediaInfo("/tmp/fake.mov");

    expect(info).not.toBeNull();
    expect(info?.hasVideo).toBe(true);
    expect(info?.hasAudio).toBe(false);
    // Экранные размеры, не сырые из потока — iPhone-пример из докстринга.
    expect(info?.width).toBe(2160);
    expect(info?.height).toBe(3840);
    expect(info?.rotation).toBe(-90);
    expect(info?.durationSec).toBeCloseTo(35.95);
  });

  it("тег rotate вместо side_data — то же самое переворачивание", async () => {
    setFfprobeJson({
      streams: [
        { index: 0, codec_type: "video", codec_name: "h264", width: 1920, height: 1080, tags: { rotate: "90" } },
        { index: 1, codec_type: "audio", codec_name: "aac" },
      ],
      format: { duration: "12.0", size: "1000" },
    });

    const info = await probeMediaInfo("/tmp/fake.mp4");

    expect(info?.width).toBe(1080);
    expect(info?.height).toBe(1920);
    expect(info?.hasAudio).toBe(true);
    expect(info?.audioCodec).toBe("aac");
  });

  it("rotation=180 не переставляет размеры (не входит в {90,270})", async () => {
    setFfprobeJson({
      streams: [{ index: 0, codec_type: "video", codec_name: "h264", width: 1920, height: 1080, side_data_list: [{ rotation: 180 }] }],
      format: { duration: "5.0", size: "500" },
    });

    const info = await probeMediaInfo("/tmp/fake.mp4");

    expect(info?.width).toBe(1920);
    expect(info?.height).toBe(1080);
  });

  it("нормальный ролик со звуком — hasVideo и hasAudio оба true", async () => {
    setFfprobeJson({
      streams: [
        { index: 0, codec_type: "video", codec_name: "h264", width: 1080, height: 1920 },
        { index: 1, codec_type: "audio", codec_name: "aac" },
      ],
      format: { duration: "22.3", size: "999" },
    });

    const info = await probeMediaInfo("/tmp/ok.mp4");

    expect(info?.hasVideo).toBe(true);
    expect(info?.hasAudio).toBe(true);
    expect(info?.width).toBe(1080);
    expect(info?.height).toBe(1920);
  });

  it("ffprobe недоступен (код возврата не 0) — null", async () => {
    nextBehavior = { stdout: "", exitCode: 1 };
    expect(await probeMediaInfo("/tmp/missing.mp4")).toBeNull();
  });

  it("пустой/битый stdout — null, не бросает", async () => {
    nextBehavior = { stdout: "", exitCode: 0 };
    expect(await probeMediaInfo("/tmp/empty.mp4")).toBeNull();

    nextBehavior = { stdout: "не json вообще", exitCode: 0 };
    expect(await probeMediaInfo("/tmp/broken.mp4")).toBeNull();
  });
});

describe("probeVideoDimensions — теперь поверх probeMediaInfo", () => {
  it("отдаёт экранные (перевёрнутые) width/height — чинит искажение в Telegram (объект №127)", async () => {
    setFfprobeJson({
      streams: [{ index: 0, codec_type: "video", codec_name: "hevc", width: 3840, height: 2160, side_data_list: [{ rotation: -90 }] }],
      format: { duration: "35.95", size: "123" },
    });

    const dims = await probeVideoDimensions("/tmp/fake.mov");

    expect(dims).toEqual({ width: 2160, height: 3840, durationSec: 35.95 });
  });

  it("нет видеопотока вовсе — null", async () => {
    setFfprobeJson({ streams: [{ index: 0, codec_type: "audio", codec_name: "aac" }], format: { duration: "5", size: "1" } });

    expect(await probeVideoDimensions("/tmp/audio-only.mp4")).toBeNull();
  });

  it("ffprobe недоступен — null", async () => {
    nextBehavior = { stdout: "", exitCode: 1 };
    expect(await probeVideoDimensions("/tmp/missing.mp4")).toBeNull();
  });
});
