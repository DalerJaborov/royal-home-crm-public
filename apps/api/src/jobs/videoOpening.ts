import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { z } from "zod";
import { OPENING_SHOTS, type OpeningShot } from "@royal-home/shared";
import { prisma } from "../db.js";
import { callAiText, type ImageInput } from "../ai/client.js";
import { probeDurationSec, tryRunFfmpeg } from "../lib/ffmpeg.js";
import { logSystemError } from "../lib/systemError.js";
import { videoHandoffFinalDiskPath } from "../lib/videoHandoff.js";
import { VIDEO_OPENING_JOB_TYPE } from "../lib/videoOpening.js";
import type { JobHandler } from "./registry.js";

/**
 * РАЗБОР НАЧАЛА РОЛИКА (24.09.2026, Dan: «разбор первых секунд ролика»).
 *
 * Три кадра первых трёх секунд готового ролика (0,2 с, 1,5 с, 3 с) — один
 * вызов ИИ с картинками, как оценка фото продавца (jobs/sellerPhotoInsight.ts):
 * что показано первым (закрытый список OPENING_SHOTS — чтобы ролики можно было
 * сравнивать группами), есть ли человек и надпись, насколько начало цепляет и
 * что поставить в начало вместо этого. Итог — строка VideoOpening на пару
 * (объект, файл ролика): тот же файл второй раз не смотрим, новый ролик
 * объекта — новый разбор.
 *
 * Ставится с экрана (lib/firstSeconds.ts), а не по расписанию: разбор нужен
 * только тем роликам, которые вышли и которые кто-то смотрит в статистике.
 */

const schema = z.object({ propertyId: z.string(), videoPath: z.string() });
type Payload = z.infer<typeof schema>;

/** Секунды, с которых берём кадры — «первые три секунды», за которые зритель решает, листать ли дальше. */
export const OPENING_FRAME_AT_SEC = [0.2, 1.5, 3] as const;
/** Ширина кадра для ИИ — узнать кухню или фасад хватает, лишние байты — лишние деньги. */
const FRAME_WIDTH = 480;

const EXTRACT_MODEL = process.env.GEMINI_EXTRACT_MODEL || "gemini-3.1-flash-lite";

export const VIDEO_OPENING_SCHEMA = {
  type: "object",
  properties: {
    firstShot: {
      type: "string",
      enum: [...OPENING_SHOTS],
      description:
        "Что зритель видит ПЕРВЫМ (первый кадр): FACADE — дом снаружи, ENTRANCE — подъезд/вход/лестница, LIVING_ROOM — гостиная, BEDROOM — спальня, KITCHEN — кухня, BATHROOM — ванная/санузел, VIEW — вид из окна или с балкона, YARD — двор/территория, PERSON — главное в кадре человек (агент, ведущий), TEXT — главное в кадре надпись или заставка, OTHER — другое",
    },
    hasPerson: { type: "boolean", description: "true — в первых трёх секундах в кадре есть человек" },
    hasText: { type: "boolean", description: "true — в первых трёх секундах на экране есть надпись (цена, район, заголовок)" },
    hookScore: {
      type: "number",
      description:
        "0-10: насколько первые три секунды заставят остановиться в ленте. Высоко — яркий, светлый, самый выигрышный вид объекта или цена/выгода крупно; низко — тёмный, пустой, случайный кадр, долгий подход к дому",
    },
    note: { type: "string", description: "Одна короткая фраза по-русски: что показано в первые три секунды" },
    tip: {
      type: "string",
      description:
        "Одна короткая фраза по-русски, простыми словами: что поставить в начало, чтобы не листали дальше. Пустая строка, если начало уже хорошее",
    },
  },
  required: ["firstShot", "hasPerson", "hasText", "hookScore", "note"],
};

interface ModelOpening {
  firstShot: string;
  hasPerson: boolean;
  hasText: boolean;
  hookScore: number;
  note: string;
  tip?: string;
}

/** Кадры в пределах ролика: у двухсекундного ролика «3 секунды» — последний кадр, а не пустота. */
export function openingFrameTimes(durationSec: number | null): number[] {
  if (durationSec === null) return [...OPENING_FRAME_AT_SEC];
  const last = Math.max(0, durationSec - 0.1);
  return [...new Set(OPENING_FRAME_AT_SEC.map((t) => Math.min(t, last)))];
}

async function extractFrame(videoDiskPath: string, atSec: number, outPath: string): Promise<ImageInput | null> {
  const result = await tryRunFfmpeg({
    args: [
      "-y",
      "-hide_banner",
      "-v",
      "error",
      "-ss",
      String(atSec),
      "-i",
      videoDiskPath,
      "-frames:v",
      "1",
      "-vf",
      `scale=${FRAME_WIDTH}:-2`,
      "-q:v",
      "4",
      outPath,
    ],
    timeoutMs: 20_000,
    label: "первые секунды ролика: кадр",
  });
  if (!result) return null;
  try {
    const buf = await fs.promises.readFile(outPath);
    return buf.length > 0 ? { mediaType: "image/jpeg", data: buf.toString("base64") } : null;
  } catch {
    return null;
  }
}

function clampHook(n: unknown): number {
  const v = typeof n === "number" && Number.isFinite(n) ? n : 0;
  return Math.max(0, Math.min(10, Math.round(v)));
}

function oneLine(s: unknown, max: number): string | null {
  if (typeof s !== "string") return null;
  const t = s.replace(/\s+/g, " ").trim();
  return t ? t.slice(0, max) : null;
}

/**
 * Разобрать начало одного ролика и записать итог. Возвращает, чем кончилось —
 * для теста и журнала. "stale" — у объекта уже другой ролик: разбирать старый
 * файл незачем, для нового экран поставит своё задание.
 */
export async function analyzeVideoOpening(payload: Payload): Promise<"ok" | "no-file" | "failed" | "stale"> {
  const property = await prisma.property.findUnique({
    where: { id: payload.propertyId },
    select: { videoHandoffFinalPath: true, deletedAt: true },
  });
  if (!property || property.deletedAt || property.videoHandoffFinalPath !== payload.videoPath) return "stale";

  const key = { propertyId_videoPath: { propertyId: payload.propertyId, videoPath: payload.videoPath } };
  const save = (data: {
    status: "OK" | "NO_FILE" | "FAILED";
    firstShot?: OpeningShot | null;
    hasPerson?: boolean;
    hasText?: boolean;
    hookScore?: number | null;
    note?: string | null;
    tip?: string | null;
    durationSec?: number | null;
  }) =>
    prisma.videoOpening.upsert({
      where: key,
      create: { propertyId: payload.propertyId, videoPath: payload.videoPath, ...data },
      update: data,
    });

  const diskPath = videoHandoffFinalDiskPath(payload.videoPath);
  if (!diskPath || !fs.existsSync(diskPath)) {
    await save({ status: "NO_FILE" });
    return "no-file";
  }

  const durationSec = await probeDurationSec(diskPath);
  const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "rh-opening-"));
  try {
    const frames: ImageInput[] = [];
    for (const [i, t] of openingFrameTimes(durationSec).entries()) {
      const frame = await extractFrame(diskPath, t, path.join(dir, `f${i}.jpg`));
      if (frame) frames.push(frame);
    }
    if (frames.length === 0) {
      void logSystemError("api", `Первые секунды ролика: не удалось достать кадры (объект ${payload.propertyId})`, {
        dedupKey: "video-opening-frames",
      });
      await save({ status: "FAILED", durationSec });
      return "failed";
    }

    const result = await callAiText<ModelOpening>({
      endpoint: "video-opening",
      system:
        "Ты маркетолог агентства недвижимости Royal Home в Душанбе. Тебе дают кадры первых трёх секунд короткого " +
        "ролика об объекте (Reels/Shorts/TikTok) по порядку. За эти секунды зритель решает, листать ли дальше. " +
        "Определи, что показано первым, есть ли в кадре человек и надпись, насколько начало цепляет (0–10) и что " +
        "поставить в начало вместо этого. По-русски, простыми словами, без англицизмов. Ответь строго JSON по схеме.",
      user: `Кадров: ${frames.length}, по порядку: ${openingFrameTimes(durationSec)
        .slice(0, frames.length)
        .map((t) => `${t} с`)
        .join(", ")}.`,
      images: frames,
      maxTokens: 500,
      schema: VIDEO_OPENING_SCHEMA,
      simple: true,
      preferModel: EXTRACT_MODEL,
    });

    if (!result || typeof result.firstShot !== "string") {
      void logSystemError("ai", `Первые секунды ролика: ИИ не ответил (объект ${payload.propertyId})`, {
        dedupKey: "video-opening-ai",
      });
      await save({ status: "FAILED", durationSec });
      return "failed";
    }

    const firstShot = (OPENING_SHOTS as readonly string[]).includes(result.firstShot)
      ? (result.firstShot as OpeningShot)
      : "OTHER";
    await save({
      status: "OK",
      firstShot,
      hasPerson: Boolean(result.hasPerson) || firstShot === "PERSON",
      hasText: Boolean(result.hasText) || firstShot === "TEXT",
      hookScore: clampHook(result.hookScore),
      note: oneLine(result.note, 200),
      tip: oneLine(result.tip, 200),
      durationSec,
    });
    return "ok";
  } finally {
    await fs.promises.rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}

export const videoOpeningJob: JobHandler<Payload> = {
  type: VIDEO_OPENING_JOB_TYPE,
  schema,
  // Отказ ИИ и битый файл записываются строкой FAILED внутри run() — повтор
  // через сутки ставит сам экран (lib/firstSeconds.ts). Сюда долетают только
  // сбои базы и диска.
  backoff: () => 5 * 60_000,
  async run(payload) {
    await analyzeVideoOpening(payload);
  },
  async onGiveUp(payload) {
    void logSystemError("api", `Первые секунды ролика: разбор не удался (объект ${payload.propertyId})`, {
      dedupKey: "video-opening-gave-up",
    });
  },
};
