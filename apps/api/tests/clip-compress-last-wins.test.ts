import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import fs from "node:fs/promises";
import path from "node:path";

/**
 * Б9 (25.09.2026) — «побеждает последний файл» в задании сжатия клипа карточки.
 *
 * До этой правки идемпотентность держалась только на clipVideoStatus === "READY":
 * это ловило повтор уже записанного задания, но не гонку двух загрузок ДО
 * завершения ни одной из них. Агент грузит А, почти сразу грузит Б (дедупа
 * нарочно нет — свежая загрузка важнее старой), Б сжимается и пишет READY
 * первым, А заканчивает позже и молча переписывает карточку поверх Б своим
 * старым файлом — свежая загрузка терялась без следа и без единого сигнала.
 *
 * ffmpeg в песочнице нет (см. соседние тесты), поэтому мокается сам
 * propertyClipVideo.js — compressClipVideo дописывает файл на диск, а по флагу
 * теста ещё и меняет clipVideoPendingInput ПОСЕРЕДИНЕ своей работы — это и есть
 * гонка «Б обогнал А, пока А сжимал».
 */

let midCompressHook: (() => Promise<void>) | null = null;
const compressClipVideo = vi.fn(async (inputPath: string, outputPath: string) => {
  if (midCompressHook) {
    const hook = midCompressHook;
    midCompressHook = null;
    await hook();
  }
  await fs.writeFile(outputPath, `сжато из ${path.basename(inputPath)}`);
});

vi.mock("../src/lib/propertyClipVideo.js", () => ({
  compressClipVideo: (input: string, output: string) => compressClipVideo(input, output),
  probeDurationSec: vi.fn(),
  MAX_CLIP_VIDEO_DURATION_SEC: 300,
}));

const { clipCompressJob } = await import("../src/jobs/clipCompress.js");
const { prisma } = await import("../src/db.js");
const { clipVideoDir, uploadsDir } = await import("../src/upload.js");

const runId = Date.now();
let districtId = "";
const propertyIds: string[] = [];

async function makeProperty(over: Record<string, unknown> = {}) {
  const property = await prisma.property.create({
    data: {
      title: `Клип — гонка ${runId}-${propertyIds.length}`,
      type: "APARTMENT",
      areaSqm: 45,
      price: 45000,
      currency: "USD",
      districtId,
      address: `Тест-клип ${runId}`,
      condition: "GOOD",
      status: "AVAILABLE",
      ...over,
    },
  });
  propertyIds.push(property.id);
  return property;
}

async function writeVideoFile(dir: string, name: string, content = "видео"): Promise<string> {
  const full = path.join(dir, name);
  await fs.writeFile(full, content);
  return full;
}

async function exists(p: string): Promise<boolean> {
  try {
    await fs.access(p);
    return true;
  } catch {
    return false;
  }
}

beforeAll(async () => {
  districtId = (await prisma.district.create({ data: { name: `Клип-гонка ${runId}` } })).id;
});

afterAll(async () => {
  await prisma.property.deleteMany({ where: { id: { in: propertyIds } } });
  await prisma.district.deleteMany({ where: { id: districtId } });
  await prisma.$disconnect();
});

describe("clipCompressJob — побеждает последний файл", () => {
  it("А устарело ДО старта — выходит молча, incoming-А удалён, статус не тронут", async () => {
    compressClipVideo.mockClear();
    const property = await makeProperty({ clipVideoStatus: "PROCESSING", clipVideoPendingInput: `incoming-Б-${runId}` });
    const inputA = await writeVideoFile(clipVideoDir, `incoming-А-${runId}`);

    await clipCompressJob.run({
      propertyId: property.id,
      inputFilename: `incoming-А-${runId}`,
      outputFilename: `выход-А-${runId}.mp4`,
      previousUrl: null,
      sizeBytes: 1,
      durationSec: 5,
    });

    expect(compressClipVideo).not.toHaveBeenCalled();
    expect(await exists(inputA)).toBe(false);
    const after = await prisma.property.findUniqueOrThrow({ where: { id: property.id } });
    expect(after.clipVideoStatus).toBe("PROCESSING");
    expect(after.clipVideoPendingInput).toBe(`incoming-Б-${runId}`);
    expect(after.clipVideoUrl).toBeNull();
  });

  it("Б выигрывает — READY с файлом Б, прежний готовый файл удалён", async () => {
    compressClipVideo.mockClear();
    const oldReadyName = `старый-готовый-${runId}.mp4`;
    const oldReadyPath = await writeVideoFile(path.join(uploadsDir, "video"), oldReadyName);
    const property = await makeProperty({
      clipVideoStatus: "PROCESSING",
      clipVideoPendingInput: `incoming-Б-${runId}-2`,
      clipVideoUrl: `/uploads/video/${oldReadyName}`,
    });
    const inputB = await writeVideoFile(clipVideoDir, `incoming-Б-${runId}-2`);

    await clipCompressJob.run({
      propertyId: property.id,
      inputFilename: `incoming-Б-${runId}-2`,
      outputFilename: `выход-Б-${runId}.mp4`,
      previousUrl: `/uploads/video/${oldReadyName}`,
      sizeBytes: 1,
      durationSec: 5,
    });

    expect(compressClipVideo).toHaveBeenCalledOnce();
    const after = await prisma.property.findUniqueOrThrow({ where: { id: property.id } });
    expect(after.clipVideoStatus).toBe("READY");
    expect(after.clipVideoUrl).toBe(`/uploads/video/выход-Б-${runId}.mp4`);
    expect(after.clipVideoPendingInput).toBeNull();
    expect(await exists(path.join(clipVideoDir, `выход-Б-${runId}.mp4`))).toBe(true);
    expect(await exists(inputB)).toBe(false); // исходник убран
    expect(await exists(oldReadyPath)).toBe(false); // прежний готовый файл убран
  });

  it("А устарело ПОСЛЕ сжатия (гонка во время работы) — свой выход и вход убраны, clipVideoUrl не изменился", async () => {
    compressClipVideo.mockClear();
    const property = await makeProperty({
      clipVideoStatus: "PROCESSING",
      clipVideoPendingInput: `incoming-А-${runId}-3`,
      clipVideoUrl: null,
    });
    const inputA = await writeVideoFile(clipVideoDir, `incoming-А-${runId}-3`);

    // Пока «А» сжимает, «Б» успевает загрузиться и переписать pendingInput —
    // ровно та гонка, из-за которой раньше терялась свежая загрузка.
    midCompressHook = async () => {
      await prisma.property.update({
        where: { id: property.id },
        data: { clipVideoPendingInput: `incoming-Б-${runId}-3` },
      });
    };

    await clipCompressJob.run({
      propertyId: property.id,
      inputFilename: `incoming-А-${runId}-3`,
      outputFilename: `выход-А-${runId}-3.mp4`,
      previousUrl: null,
      sizeBytes: 1,
      durationSec: 5,
    });

    expect(compressClipVideo).toHaveBeenCalledOnce();
    const after = await prisma.property.findUniqueOrThrow({ where: { id: property.id } });
    // Запись принадлежит «Б» — «А» её не тронуло.
    expect(after.clipVideoStatus).toBe("PROCESSING");
    expect(after.clipVideoUrl).toBeNull();
    expect(after.clipVideoPendingInput).toBe(`incoming-Б-${runId}-3`);
    // Но собственный мусор «А» убрало за собой.
    expect(await exists(path.join(clipVideoDir, `выход-А-${runId}-3.mp4`))).toBe(false);
    expect(await exists(inputA)).toBe(false);
  });

  it("повтор уже записанного задания — ничего не меняет", async () => {
    compressClipVideo.mockClear();
    const readyName = `уже-готово-${runId}.mp4`;
    const property = await makeProperty({
      clipVideoStatus: "READY",
      clipVideoPendingInput: null, // сброшено успешной записью
      clipVideoUrl: `/uploads/video/${readyName}`,
    });
    const staleInput = await writeVideoFile(clipVideoDir, `incoming-А-${runId}-4`);

    await clipCompressJob.run({
      propertyId: property.id,
      inputFilename: `incoming-А-${runId}-4`,
      outputFilename: `выход-А-${runId}-4.mp4`,
      previousUrl: null,
      sizeBytes: 1,
      durationSec: 5,
    });

    expect(compressClipVideo).not.toHaveBeenCalled();
    const after = await prisma.property.findUniqueOrThrow({ where: { id: property.id } });
    expect(after.clipVideoStatus).toBe("READY");
    expect(after.clipVideoUrl).toBe(`/uploads/video/${readyName}`);
    expect(await exists(staleInput)).toBe(false); // повторный запуск всё равно убирает свой временный файл
  });

  it("legacy — задание, поставленное до правки (pendingInput пуст, статус PROCESSING) — READY как раньше", async () => {
    compressClipVideo.mockClear();
    const property = await makeProperty({ clipVideoStatus: "PROCESSING", clipVideoPendingInput: null, clipVideoUrl: null });
    const inputLegacy = await writeVideoFile(clipVideoDir, `incoming-legacy-${runId}`);

    await clipCompressJob.run({
      propertyId: property.id,
      inputFilename: `incoming-legacy-${runId}`,
      outputFilename: `выход-legacy-${runId}.mp4`,
      previousUrl: null,
      sizeBytes: 1,
      durationSec: 5,
    });

    expect(compressClipVideo).toHaveBeenCalledOnce();
    const after = await prisma.property.findUniqueOrThrow({ where: { id: property.id } });
    expect(after.clipVideoStatus).toBe("READY");
    expect(after.clipVideoUrl).toBe(`/uploads/video/выход-legacy-${runId}.mp4`);
    expect(after.clipVideoPendingInput).toBeNull();
    expect(await exists(inputLegacy)).toBe(false);
  });

  it("onGiveUp устаревшего задания не ставит FAILED — карточка уже принадлежит более новой загрузке", async () => {
    const property = await makeProperty({
      clipVideoStatus: "PROCESSING",
      clipVideoPendingInput: `incoming-Б-${runId}-5`, // «Б» уже победило
    });
    const outputA = await writeVideoFile(clipVideoDir, `выход-А-${runId}-5.mp4`);
    const inputA = await writeVideoFile(clipVideoDir, `incoming-А-${runId}-5`);

    await clipCompressJob.onGiveUp({
      propertyId: property.id,
      inputFilename: `incoming-А-${runId}-5`, // «А», не «Б»
      outputFilename: `выход-А-${runId}-5.mp4`,
      previousUrl: null,
      sizeBytes: 1,
      durationSec: 5,
    });

    const after = await prisma.property.findUniqueOrThrow({ where: { id: property.id } });
    // Статус остался PROCESSING (задание «Б» ещё может завершиться) — НЕ FAILED.
    expect(after.clipVideoStatus).toBe("PROCESSING");
    expect(after.clipVideoPendingInput).toBe(`incoming-Б-${runId}-5`);
    // Собственный мусор «А» всё равно убрало.
    expect(await exists(outputA)).toBe(false);
    expect(await exists(inputA)).toBe(false);
  });

  it("onGiveUp актуального задания ставит FAILED как раньше", async () => {
    const property = await makeProperty({
      clipVideoStatus: "PROCESSING",
      clipVideoPendingInput: `incoming-А-${runId}-6`,
    });
    await writeVideoFile(clipVideoDir, `выход-А-${runId}-6.mp4`);
    await writeVideoFile(clipVideoDir, `incoming-А-${runId}-6`);

    await clipCompressJob.onGiveUp({
      propertyId: property.id,
      inputFilename: `incoming-А-${runId}-6`,
      outputFilename: `выход-А-${runId}-6.mp4`,
      previousUrl: null,
      sizeBytes: 1,
      durationSec: 5,
    });

    const after = await prisma.property.findUniqueOrThrow({ where: { id: property.id } });
    expect(after.clipVideoStatus).toBe("FAILED");
    expect(after.clipVideoPendingInput).toBeNull();
  });
});
