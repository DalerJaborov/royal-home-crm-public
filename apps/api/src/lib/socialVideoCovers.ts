import fs from "node:fs";
import path from "node:path";
import sharp, { type Metadata } from "sharp";
import { propertyCoversDir, uploadsDir } from "../upload.js";
import { logSystemError } from "./systemError.js";
import { describeError } from "./describeError.js";

/**
 * ОБЛОЖКИ СВОБОДНЫХ РОЛИКОВ (12.10.2026). Любая картинка — загруженная человеком или
 * нарисованная ИИ — превращается в ДВА файла, потому что площадки хотят разное:
 *  - вертикаль 1080×1920 — Instagram (`cover_url`) и Telegram (`thumbnail`);
 *  - квадрат 1080×1080 — миниатюры Facebook и YouTube.
 * Кадрируется «умным» центром (sharp `attention`), а не слепой серединой.
 *
 * Имена `promo-<id>-<метка>-cover.jpg` не совпадают ни с одним шаблоном ночной чистки
 * диска (lib/diskCleanup.ts опознаёт только имена, начинающиеся с uuid объекта), поэтому
 * файлы чистим мы сами — при замене обложки и удалении ролика. Метка времени в имени
 * обязательна: Instagram и Telegram кэшируют адрес картинки, а замена файла под тем же
 * именем показывала бы старую обложку.
 */

export class SocialVideoCoverError extends Error {}

/** Предел размера картинки в пикселях: PNG 16000×16000 одного цвета весит десятки КБ, а в памяти — гигабайт. */
const MAX_INPUT_PIXELS = 40_000_000;
const ALLOWED_FORMATS = ["jpeg", "png", "webp"];

const COVER_PATH_RE = /^\/uploads\/covers\/promo-[0-9a-f-]{36}-[0-9a-z]+-(cover|square)\.jpg$/;

export interface CoverFiles {
  coverPath: string;
  coverSquarePath: string;
}

/** Из буфера картинки делает пару файлов обложки. Не картинка — понятная ошибка. */
export async function writeCoverFiles(videoId: string, image: Buffer): Promise<CoverFiles> {
  let meta: Metadata;
  try {
    meta = await sharp(image, { limitInputPixels: MAX_INPUT_PIXELS }).metadata();
  } catch {
    throw new SocialVideoCoverError("Не удалось прочитать картинку — загрузите JPEG, PNG или WebP (до 40 мегапикселей)");
  }
  // Тип файла определяем по СОДЕРЖИМОМУ, а не по заголовку клиента: под видом image/png можно прислать SVG, TIFF или GIF.
  if (!meta.format || !ALLOWED_FORMATS.includes(meta.format)) {
    throw new SocialVideoCoverError("Обложка — JPEG, PNG или WebP");
  }
  if (!meta.width || !meta.height) throw new SocialVideoCoverError("В файле нет изображения");
  if (meta.width < 200 || meta.height < 200) {
    throw new SocialVideoCoverError("Картинка слишком маленькая — нужна хотя бы 200×200 пикселей");
  }

  const stamp = Date.now().toString(36);
  const base = `promo-${videoId}-${stamp}`;
  const coverName = `${base}-cover.jpg`;
  const squareName = `${base}-square.jpg`;
  await fs.promises.mkdir(propertyCoversDir, { recursive: true });
  const pipeline = () => sharp(image, { limitInputPixels: MAX_INPUT_PIXELS }).rotate();
  try {
    await pipeline()
      .resize(1080, 1920, { fit: "cover", position: sharp.strategy.attention })
      .jpeg({ quality: 88, mozjpeg: true })
      .toFile(path.join(propertyCoversDir, coverName));
    await pipeline()
      .resize(1080, 1080, { fit: "cover", position: sharp.strategy.attention })
      .jpeg({ quality: 88, mozjpeg: true })
      .toFile(path.join(propertyCoversDir, squareName));
  } catch (err) {
    // Первый файл мог лечь — не оставляем полпары на диске.
    await removeCoverFiles([`/uploads/covers/${coverName}`, `/uploads/covers/${squareName}`]);
    // Подробности — в журнал, клиенту без путей сервера.
    void logSystemError("api", `Свободный ролик ${videoId}: не удалось обработать обложку — ${describeError(err)}`, { dedupKey: "social-video-cover-sharp" });
    throw new SocialVideoCoverError("Не удалось обработать картинку — попробуйте другой файл");
  }
  return { coverPath: `/uploads/covers/${coverName}`, coverSquarePath: `/uploads/covers/${squareName}` };
}

/** Удаляет файлы обложек по публичным путям. Чужие имена не трогает; отказ диска — в журнал, не в ошибку. */
export async function removeCoverFiles(paths: Array<string | null | undefined>): Promise<void> {
  for (const publicPath of paths) {
    if (!publicPath || !COVER_PATH_RE.test(publicPath)) continue;
    const diskPath = path.join(uploadsDir, publicPath.slice("/uploads/".length));
    try {
      await fs.promises.rm(diskPath, { force: true });
    } catch (err) {
      void logSystemError("api", `Свободный ролик: не удалось удалить файл обложки ${publicPath}: ${describeError(err)}`, {
        dedupKey: "social-video-cover-rm",
      });
    }
  }
}
