/**
 * КАЧЕСТВО СНИМКА ОБЪЕКТА — одна проверка для мастера объекта (Telegram, 10.11.2026).
 *
 * Зачем: агенты шлют фото «как фото», Telegram сжимает их до 1280 px, и на сайт
 * уходит мыло. Плюс тёмные, пересвеченные и смазанные снимки, которые видно
 * только на большом экране. Здесь — дешёвая оценка без ИИ, на уменьшенной копии:
 *
 *   compressed — Telegram отдал снимок меньше 1600 px по длинной стороне
 *                (обычное «фото», не файл). От 2560 px — «HD», принимаем молча;
 *   dark       — средняя яркость ниже DARK_MEAN;
 *   bright     — пересвет: светлая картинка, где заметная доля точек «белая»;
 *   blurry     — мало резких переходов: дисперсия лапласиана ниже BLUR_VARIANCE.
 *
 * Пороги — ОЦЕНКА на синтетике (tests/photo-quality.test.ts), а не замер на живых
 * снимках агентов; это пометка «⚠️» в карточке, а не отказ, поэтому ошибка порога
 * стоит агенту одного взгляда, а не потерянного фото. Повёрнутое по EXIF фото
 * отдельно не помечаем: сохранение (routes/properties/drafts.ts) само поворачивает
 * его по метке ориентации (`sharp().rotate()`).
 */
import { sharpFromUpload } from "./heicInput.js";

export type PhotoQualityFlag = "compressed" | "dark" | "bright" | "blurry";
export const PHOTO_QUALITY_FLAGS: readonly PhotoQualityFlag[] = ["compressed", "dark", "bright", "blurry"];

/** Меньше этого по длинной стороне — Telegram сжал снимок. */
export const TELEGRAM_COMPRESSED_MAX_SIDE = 1600;
const DARK_MEAN = 55;
/** Пересвет: очень светлый снимок — или светлый с заметной долей «выбитых» в белое точек. */
const BRIGHT_MEAN = 220;
const BRIGHT_MEAN_WITH_CLIPPING = 195;
const BRIGHT_CLIPPED_SHARE = 0.25;
const BLUR_VARIANCE = 20;
const SAMPLE_SIDE = 512;

/** Сжал ли Telegram снимок: по самому крупному размеру из `photo[]`. Без размеров — не знаем, не беспокоим. */
export function isTelegramCompressed(sizes: readonly { width?: number; height?: number }[] | undefined): boolean {
  if (!sizes?.length) return false;
  const largest = Math.max(...sizes.map(size => Math.max(size.width ?? 0, size.height ?? 0)));
  return largest > 0 && largest < TELEGRAM_COMPRESSED_MAX_SIDE;
}

/** Тёмное / пересвеченное / смазанное — по уменьшенной серой копии. */
export async function assessPhotoQuality(buffer: Buffer): Promise<PhotoQualityFlag[]> {
  const { data, info } = await (await sharpFromUpload(buffer))
    .rotate()
    .resize(SAMPLE_SIDE, SAMPLE_SIDE, { fit: "inside", withoutEnlargement: true })
    .greyscale()
    .raw()
    .toBuffer({ resolveWithObject: true });
  const { width, height } = info;
  const step = info.channels;
  let sum = 0;
  let clipped = 0;
  for (let i = 0; i < data.length; i += step) {
    sum += data[i];
    if (data[i] >= 250) clipped += 1;
  }
  const pixels = data.length / step;
  const mean = sum / pixels;
  const flags: PhotoQualityFlag[] = [];
  if (mean < DARK_MEAN) flags.push("dark");
  else if (mean > BRIGHT_MEAN || (mean > BRIGHT_MEAN_WITH_CLIPPING && clipped / pixels > BRIGHT_CLIPPED_SHARE)) flags.push("bright");

  // Дисперсия лапласиана (4-соседей): резкий снимок даёт много сильных перепадов.
  // У тёмного снимка перепадов мало и без смаза — «размытое» к нему не добавляем.
  if (width >= 3 && height >= 3 && !flags.includes("dark")) {
    let lapSum = 0;
    let lapSq = 0;
    let n = 0;
    for (let y = 1; y < height - 1; y++) {
      for (let x = 1; x < width - 1; x++) {
        const at = (yy: number, xx: number) => data[(yy * width + xx) * step];
        const v = at(y - 1, x) + at(y + 1, x) + at(y, x - 1) + at(y, x + 1) - 4 * at(y, x);
        lapSum += v;
        lapSq += v * v;
        n += 1;
      }
    }
    const variance = lapSq / n - (lapSum / n) ** 2;
    if (variance < BLUR_VARIANCE) flags.push("blurry");
  }
  return flags;
}
