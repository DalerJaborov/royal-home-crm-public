/**
 * Сжатие фото на клиенте перед загрузкой: перекодирует в JPEG (максимум 2560px
 * по длинной стороне). Решает сразу три проблемы мобильной загрузки:
 *  - HEIC с iPhone, который серверный sharp не декодирует (Safari сам умеет
 *    отрисовать HEIC на canvas → уходит уже JPEG);
 *  - 20-мегабайтные оригиналы с камер — медленная загрузка и лимиты сервера;
 *  - EXIF-поворот (canvas рисует уже повернутым).
 * Если файл не декодируется (не картинка/битый) — возвращаем оригинал, сервер
 * ответит внятной ошибкой по одному файлу, а не завалит весь запрос.
 */
const MAX_DIMENSION = 2560;
const JPEG_QUALITY = 0.85;
/** Мелкие JPEG/WebP не трогаем — пережатие только потеряло бы качество. */
const SKIP_BELOW_BYTES = 1.5 * 1024 * 1024;

export async function compressImage(file: File): Promise<File> {
  const alreadyCompact =
    file.size < SKIP_BELOW_BYTES && (file.type === "image/jpeg" || file.type === "image/webp");
  if (alreadyCompact) return file;

  try {
    const bitmap = await createImageBitmap(file);
    const scale = Math.min(1, MAX_DIMENSION / Math.max(bitmap.width, bitmap.height));
    const width = Math.round(bitmap.width * scale);
    const height = Math.round(bitmap.height * scale);

    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext("2d");
    if (!ctx) return file;
    ctx.drawImage(bitmap, 0, 0, width, height);
    bitmap.close();

    const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, "image/jpeg", JPEG_QUALITY));
    if (!blob) return file;
    // Если вдруг вышло крупнее оригинала (уже сжатый файл) — оставляем оригинал.
    if (blob.size >= file.size && file.type.startsWith("image/") && file.type !== "image/heic" && file.type !== "image/heif") {
      return file;
    }
    const name = file.name.replace(/\.\w+$/, "") + ".jpg";
    return new File([blob], name, { type: "image/jpeg" });
  } catch {
    return file;
  }
}
