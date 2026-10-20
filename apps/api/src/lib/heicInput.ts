import sharp, { type Sharp } from "sharp";
import decodeHeic from "heic-decode";

/**
 * ФОТО С IPHONE В HEIC (21.09.2026, живой случай владельца: объект №120,
 * шесть снимков IMG_86xx.HEIC — «Допустимы только изображения»).
 *
 * Почему не хватало sharp: сборка libvips внутри sharp умеет из семейства HEIF
 * только AVIF (кодек aom), декодера HEVC в ней нет из-за патентов — HEIC ей не
 * прочитать ни на сервере, ни где-либо ещё. Браузер тоже не спасал: Chrome на
 * Windows не декодирует HEIC, поэтому сжатие на клиенте (compressImage) молча
 * отдавало исходник, а у такого файла Chrome ещё и пустой MIME-тип — multer
 * отвергал его на входе как «не изображение».
 *
 * Здесь HEIC раскладывается в пиксели libheif, собранной в WebAssembly
 * (heic-decode → libheif-js): без системных библиотек и без изменений образа.
 * Дальше это обычный sharp по сырым RGBA — тот же конвейер webp/миниатюры, что
 * у JPEG. Ориентацию libheif применяет при декодировании сама (irot/imir), так
 * что `.rotate()` после нас ничего не ломает. EXIF (в том числе GPS) при этом
 * не переносится — точку для такого снимка берут из карты или адреса.
 */

/** Главные бренды HEIC-контейнера (ISO/IEC 23008-12). `mif1`/`msf1` — общие
 *  бренды HEIF: ими подписан и AVIF, поэтому для них смотрим совместимые. */
const HEIC_BRANDS = new Set(["heic", "heix", "hevc", "hevx", "heim", "heis", "hevm", "hevs"]);

export function isHeic(buf: Buffer): boolean {
  if (buf.length < 16 || buf.toString("latin1", 4, 8) !== "ftyp") return false;
  const major = buf.toString("latin1", 8, 12);
  if (HEIC_BRANDS.has(major)) return true;
  if (major !== "mif1" && major !== "msf1") return false;
  // Совместимые бренды идут после minor_version до конца бокса ftyp.
  const boxSize = Math.min(buf.readUInt32BE(0), buf.length);
  for (let off = 16; off + 4 <= boxSize; off += 4) {
    if (HEIC_BRANDS.has(buf.toString("latin1", off, off + 4))) return true;
  }
  return false;
}

/** Имя файла похоже на снимок iPhone — для входного фильтра, где у HEIC из
 *  Chrome на Windows MIME-тип пустой или `application/octet-stream`. */
export function looksLikeHeicName(name: string): boolean {
  return /\.(heic|heif)$/i.test(name);
}

/**
 * Вход для конвейера sharp: HEIC — через декодер, всё остальное — как было.
 * Бросает исключение, если HEIC битый: вызывающий код уже отвечает на отказ
 * sharp понятной ошибкой и журналом, это тот же путь.
 */
export async function sharpFromUpload(buf: Buffer): Promise<Sharp> {
  if (!isHeic(buf)) return sharp(buf, { sequentialRead: true });
  // РАЗМЕР — ДО РАСШИФРОВКИ (аудит 23.09.2026, круг 3, №75). Декодер сразу
  // заводит массив ширина × высота × 4 байта: заголовок файла в пару
  // килобайт с размером 20000 × 20000 просил бы 1,6 ГБ разом, и процесс API
  // (768 МБ) падал раньше, чем доходило до ошибки. Размеры читаются из
  // заголовка без расшифровки пикселей.
  const images = await decodeHeic.all({ buffer: buf });
  try {
    const first = images[0];
    if (!first) throw new Error("HEIC без изображения");
    if (first.width * first.height > MAX_HEIC_PIXELS) {
      throw new Error(`Снимок HEIC слишком большой: ${first.width}×${first.height}`);
    }
    const { width, height, data } = await first.decode();
    return sharp(Buffer.from(data.buffer, data.byteOffset, data.byteLength), {
      raw: { width, height, channels: 4 },
    });
  } finally {
    images.dispose();
  }
}

/** Потолок пикселей HEIC: 48-мегапиксельный снимок iPhone Pro (8064 × 6048)
 *  проходит, всё крупнее — нет. Это ≈ 200 МБ несжатых пикселей. */
export const MAX_HEIC_PIXELS = 50_000_000;
