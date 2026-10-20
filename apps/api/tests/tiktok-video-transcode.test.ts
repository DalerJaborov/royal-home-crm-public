import { afterEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";

/**
 * HEVC → H.264 перед TikTok (17.09.2026) — lib/socialPublish.ts::tiktokPrepareUploadPath.
 * Ролики монтажёра приходят в H.265 (hevc) с нечётной шириной (живой пример: 1078) —
 * TikTok такое отклоняет. Мокаем lib/ffmpeg.ts целиком (тот же приём, что уже
 * применяется к сети в tiktok-publish.test.ts) — реального ffprobe/ffmpeg в этом
 * тесте нет, проверяется только ветка решения "перекодировать / не перекодировать".
 *
 * Реальные временные файлы (не спай на fs/promises) — надёжнее для проверки
 * cleanup(): ESM-интероп между тестовым файлом и socialPublish.ts не гарантирует,
 * что спай на импортированный объект `fs` попадёт в тот же модульный инстанс.
 */

const tryRunFfmpeg = vi.fn();
const runFfmpeg = vi.fn();
vi.mock("../src/lib/ffmpeg.js", () => ({
  tryRunFfmpeg: (...args: unknown[]) => tryRunFfmpeg(...args),
  runFfmpeg: (...args: unknown[]) => runFfmpeg(...args),
}));
vi.mock("../src/lib/systemError.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/lib/systemError.js")>()),
  logSystemError: vi.fn().mockResolvedValue(undefined),
}));
// db.js не нужен этой ветке кода, но socialPublish.ts импортирует prisma на верхнем
// уровне — без мока модуль не загрузится без реальной DATABASE_URL.
vi.mock("../src/db.js", () => ({
  prisma: { settings: { update: vi.fn() }, $disconnect: async () => {} },
}));

const { tiktokPrepareUploadPath } = await import("../src/lib/socialPublish.js");

function ffprobeStdout(codec: string, width: number, height: number) {
  return { stdout: `${codec},${width},${height}`, stderrTail: "", durationMs: 5 };
}

let videoPath: string;
let outputPath: string;

afterEach(async () => {
  vi.clearAllMocks();
  await fs.rm(videoPath, { force: true }).catch(() => {});
  await fs.rm(outputPath, { force: true }).catch(() => {});
});

describe("tiktokPrepareUploadPath", () => {
  it("h264, чётные размеры — не перекодирует, отдаёт исходный путь", async () => {
    videoPath = path.join(os.tmpdir(), `tt-transcode-${Date.now()}.mp4`);
    outputPath = videoPath.replace(/\.mp4$/, "-tiktok.mp4");
    tryRunFfmpeg.mockResolvedValue(ffprobeStdout("h264", 1080, 1920));
    const result = await tiktokPrepareUploadPath(videoPath);
    expect(result.uploadPath).toBe(videoPath);
    expect(runFfmpeg).not.toHaveBeenCalled();
    await expect(result.cleanup()).resolves.toBeUndefined();
  });

  it("hevc — перекодирует в <basename>-tiktok.mp4, H.264, вертикальный scale 1080:-2", async () => {
    videoPath = path.join(os.tmpdir(), `tt-transcode-${Date.now()}.mp4`);
    outputPath = videoPath.replace(/\.mp4$/, "-tiktok.mp4");
    tryRunFfmpeg.mockResolvedValue(ffprobeStdout("hevc", 1078, 1920));
    runFfmpeg.mockResolvedValue({ stdout: "", stderrTail: "", durationMs: 100 });
    const result = await tiktokPrepareUploadPath(videoPath);
    expect(result.uploadPath).toBe(outputPath);
    expect(runFfmpeg).toHaveBeenCalledTimes(1);
    const call = runFfmpeg.mock.calls[0][0] as { args: string[] };
    expect(call.args).toContain("libx264");
    expect(call.args).toContain("scale=1080:-2");
    expect(call.args).toContain(outputPath);
  });

  it("h264, но нечётная ширина — тоже перекодирует (чётность важнее кодека)", async () => {
    videoPath = path.join(os.tmpdir(), `tt-transcode-${Date.now()}.mp4`);
    outputPath = videoPath.replace(/\.mp4$/, "-tiktok.mp4");
    tryRunFfmpeg.mockResolvedValue(ffprobeStdout("h264", 1079, 1920));
    runFfmpeg.mockResolvedValue({ stdout: "", stderrTail: "", durationMs: 100 });
    const result = await tiktokPrepareUploadPath(videoPath);
    expect(result.uploadPath).toBe(outputPath);
    expect(runFfmpeg).toHaveBeenCalledTimes(1);
  });

  it("горизонтальный ролик — scale -2:1080, а не 1080:-2", async () => {
    videoPath = path.join(os.tmpdir(), `tt-transcode-${Date.now()}.mp4`);
    outputPath = videoPath.replace(/\.mp4$/, "-tiktok.mp4");
    tryRunFfmpeg.mockResolvedValue(ffprobeStdout("hevc", 1920, 1080));
    runFfmpeg.mockResolvedValue({ stdout: "", stderrTail: "", durationMs: 100 });
    const result = await tiktokPrepareUploadPath(videoPath);
    const call = runFfmpeg.mock.calls[0][0] as { args: string[] };
    expect(call.args).toContain("scale=-2:1080");
    expect(result.uploadPath).toBe(outputPath);
  });

  it("ffprobe недоступен (tryRunFfmpeg вернул null) — грузим оригинал как есть", async () => {
    videoPath = path.join(os.tmpdir(), `tt-transcode-${Date.now()}.mp4`);
    outputPath = videoPath.replace(/\.mp4$/, "-tiktok.mp4");
    tryRunFfmpeg.mockResolvedValue(null);
    const result = await tiktokPrepareUploadPath(videoPath);
    expect(result.uploadPath).toBe(videoPath);
    expect(runFfmpeg).not.toHaveBeenCalled();
  });

  it("ffmpeg упал на перекодировке — грузим оригинал, недописанный временный файл подчищен", async () => {
    videoPath = path.join(os.tmpdir(), `tt-transcode-${Date.now()}.mp4`);
    outputPath = videoPath.replace(/\.mp4$/, "-tiktok.mp4");
    // Симулируем недописанный файл, который реальный ffmpeg мог оставить при отказе.
    await fs.writeFile(outputPath, "частично записанный файл");
    tryRunFfmpeg.mockResolvedValue(ffprobeStdout("hevc", 1078, 1920));
    runFfmpeg.mockRejectedValue(new Error("ffmpeg (перекодировка ролика под TikTok) завершился с кодом 1"));
    const result = await tiktokPrepareUploadPath(videoPath);
    expect(result.uploadPath).toBe(videoPath);
    await expect(fs.access(outputPath)).rejects.toThrow(); // подчищен catch-веткой tiktokPrepareUploadPath
  });

  it("cleanup() после успешной перекодировки удаляет временный файл", async () => {
    videoPath = path.join(os.tmpdir(), `tt-transcode-${Date.now()}.mp4`);
    outputPath = videoPath.replace(/\.mp4$/, "-tiktok.mp4");
    tryRunFfmpeg.mockResolvedValue(ffprobeStdout("hevc", 1078, 1920));
    // Мок runFfmpeg не пишет реальный файл — создаём его сами, как это сделал бы
    // настоящий ffmpeg, чтобы cleanup() было что реально удалить.
    runFfmpeg.mockImplementation(async () => {
      await fs.writeFile(outputPath, "перекодированное видео");
      return { stdout: "", stderrTail: "", durationMs: 100 };
    });
    const result = await tiktokPrepareUploadPath(videoPath);
    await expect(fs.access(outputPath)).resolves.toBeUndefined(); // файл реально создан
    await result.cleanup();
    await expect(fs.access(outputPath)).rejects.toThrow(); // и реально удалён
  });
});
