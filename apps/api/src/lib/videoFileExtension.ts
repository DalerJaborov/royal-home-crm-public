import path from "node:path";

/**
 * РАСШИРЕНИЯ ВИДЕО, КОТОРЫЕ ПРИНИМАЕМ — ОДИН СПИСОК НА ВСЕ ВХОДЫ.
 *
 * Жил в routes/properties/videos.ts (находка №189: карточка объекта брала
 * расширение из имени файла как есть). Глубокая проверка 02.10.2026 (D15)
 * нашла тот же механизм у черновика мастера и у копирования роликов продавца
 * из переписки: файл «.html»/«.svg» ложился в хранилище с этим расширением и
 * переезжал в карточку объекта. Теперь все трое берут расширение отсюда.
 */
export const ALLOWED_VIDEO_EXTENSIONS = [
  ".mp4",
  ".mov",
  ".m4v",
  ".webm",
  ".avi",
  ".mkv",
  ".3gp",
  ".mts",
  ".m2ts",
  ".mpg",
  ".mpeg",
  ".wmv",
] as const;

/** Расширение файла для ключа хранения: белый список или null, если тип не
 *  поддерживается. Нет расширения вовсе — «.mp4», как и раньше. */
export function videoExtensionOf(filename: string): string | null {
  const ext = path.extname(filename).toLowerCase();
  if (!ext) return ".mp4";
  return (ALLOWED_VIDEO_EXTENSIONS as readonly string[]).includes(ext) ? ext : null;
}

export const UNSUPPORTED_VIDEO_MESSAGE = "Этот тип видеофайла не поддерживается. Подойдут MP4, MOV, M4V или WebM.";

/**
 * Файл-документ — это видео? Один ответ для всех входов Telegram (Шабнам: мастер
 * объекта, ролик сотрудника, общий ответ): раньше каждый держал свой список
 * расширений (4, 5 и 6 из 12), и «.3gp» с Android проходил в одном месте и
 * молча терялся в другом (26.11.2026).
 */
export function isVideoDocument(doc: { mime_type?: string; file_name?: string } | null | undefined): boolean {
  if (!doc) return false;
  if (doc.mime_type?.startsWith("video/")) return true;
  const ext = path.extname(doc.file_name ?? "").toLowerCase();
  return Boolean(ext) && (ALLOWED_VIDEO_EXTENSIONS as readonly string[]).includes(ext);
}

/** Размер для сообщения сотруднику: «41,8 МБ» (до 10 МБ — с десятой, дальше — целые). */
export function formatVideoSizeMb(bytes: number | null | undefined): string | null {
  if (!bytes || bytes <= 0) return null;
  const mb = bytes / (1024 * 1024);
  const text = mb < 10 ? mb.toFixed(1).replace(".", ",") : String(Math.round(mb));
  return `${text === "0,0" ? "0,1" : text} МБ`;
}
