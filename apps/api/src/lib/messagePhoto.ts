import fs from "node:fs";
import path from "node:path";
import sharp from "sharp";
import { uploadsDir } from "../upload.js";

/**
 * Копия фотографии объекта в том виде, в каком её примет мессенджер.
 *
 * CRM хранит снимки в WebP (routes/properties.ts: sharp(...).webp()) — это правильно
 * для сайта и карточки объекта, но отправить такой файл в WhatsApp нельзя: сообщение
 * типа `image` принимает только image/jpeg и image/png, а WebP там считается стикером.
 * Отправка молча заканчивалась бы отказом Meta на каждой фотографии — то есть бот
 * никогда бы ничего не показал, а причина лежала бы в журнале одной строкой про
 * «Unsupported media type».
 *
 * Поэтому рядом с оригиналом заводится JPEG-двойник: та же папка `uploads` (значит, он
 * так же публично доступен по ссылке, и Meta заберёт его сама), подпапка `msg`.
 * Делается это ОДИН раз на фотографию: файл остаётся на диске и переиспользуется всеми
 * следующими показами этого объекта.
 *
 * Заодно снимок ужимается до 1600px по длинной стороне: оригинал с телефона бывает и
 * 12 мегапикселей, а у WhatsApp предел 5 МБ на изображение — большие файлы Meta просто
 * отказалась бы забирать.
 */

const messagePhotosDir = path.join(uploadsDir, "msg");

/** Длинная сторона отправляемого снимка: в чате его смотрят с телефона, больше незачем. */
const MAX_SIDE_PX = 1600;

/** Где лежит двойник этой фотографии — единственное место, где считается его имя.
 *
 *  null означает «двойника не бывает»: либо путь не похож на имя файла, либо оригинал
 *  и так JPEG и отправляется как есть. Общая функция для создания и для удаления
 *  нужна именно поэтому: разойдись эти два расчёта — и удаление либо промахнулось бы
 *  мимо файла (утечка), либо стёрло бы чужой (потеря снимка). */
function messagePhotoTwin(originalUploadPath: string): { target: string; publicPath: string } | null {
  // Путь приходит из базы, но имя файла всё равно берём только через basename:
  // склейка uploadsDir с чужой строкой — прямой путь к чтению и записи вне папки.
  const name = path.basename(originalUploadPath);
  if (!name || name.startsWith(".")) return null;

  const ext = path.extname(name).toLowerCase();
  if (ext === ".jpg" || ext === ".jpeg") return null;

  const targetName = `${path.basename(name, ext)}.jpg`;
  return { target: path.join(messagePhotosDir, targetName), publicPath: `/uploads/msg/${targetName}` };
}

/**
 * Путь внутри `/uploads` к JPEG-версии фотографии; null — исходного файла нет или его
 * не удалось перекодировать.
 *
 * Возвращает именно путь, а не абсолютный адрес: превращение его в публичную ссылку —
 * дело lib/crmPublicUrl.ts, и второй копии этой сборки быть не должно.
 */
export async function messagePhotoPath(originalUploadPath: string): Promise<string | null> {
  const name = path.basename(originalUploadPath);
  if (!name || name.startsWith(".")) return null;

  const source = path.join(uploadsDir, name);
  if (!fs.existsSync(source)) return null;

  // Уже JPEG — перекодировать нечего, отдаём как есть.
  const twin = messagePhotoTwin(originalUploadPath);
  if (!twin) return `/uploads/${name}`;

  const { target, publicPath } = twin;
  if (fs.existsSync(target)) return publicPath;

  try {
    fs.mkdirSync(messagePhotosDir, { recursive: true });
    await sharp(source)
      .rotate() // по EXIF: иначе снимок с телефона уходит клиенту лежащим на боку
      .resize(MAX_SIDE_PX, MAX_SIDE_PX, { fit: "inside", withoutEnlargement: true })
      .jpeg({ quality: 82 })
      .toFile(target);
    return publicPath;
  } catch {
    // Причину запишет вызывающий: у него есть номер объекта, и без него запись в
    // журнале не подсказала бы, где смотреть.
    return null;
  }
}

/**
 * Убирает JPEG-двойник вместе с самой фотографией объекта.
 *
 * Двойник — производная от оригинала, и жить дольше него он не должен: удаление фото
 * в карточке стирало оригинал и миниатюру, а копия в `uploads/msg` оставалась на
 * диске навсегда. Каждая — до сотен килобайт, и растёт эта куча ровно так же быстро,
 * как агенты правят фотографии объектов.
 *
 * Удаляется СТРОГО один рассчитанный файл в `uploads/msg` (см. messagePhotoTwin) —
 * никакого обхода папки и никаких масок: удаление необратимо, а в той же папке лежат
 * двойники всех остальных объектов. Отсутствие файла ошибкой не считается: двойник
 * заводится лениво, при первой отправке, и у большинства фотографий его просто нет.
 */
export async function removeMessagePhoto(originalUploadPath: string): Promise<void> {
  const twin = messagePhotoTwin(originalUploadPath);
  // Оригинал сам JPEG — отдельного двойника не было, а удалять сам оригинал здесь
  // нельзя: это дело вызывающего, и он это уже сделал.
  if (!twin) return;
  await fs.promises.rm(twin.target, { force: true });
}
