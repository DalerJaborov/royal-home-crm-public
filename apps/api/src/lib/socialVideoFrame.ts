import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import sharp from "sharp";
import { probeMediaInfo, tryRunFfmpeg } from "./ffmpeg.js";

/**
 * КАДР ИЗ РОЛИКА КАК ОСНОВА ОБЛОЖКИ (12.10.2026).
 *
 * Обложка, нарисованная «из воздуха», не похожа на сам ролик: в нём человек, офис, конкретный
 * интерьер, а ИИ рисует абстрактную квартиру. Поэтому берём настоящий кадр и отдаём его ИИ как
 * картинку-основу (socialVideoAi.ts). Кадр берётся не первый: начало ролика чаще всего чёрное
 * или с плавным появлением, а середина — размытая от движения. Снимаем три места и выбираем
 * самое «живое».
 *
 * Любая беда (нет ffmpeg, битый файл, чёрный ролик) — null: обложку можно нарисовать и без кадра,
 * поэтому функция не бросает.
 */

/** Доли длительности, где пробуем снять кадр. */
const SAMPLE_FRACTIONS = [0.15, 0.35, 0.55] as const;
/** Не раньше этой секунды: самое начало ролика — затемнение или заставка. */
const MIN_SAMPLE_SEC = 0.5;
/** Длинная сторона готового кадра, px. Больше ИИ-модели не нужно, а запрос тяжелеет. */
const MAX_SIDE_PX = 1280;
const FRAME_TIMEOUT_MS = 20_000;
/** Если длительность узнать не удалось, пробуем эти секунды. */
const UNKNOWN_DURATION_SAMPLES_SEC = [0.5, 1.5, 3] as const;

/** Секунды, где снимаем кадры: по долям длительности, без повторов и строго внутри ролика. */
export function frameSampleTimes(durationSec: number | null): number[] {
  if (durationSec == null || !(durationSec > 0)) return [...UNKNOWN_DURATION_SAMPLES_SEC];
  // Последняя десятая секунды — конец файла, ffmpeg там может не отдать кадр.
  const last = Math.max(0, durationSec - 0.1);
  const times = SAMPLE_FRACTIONS.map((fraction) => Math.min(last, Math.max(MIN_SAMPLE_SEC, durationSec * fraction)));
  return [...new Set(times.map((t) => Math.round(t * 100) / 100))];
}

/**
 * Оценка «живости» кадра: чем выше, тем лучше. Чёрный (средняя яркость около нуля) и выбеленный
 * кадр обнуляются; из остальных выигрывает резкий и контрастный — резкость меряется разбросом
 * значений после лапласиана (на размытом кадре краёв нет, и разброс мал).
 */
export async function scoreFrame(jpeg: Buffer): Promise<number> {
  const base = sharp(jpeg).greyscale();
  const plain = await base.clone().stats();
  const mean = plain.channels[0]?.mean ?? 0;
  const contrast = plain.channels[0]?.stdev ?? 0;
  // Почти чёрный или почти белый кадр не годится, как бы он ни был «контрастен» из-за шума.
  if (mean < 20 || mean > 240) return 0;
  const edges = await base
    .clone()
    .convolve({ width: 3, height: 3, kernel: [0, 1, 0, 1, -4, 1, 0, 1, 0], scale: 1, offset: 128 })
    .stats();
  const sharpness = edges.channels[0]?.stdev ?? 0;
  // Яркость около середины лучше крайностей: множитель от 0 (край шкалы) до 1 (середина).
  const exposure = 1 - Math.abs(mean - 128) / 128;
  return (sharpness + 0.25 * contrast) * Math.max(0.1, exposure);
}

/**
 * Достаёт из ролика один удачный кадр. `diskPath` — локальный путь к файлу ролика.
 * Возвращает JPEG не длиннее 1280 px по длинной стороне, либо null, если кадра получить нельзя.
 */
export async function extractVideoFrameJpeg(diskPath: string): Promise<Buffer | null> {
  let dir: string | null = null;
  try {
    const info = await probeMediaInfo(diskPath);
    // ffprobe не смог прочитать файл или в нём нет видеодорожки (звук, битый файл) — кадров нет.
    if (info && !info.hasVideo) return null;
    dir = await mkdtemp(path.join(tmpdir(), "rh-social-frame-"));

    let best: { buffer: Buffer; score: number } | null = null;
    for (const [index, second] of frameSampleTimes(info?.durationSec ?? null).entries()) {
      const out = path.join(dir, `frame-${index}.jpg`);
      const ran = await tryRunFfmpeg({
        label: "кадр для обложки",
        timeoutMs: FRAME_TIMEOUT_MS,
        args: [
          "-v", "error",
          "-ss", second.toFixed(2),
          "-i", diskPath,
          "-frames:v", "1",
          // Ужимаем до 1280 по длинной стороне, но не растягиваем маленькое видео. Кавычки читает сам ffmpeg.
          "-vf", `scale='min(${MAX_SIDE_PX},iw)':'min(${MAX_SIDE_PX},ih)':force_original_aspect_ratio=decrease`,
          "-q:v", "2",
          "-y", out,
        ],
      });
      if (!ran) continue;
      try {
        const buffer = await readFile(out);
        if (buffer.length === 0) continue;
        const score = await scoreFrame(buffer);
        if (!best || score > best.score) best = { buffer, score };
      } catch {
        // Один не прочитавшийся кадр не отменяет остальные.
      }
    }
    // Все кадры чёрные/белые: такая основа хуже, чем её отсутствие.
    if (!best || best.score <= 0) return null;
    return await sharp(best.buffer)
      .resize({ width: MAX_SIDE_PX, height: MAX_SIDE_PX, fit: "inside", withoutEnlargement: true })
      .jpeg({ quality: 88 })
      .toBuffer();
  } catch {
    return null;
  } finally {
    if (dir) await rm(dir, { recursive: true, force: true }).catch(() => undefined);
  }
}
