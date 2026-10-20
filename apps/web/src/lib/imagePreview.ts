/**
 * Лёгкое превью плитки фото в мастере — ~320px по длинной стороне, а НЕ
 * полноразмерный objectURL исходника.
 *
 * ПОЧЕМУ ЭТО ВАЖНО (сборщик нашёл 21.09.2026 как причину жалобы «агент
 * добавил 15-20 фото — сервер сбросился, всё потерялось»). Раньше плитка
 * показывала `URL.createObjectURL(file)` напрямую: браузер декодирует
 * КАЖДЫЙ такой <img> в полный размер и держит decoded-буфер, пока плитка на
 * экране. 20 снимков по 12 Мп с телефона — это сотни МБ декодированных
 * пикселей разом, вкладка падает или подвисает насмерть; сервер тут вообще
 * ни при чём.
 *
 * Один декод на файл (не два): чтобы узнать пропорции без второго прохода,
 * decode делает `createImageBitmap(file)` БЕЗ resize-опций, а сам ресайз —
 * рисованием на маленький canvas нужного размера; исходный bitmap закрывается
 * сразу после отрисовки и не держит память. Итоговый blob — сам превью,
 * несравнимо меньше исходника.
 */

const PREVIEW_MAX_DIMENSION = 320;
const PREVIEW_QUALITY = 0.62;

/**
 * Считает превью асинхронно. `null` — превью не вышло (битый/экзотический
 * формат, HEIC без декодера в этом браузере, приватный режим и т.п.) —
 * вызывающая сторона в этом случае оставляет плитке иконку-заглушку, а НЕ
 * полноразмерный файл: показывать сотни МБ decoded-пикселей нельзя ни в
 * одном исходе.
 */
export async function createLightPreview(file: File): Promise<string | null> {
  let bitmap: ImageBitmap | null = null;
  try {
    bitmap = await createImageBitmap(file);
    const scale = Math.min(1, PREVIEW_MAX_DIMENSION / Math.max(bitmap.width, bitmap.height));
    const width = Math.max(1, Math.round(bitmap.width * scale));
    const height = Math.max(1, Math.round(bitmap.height * scale));

    const canvas: HTMLCanvasElement | OffscreenCanvas =
      typeof OffscreenCanvas !== "undefined" ? new OffscreenCanvas(width, height) : document.createElement("canvas");
    if (!(canvas instanceof OffscreenCanvas)) {
      canvas.width = width;
      canvas.height = height;
    }
    const ctx = canvas.getContext("2d") as CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D | null;
    if (!ctx) return null;
    ctx.drawImage(bitmap, 0, 0, width, height);

    const blob =
      canvas instanceof OffscreenCanvas
        ? await canvas.convertToBlob({ type: "image/jpeg", quality: PREVIEW_QUALITY })
        : await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, "image/jpeg", PREVIEW_QUALITY));
    if (!blob) return null;
    return URL.createObjectURL(blob);
  } catch {
    return null;
  } finally {
    bitmap?.close();
  }
}
