/**
 * ДЛИТЕЛЬНОСТЬ РОЛИКА ДО ОТПРАВКИ (25.11.2026, находка 11).
 *
 * Короткий ролик карточки сервер принимает до 5 минут, но узнавали мы об этом только после
 * того, как сотни мегабайт уже ушли по мобильному интернету. Браузер читает длительность из
 * заголовка файла за доли секунды (<video preload="metadata">), не загружая ролик целиком.
 *
 * `null` — не удалось узнать (формат, которого браузер не понимает, или нет DOM): тогда
 * не мешаем отправке, последнее слово за сервером.
 */
export function readVideoDurationSec(file: Blob, timeoutMs = 8_000): Promise<number | null> {
  if (typeof document === "undefined" || typeof URL === "undefined" || typeof URL.createObjectURL !== "function") {
    return Promise.resolve(null);
  }
  return new Promise((resolve) => {
    const video = document.createElement("video");
    const url = URL.createObjectURL(file);
    let done = false;
    const finish = (value: number | null) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      video.removeAttribute("src");
      try {
        video.load();
      } catch {
        /* ничего: элемент и так уйдёт сборщику мусора */
      }
      URL.revokeObjectURL(url);
      resolve(value);
    };
    const timer = setTimeout(() => finish(null), timeoutMs);
    video.preload = "metadata";
    video.muted = true;
    video.onloadedmetadata = () => finish(Number.isFinite(video.duration) && video.duration > 0 ? video.duration : null);
    video.onerror = () => finish(null);
    video.src = url;
  });
}

/**
 * Предел длительности короткого ролика — то же число, что у сервера
 * (apps/api/src/lib/propertyClipVideo.ts::MAX_CLIP_VIDEO_DURATION_SEC). Совпадение
 * сторожит тест lib/__tests__/uploadClientResilience.test.ts: число на экране и на
 * сервере не разойдутся молча.
 */
export const CLIP_VIDEO_MAX_DURATION_SEC = 300;

/** Проверка ролика карточки до отправки: текст отказа или null. Чистая, кроме чтения длительности. */
export async function checkClipVideoBeforeUpload(
  file: Blob,
  maxBytes: number,
  readDuration: (f: Blob) => Promise<number | null> = readVideoDurationSec
): Promise<string | null> {
  if (file.type && !file.type.startsWith("video/")) return "Это не видео. Выберите ролик.";
  if (file.size > maxBytes) {
    return `Ролик слишком большой: ${Math.round(file.size / 1024 / 1024)} МБ, можно до ${Math.round(maxBytes / 1024 / 1024)} МБ. Обрежьте его в галерее и выберите снова.`;
  }
  const sec = await readDuration(file);
  if (sec != null && sec > CLIP_VIDEO_MAX_DURATION_SEC) {
    const min = Math.floor(sec / 60);
    const rest = Math.round(sec % 60);
    return `Ролик длиной ${min} мин ${rest} с, а можно до ${CLIP_VIDEO_MAX_DURATION_SEC / 60} минут. Обрежьте его в галерее и выберите снова.`;
  }
  return null;
}
